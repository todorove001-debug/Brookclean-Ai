"""Сводки расходов, ошибок и состояния системы — для бота, API и панели."""

from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.budget.service import current_spend, period_bounds
from app.content.channel import get_channel
from app.database.enums import ContentStatus, PublishingJobStatus, TaskStatus, UsageStatus, VideoJobStatus
from app.database.models import ContentItem, ProviderUsage, PublishingJob, Task, VideoJob
from app.database.session import utcnow


async def costs_summary(session: AsyncSession) -> dict[str, Any]:
    channel = await get_channel(session)
    budget = channel.settings.budget
    tz = channel.settings.schedule.timezone
    spend = await current_spend(session, tz)
    _, month_start = period_bounds(utcnow(), tz)
    rows = (
        await session.execute(
            select(
                ProviderUsage.provider,
                ProviderUsage.operation,
                func.sum(func.coalesce(ProviderUsage.actual_cost_usd, ProviderUsage.estimated_cost_usd)),
                func.count(),
            )
            .where(ProviderUsage.created_at >= month_start, ProviderUsage.status != UsageStatus.released)
            .group_by(ProviderUsage.provider, ProviderUsage.operation)
            .order_by(
                func.sum(
                    func.coalesce(ProviderUsage.actual_cost_usd, ProviderUsage.estimated_cost_usd)
                ).desc()
            )
        )
    ).all()
    estimated_share = (
        await session.execute(
            select(func.count())
            .select_from(ProviderUsage)
            .where(ProviderUsage.created_at >= month_start, ProviderUsage.cost_source == "estimate")
        )
    ).scalar_one()
    return {
        "day_usd": float(spend.day_usd),
        "month_usd": float(spend.month_usd),
        "daily_limit_usd": float(budget.daily_limit_usd),
        "monthly_limit_usd": float(budget.monthly_limit_usd),
        "video_generations_month": spend.video_generations_month,
        "video_generations_limit": budget.video_generations_per_month,
        "by_operation": [
            {"provider": p, "operation": o, "usd": float(s or Decimal(0)), "calls": c} for p, o, s, c in rows
        ],
        "records_with_estimated_cost": estimated_share,
    }


async def errors_summary(session: AsyncSession, days: int = 7) -> dict[str, Any]:
    since = utcnow() - timedelta(days=days)
    failed_items = (
        await session.execute(
            select(ContentItem.id, ContentItem.topic, ContentItem.last_error, ContentItem.status_changed_at)
            .where(ContentItem.status == ContentStatus.failed, ContentItem.status_changed_at >= since)
            .order_by(ContentItem.status_changed_at.desc())
            .limit(20)
        )
    ).all()
    failed_tasks = (
        await session.execute(
            select(Task.name, func.count())
            .where(Task.status == TaskStatus.failed, Task.updated_at >= since)
            .group_by(Task.name)
        )
    ).all()
    video_failed = (
        await session.execute(
            select(VideoJob.id, VideoJob.item_id, VideoJob.kind, VideoJob.status, VideoJob.error)
            .where(
                VideoJob.status.in_(
                    [VideoJobStatus.failed, VideoJobStatus.waiting_budget, VideoJobStatus.waiting_provider]
                ),
                VideoJob.updated_at >= since,
            )
            .order_by(VideoJob.updated_at.desc())
            .limit(20)
        )
    ).all()
    publishing = (
        await session.execute(
            select(
                PublishingJob.id, PublishingJob.item_id, PublishingJob.status, PublishingJob.last_error
            ).where(
                PublishingJob.status.in_([PublishingJobStatus.failed, PublishingJobStatus.uncertain]),
                PublishingJob.updated_at >= since,
            )
        )
    ).all()
    return {
        "failed_items": [
            {"id": str(i), "topic": t, "error": e, "at": a.isoformat()} for i, t, e, a in failed_items
        ],
        "failed_tasks": [{"name": n, "count": c} for n, c in failed_tasks],
        "video_jobs": [
            {"id": str(i), "item_id": str(it), "kind": k, "status": s, "error": e}
            for i, it, k, s, e in video_failed
        ],
        "publishing": [
            {"id": str(i), "item_id": str(it), "status": s, "error": e} for i, it, s, e in publishing
        ],
    }


async def health_counters(session: AsyncSession) -> dict[str, Any]:
    queue = dict((await session.execute(select(Task.status, func.count()).group_by(Task.status))).all())
    items = dict(
        (await session.execute(select(ContentItem.status, func.count()).group_by(ContentItem.status))).all()
    )
    oldest = (
        await session.execute(
            text(
                "SELECT extract(epoch FROM now() - min(run_at)) FROM tasks WHERE status = 'queued' AND run_at <= now()"
            )
        )
    ).scalar_one()
    return {
        "queue": {str(k): v for k, v in queue.items()},
        "items": {str(k): v for k, v in items.items()},
        "oldest_ready_task_s": float(oldest) if oldest is not None else 0.0,
    }
