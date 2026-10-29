"""Контроль бюджета платных API.

Порядок для каждой платной операции:
1. оценка стоимости до вызова;
2. резерв в отдельной транзакции под advisory-блокировкой: параллельные задачи не превысят лимит вместе;
3. вызов поставщика;
4. фиксация фактической стоимости или снятие резерва при ошибке.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.content.channel import get_channel
from app.database.enums import UsageStatus, VideoJobKind, VideoJobStatus
from app.database.models import ProviderUsage, VideoJob
from app.database.session import session_scope, utcnow
from app.monitoring.alerts import notify_owner
from app.monitoring.metrics import PROVIDER_COST
from app.settings.channel import BudgetSettings

BUDGET_LOCK_KEY = 0x0B0D6E7  # общий ключ advisory-блокировки для резервов


class BudgetExceeded(Exception):  # noqa: N818
    def __init__(
        self,
        reason: str,
        *,
        period: str | None = None,
        spent: Decimal | None = None,
        limit: Decimal | None = None,
    ):
        super().__init__(reason)
        self.reason = reason
        self.period = period
        self.spent = spent
        self.limit = limit


@dataclass(slots=True)
class Spend:
    day_usd: Decimal
    month_usd: Decimal
    video_generations_month: int


@dataclass(slots=True)
class PaidCall:
    usage_id: uuid.UUID
    estimated: Decimal
    actual: Decimal | None = None
    cost_source: str = "estimate"
    units: dict[str, Any] = field(default_factory=dict)
    request_id: str | None = None

    def set_actual(
        self,
        amount: Decimal,
        *,
        source: str,
        units: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> None:
        self.actual = amount
        self.cost_source = source
        if units:
            self.units.update(units)
        self.request_id = request_id


def period_bounds(now: datetime, tz_name: str) -> tuple[datetime, datetime]:
    tz = ZoneInfo(tz_name)
    local = now.astimezone(tz)
    day_start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)
    return day_start, month_start


_SPENT = """
SELECT coalesce(sum(CASE WHEN status = 'committed' THEN coalesce(actual_cost_usd, estimated_cost_usd)
                         WHEN status = 'reserved' THEN estimated_cost_usd ELSE 0 END), 0)
FROM provider_usage WHERE created_at >= :since
"""


async def current_spend(session: AsyncSession, tz_name: str, now: datetime | None = None) -> Spend:
    now = now or utcnow()
    day_start, month_start = period_bounds(now, tz_name)
    day = (await session.execute(text(_SPENT), {"since": day_start})).scalar_one()
    month = (await session.execute(text(_SPENT), {"since": month_start})).scalar_one()
    videos = (
        await session.execute(
            select(func.count())
            .select_from(VideoJob)
            .where(
                VideoJob.kind == VideoJobKind.ai_scene,
                VideoJob.created_at >= month_start,
                VideoJob.provider_job_id.is_not(None),
                VideoJob.status != VideoJobStatus.cancelled,
            )
        )
    ).scalar_one()
    return Spend(day_usd=Decimal(day), month_usd=Decimal(month), video_generations_month=int(videos))


async def reserve(
    session: AsyncSession,
    *,
    provider: str,
    operation: str,
    estimated_usd: Decimal,
    model: str | None = None,
    item_id: uuid.UUID | None = None,
    is_video_generation: bool = False,
    units: dict[str, Any] | None = None,
) -> ProviderUsage:
    channel = await get_channel(session)
    budget: BudgetSettings = channel.settings.budget
    tz = channel.settings.schedule.timezone
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": BUDGET_LOCK_KEY})

    if estimated_usd > budget.max_task_cost_usd:
        raise BudgetExceeded(
            f"оценка операции ${estimated_usd} выше лимита на задачу ${budget.max_task_cost_usd}"
        )
    spend = await current_spend(session, tz)
    if budget.hard_stop and spend.day_usd + estimated_usd > budget.daily_limit_usd:
        raise BudgetExceeded(
            f"дневной лимит ${budget.daily_limit_usd} будет превышен (потрачено ${spend.day_usd:.2f})",
            period="day",
            spent=spend.day_usd,
            limit=budget.daily_limit_usd,
        )
    if budget.hard_stop and spend.month_usd + estimated_usd > budget.monthly_limit_usd:
        raise BudgetExceeded(
            f"месячный лимит ${budget.monthly_limit_usd} будет превышен (потрачено ${spend.month_usd:.2f})",
            period="month",
            spent=spend.month_usd,
            limit=budget.monthly_limit_usd,
        )
    if is_video_generation and spend.video_generations_month >= budget.video_generations_per_month:
        raise BudgetExceeded(
            f"достигнут лимит генераций видео в месяц ({budget.video_generations_per_month})",
            period="video",
            spent=Decimal(spend.video_generations_month),
            limit=Decimal(budget.video_generations_per_month),
        )

    usage = ProviderUsage(
        provider=provider,
        operation=operation,
        model=model,
        status=UsageStatus.reserved,
        estimated_cost_usd=estimated_usd,
        item_id=item_id,
        units=units or {},
    )
    session.add(usage)
    await session.flush()
    await _warn_thresholds(session, budget, spend, estimated_usd)
    return usage


async def notify_budget_stop(session: AsyncSession, exc: BudgetExceeded) -> None:
    """Уведомление об остановке платных задач. Вызывается в новой транзакции: резерв к этому моменту откатан."""
    if exc.period is None or exc.spent is None or exc.limit is None:
        await notify_owner(
            session,
            key=f"budget-stop:task:{utcnow():%Y-%m-%d}:{exc.reason[:60]}",
            kind="budget",
            text=f"⛔ Платная операция не запущена: {exc.reason}",
        )
        return
    period, spent, limit = exc.period, exc.spent, exc.limit
    label = {"day": "дневной", "month": "месячный", "video": "месячный лимит генераций видео —"}[period]
    stamp = utcnow().strftime("%Y-%m-%d" if period == "day" else "%Y-%m")
    await notify_owner(
        session,
        key=f"budget-stop:{period}:{stamp}",
        kind="budget",
        text=f"⛔ Платные задачи остановлены: {label} лимит исчерпан ({spent:.2f} из {limit}). "
        "Задачи ждут нового периода или повышения лимита в настройках бюджета.",
    )


async def _warn_thresholds(
    session: AsyncSession, budget: BudgetSettings, spend: Spend, added: Decimal
) -> None:
    now = utcnow()
    for period, spent, limit in (
        ("day", spend.day_usd + added, budget.daily_limit_usd),
        ("month", spend.month_usd + added, budget.monthly_limit_usd),
    ):
        if limit <= 0:
            continue
        ratio = float(spent / limit)
        for threshold in budget.warn_thresholds:
            if ratio >= threshold:
                stamp = now.strftime("%Y-%m-%d" if period == "day" else "%Y-%m")
                await notify_owner(
                    session,
                    key=f"budget-warn:{period}:{stamp}:{threshold}",
                    kind="budget",
                    text=f"⚠️ Расходы достигли {int(threshold * 100)}% {'дневного' if period == 'day' else 'месячного'} "
                    f"лимита: ${spent:.2f} из ${limit}.",
                )


async def commit_usage(
    session: AsyncSession,
    usage_id: uuid.UUID,
    actual_usd: Decimal,
    *,
    cost_source: str,
    units: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> None:
    usage = await session.get(ProviderUsage, usage_id, with_for_update=True)
    if usage is None or usage.status != UsageStatus.reserved:
        return
    usage.status = UsageStatus.committed
    usage.actual_cost_usd = actual_usd
    usage.cost_source = cost_source
    usage.units = {**(usage.units or {}), **(units or {})}
    usage.request_id = request_id
    usage.finalized_at = utcnow()
    PROVIDER_COST.labels(usage.provider).inc(float(actual_usd))


async def release_usage(session: AsyncSession, usage_id: uuid.UUID, error: str | None = None) -> None:
    usage = await session.get(ProviderUsage, usage_id, with_for_update=True)
    if usage is None or usage.status != UsageStatus.reserved:
        return
    usage.status = UsageStatus.released
    usage.error = (error or "")[:2000] or None
    usage.finalized_at = utcnow()


@asynccontextmanager
async def paid_call(
    *,
    provider: str,
    operation: str,
    estimated_usd: Decimal,
    model: str | None = None,
    item_id: uuid.UUID | None = None,
    is_video_generation: bool = False,
    units: dict[str, Any] | None = None,
    charge_on_error: bool = False,
) -> AsyncIterator[PaidCall]:
    """Резерв → вызов → фиксация. Если вызывающий не указал факт, фиксируется оценка.

    charge_on_error=True — при ошибке резерв остаётся списанным по оценке (когда поставщик мог выставить счёт).
    """
    try:
        async with session_scope() as session:
            usage = await reserve(
                session,
                provider=provider,
                operation=operation,
                estimated_usd=estimated_usd,
                model=model,
                item_id=item_id,
                is_video_generation=is_video_generation,
                units=units,
            )
            usage_id = usage.id
    except BudgetExceeded as exc:
        async with session_scope() as session:
            await notify_budget_stop(session, exc)
        raise
    call = PaidCall(usage_id=usage_id, estimated=estimated_usd)
    try:
        yield call
    except BaseException as exc:
        async with session_scope() as session:
            if charge_on_error:
                await commit_usage(session, usage_id, estimated_usd, cost_source="estimate", units=call.units)
            else:
                await release_usage(session, usage_id, f"{type(exc).__name__}: {exc}")
        raise
    async with session_scope() as session:
        await commit_usage(
            session,
            usage_id,
            call.actual if call.actual is not None else estimated_usd,
            cost_source=call.cost_source if call.actual is not None else "estimate",
            units=call.units,
            request_id=call.request_id,
        )


async def settle_stale_reservations(session: AsyncSession, older_than: timedelta = timedelta(hours=6)) -> int:
    """Резервы, «зависшие» после сбоя процесса, считаются потраченными по оценке — так лимит не занижается."""
    rows = (
        (
            await session.execute(
                select(ProviderUsage)
                .where(
                    ProviderUsage.status == UsageStatus.reserved,
                    ProviderUsage.created_at < utcnow() - older_than,
                )
                .with_for_update(skip_locked=True)
            )
        )
        .scalars()
        .all()
    )
    for usage in rows:
        usage.status = UsageStatus.committed
        usage.actual_cost_usd = usage.estimated_cost_usd
        usage.cost_source = "estimate"
        usage.error = "резерв не был закрыт: принят по оценке"
        usage.finalized_at = utcnow()
    return len(rows)
