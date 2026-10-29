"""Content Strategist: контент-план на 7 или 30 дней.

Детерминированная часть: слоты, время, распределение форматов, проверка повторов тем и призывов.
Языковая модель заполняет смысл слотов: тему, цель, аудиторию, тезис, призыв, критерий успеха.
"""

from __future__ import annotations

import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.base import run_agent
from app.content.channel import Channel, approved_facts, get_channel
from app.content.service import similarity, title_similarity
from app.database.enums import ContentStatus, PlanStatus
from app.database.models import ContentItem, ContentPlan
from app.database.session import session_scope, utcnow
from app.monitoring.audit import audit
from app.orchestration.services import Services
from app.publishing.slots import allocate_formats, day_slots, target_posts_per_day


class PlanEntry(BaseModel):
    slot_index: int
    rubric: str
    topic: str
    goal: str
    audience: str
    thesis: str
    cta: str
    cta_target: str = ""
    success_criterion: str
    needs_sources: bool = False
    media_brief: str = ""


class PlanDraft(BaseModel):
    strategy_notes: str
    entries: list[PlanEntry] = Field(default_factory=list)


class PlannedSlot(BaseModel):
    index: int
    when: datetime
    format: str


class PlanResult(BaseModel):
    plan_id: uuid.UUID | None
    created: int
    skipped: list[str] = Field(default_factory=list)


async def _recent_topics(session: AsyncSession, channel_id: uuid.UUID, days: int = 60) -> list[tuple[str, str]]:
    since = utcnow() - timedelta(days=days)
    rows = await session.execute(
        select(ContentItem.topic, func.coalesce(ContentItem.cta, "")).where(
            ContentItem.channel_id == channel_id, ContentItem.created_at >= since,
            ContentItem.status.not_in([ContentStatus.rejected, ContentStatus.cancelled]),
        ).order_by(ContentItem.created_at.desc()).limit(300)
    )
    return [(r[0], r[1]) for r in rows]


async def _occupied_per_day(session: AsyncSession, channel: Channel, days: list[date]) -> dict[date, list[datetime]]:
    tz = ZoneInfo(channel.settings.schedule.timezone)
    start = datetime.combine(days[0], datetime.min.time(), tzinfo=tz)
    end = datetime.combine(days[-1] + timedelta(days=1), datetime.min.time(), tzinfo=tz)
    rows = await session.execute(
        select(func.coalesce(ContentItem.scheduled_at, ContentItem.planned_at)).where(
            ContentItem.channel_id == channel.id,
            func.coalesce(ContentItem.scheduled_at, ContentItem.planned_at) >= start,
            func.coalesce(ContentItem.scheduled_at, ContentItem.planned_at) < end,
            ContentItem.status.not_in([ContentStatus.rejected, ContentStatus.cancelled]),
        )
    )
    taken: dict[date, list[datetime]] = defaultdict(list)
    for (when,) in rows:
        taken[when.astimezone(tz).date()].append(when)
    return taken


def build_slots(channel: Channel, days: list[date], occupied: dict[date, list[datetime]]) -> list[PlannedSlot]:
    schedule = channel.settings.schedule
    gap = timedelta(minutes=schedule.min_gap_minutes)
    per_day_target = target_posts_per_day(schedule)
    free_times: list[list[datetime]] = []
    for d in days:
        taken = occupied.get(d, [])
        need = max(per_day_target - len(taken), 0)
        candidates = [t for t in day_slots(schedule, d, per_day_target + len(taken)) if all(abs(t - o) >= gap for o in taken)]
        free_times.append(candidates[:need])
    free_per_day = [len(t) for t in free_times]
    exclude = {"story"}  # истории — только по материалам владельца, их владелец добавляет сам
    formats = allocate_formats(channel.settings.mix, free_per_day, exclude=exclude)
    slots: list[PlannedSlot] = []
    for times, day_formats in zip(free_times, formats, strict=True):
        for when, fmt in zip(times, day_formats, strict=False):
            slots.append(PlannedSlot(index=len(slots), when=when, format=fmt))
    return slots


def validate_entries(entries: list[PlanEntry], slots: list[PlannedSlot], recent: list[tuple[str, str]],
                     rubric_keys: set[str], cta_targets: set[str], *, max_title_similarity: float,
                     max_same_cta_per_week: int) -> tuple[list[PlanEntry], list[str]]:
    accepted: list[PlanEntry] = []
    problems: list[str] = []
    by_index = {s.index: s for s in slots}
    seen_topics = [t for t, _ in recent]
    cta_by_week: dict[int, Counter[str]] = defaultdict(Counter)
    for entry in sorted(entries, key=lambda e: e.slot_index):
        slot = by_index.get(entry.slot_index)
        if slot is None or any(a.slot_index == entry.slot_index for a in accepted):
            problems.append(f"слот {entry.slot_index}: неизвестный или повторный")
            continue
        if entry.rubric not in rubric_keys:
            problems.append(f"слот {entry.slot_index}: неизвестная рубрика {entry.rubric}")
            continue
        duplicate = next((t for t in seen_topics if title_similarity(entry.topic, t) >= max_title_similarity
                          or similarity(entry.topic, t, 1) >= 0.8), None)
        if duplicate:
            problems.append(f"слот {entry.slot_index}: тема повторяет «{duplicate[:80]}»")
            continue
        week = slot.when.isocalendar().week
        cta_key = " ".join(entry.cta.lower().split())[:80]
        if cta_by_week[week][cta_key] >= max_same_cta_per_week:
            problems.append(f"слот {entry.slot_index}: призыв «{entry.cta[:60]}» уже {max_same_cta_per_week} раза за неделю")
            continue
        if entry.cta_target and entry.cta_target not in cta_targets:
            entry.cta_target = ""
        cta_by_week[week][cta_key] += 1
        seen_topics.append(entry.topic)
        accepted.append(entry)
    return accepted, problems


def _prompt(channel: Channel, slots: list[PlannedSlot], recent: list[tuple[str, str]], facts: list[str],
            insights: str, problems: list[str] | None = None) -> str:
    s = channel.settings
    tz = ZoneInfo(s.schedule.timezone)
    lines = [
        f"Канал: {s.name}. {s.description}",
        "Рубрики (ключ — описание):",
        *[f"- {r.key} — {r.title}: {r.description}{' (нужны источники)' if r.needs_sources else ''}" for r in s.rubrics
          if not r.requires_owner_material],
        "Маршруты: " + "; ".join(f"{r.origin} — {r.destination}" for r in s.routes),
        "Цели призывов (cta_target): " + (", ".join(sorted(s.cta_targets)) or "нет"),
        "Утверждённые факты о компании:",
        *(facts or ["(нет утверждённых фактов — не используй цифры и обещания о компании)"]),
        "Недавние темы (не повторять):",
        *[f"- {t}" for t, _ in recent[:80]],
        "Аналитика: " + (insights or "данных пока мало"),
        "Слоты для заполнения (индекс, время по местному часовому поясу, формат):",
        *[f"- {sl.index}: {sl.when.astimezone(tz):%a %d.%m %H:%M}, {sl.format}" for sl in slots],
    ]
    if problems:
        lines += ["Предыдущий вариант отклонён проверкой по причинам:", *[f"- {p}" for p in problems],
                  "Заполни только перечисленные слоты заново, с другими темами."]
    return "\n".join(lines)


async def generate_plan(services: Services, *, horizon_days: int, start: date | None = None, insights: str = "") -> PlanResult:
    async with session_scope() as session:
        channel = await get_channel(session)
        tz = ZoneInfo(channel.settings.schedule.timezone)
        first_day = start or (utcnow().astimezone(tz).date() + timedelta(days=1))
        days = [first_day + timedelta(days=i) for i in range(horizon_days)]
        occupied = await _occupied_per_day(session, channel, days)
        recent = await _recent_topics(session, channel.id)
        facts = [f"- [{f.key}] {f.statement}" for f in await approved_facts(session, channel.id)]
    slots = build_slots(channel, days, occupied)
    if not slots:
        return PlanResult(plan_id=None, created=0, skipped=["все слоты горизонта уже заполнены"])

    rubric_keys = {r.key for r in channel.settings.rubrics if not r.requires_owner_material}
    qa = channel.settings.qa
    accepted: list[PlanEntry] = []
    problems: list[str] = []
    pending = slots
    notes = ""
    for _round in range(2):
        draft = await run_agent(services, agent="strategist", schema=PlanDraft,
                                prompt=_prompt(channel, pending, recent, facts, insights, problems if _round else None),
                                expected_output_tokens=180 * len(pending) + 500, max_tokens=32000)
        notes = notes or draft.strategy_notes
        ok, problems = validate_entries(draft.entries, pending, recent + [(e.topic, e.cta) for e in accepted], rubric_keys,
                                        set(channel.settings.cta_targets), max_title_similarity=qa.max_title_similarity,
                                        max_same_cta_per_week=qa.max_same_cta_per_week)
        accepted += ok
        done = {e.slot_index for e in accepted}
        pending = [s for s in slots if s.index not in done]
        if not pending:
            break

    by_index = {s.index: s for s in slots}
    async with session_scope() as session:
        plan = ContentPlan(channel_id=channel.id, horizon_days=horizon_days, period_start=days[0], period_end=days[-1],
                           status=PlanStatus.active, strategy_notes=notes)
        session.add(plan)
        await session.flush()
        for entry in accepted:
            slot = by_index[entry.slot_index]
            session.add(ContentItem(
                channel_id=channel.id, plan_id=plan.id, status=ContentStatus.idea, format=slot.format, rubric=entry.rubric,
                topic=entry.topic, goal=entry.goal, audience=entry.audience, thesis=entry.thesis, cta=entry.cta,
                cta_target=entry.cta_target or None, success_criterion=entry.success_criterion, needs_sources=entry.needs_sources,
                media_requirements={"brief": entry.media_brief}, planned_at=slot.when, created_by="strategist",
            ))
        await audit(session, "plan.created", actor_type="agent", actor_id="strategist", entity_type="content_plan",
                    entity_id=plan.id, horizon_days=horizon_days, items=len(accepted), unfilled=len(pending))
        plan_id = plan.id
    skipped = [f"слот {s.index} ({s.format}) не заполнен" for s in pending] + problems
    return PlanResult(plan_id=plan_id, created=len(accepted), skipped=skipped)
