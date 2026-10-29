"""Approval Service: действия владельца над конкретной версией материала.

Каждое действие привязано к версии и её контрольной сумме. Действие над устаревшей версией
отклоняется. Одобрение проверяет права пользователя, результаты QA и неизменность версии.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.content.channel import get_channel
from app.content.service import InvalidTransition, load_version, recompute_hash, transition
from app.database.enums import ApprovalAction, ContentStatus, PublishingJobStatus, QAStatus, UserRole
from app.database.models import ApprovalEvent, ContentItem, PublishingJob, User
from app.database.session import utcnow
from app.monitoring.audit import audit
from app.orchestration.queue import enqueue
from app.publishing.slots import is_allowed, next_free_slot
from app.security.rbac import Permission, has_permission


class ApprovalError(Exception):
    """Действие невозможно; текст понятен владельцу."""


@dataclass(slots=True)
class ActionResult:
    message: str
    item: ContentItem


def _require(user: User, permission: Permission) -> None:
    if not user.is_active or not has_permission(user.role, permission):
        raise ApprovalError("недостаточно прав для этого действия")


async def _locked(session: AsyncSession, item_id: uuid.UUID) -> ContentItem:
    item = (
        await session.execute(select(ContentItem).where(ContentItem.id == item_id).with_for_update())
    ).scalar_one_or_none()
    if item is None:
        raise ApprovalError("материал не найден")
    return item


def _check_current(item: ContentItem, version_id: uuid.UUID) -> None:
    if item.current_version_id != version_id:
        raise ApprovalError("эта версия устарела — откройте актуальную версию материала")


async def _event(
    session: AsyncSession,
    item: ContentItem,
    version_id: uuid.UUID | None,
    action: ApprovalAction,
    user: User | None,
    comment: str | None = None,
    payload: dict | None = None,
    content_hash: str | None = None,
) -> ApprovalEvent:
    event = ApprovalEvent(
        item_id=item.id,
        version_id=version_id,
        content_hash=content_hash,
        action=action,
        actor_user_id=user.id if user else None,
        telegram_user_id=user.telegram_user_id if user else None,
        comment=comment,
        payload=payload or {},
    )
    session.add(event)
    await session.flush()
    await audit(
        session,
        f"approval.{action.value}",
        actor_type="user" if user else "system",
        actor_id=str(user.id) if user else None,
        entity_type="content_item",
        entity_id=item.id,
        version_id=str(version_id) if version_id else None,
        comment=comment,
    )
    return event


async def occupied_times(session: AsyncSession, exclude: uuid.UUID | None = None) -> list[datetime]:
    stmt = select(ContentItem.scheduled_at).where(
        ContentItem.status.in_([ContentStatus.scheduled, ContentStatus.publishing, ContentStatus.published]),
        ContentItem.scheduled_at.is_not(None),
        ContentItem.scheduled_at >= utcnow() - timedelta(days=1),
    )
    if exclude is not None:
        stmt = stmt.where(ContentItem.id != exclude)
    return [r[0] for r in await session.execute(stmt)]


async def schedule(
    session: AsyncSession, item: ContentItem, *, preferred: datetime | None = None, actor: str = "system"
) -> datetime | None:
    """Назначает разрешённое время и создаёт задание публикации. Только для одобренной версии."""
    if item.approved_version_id is None or item.approved_version_id != item.current_version_id:
        raise ApprovalError("нет действующего одобрения текущей версии")
    channel = await get_channel(session)
    schedule_cfg = channel.settings.schedule
    now = utcnow()
    wish = preferred or item.scheduled_at or item.planned_at or now
    when = next_free_slot(
        schedule_cfg,
        await occupied_times(session, exclude=item.id),
        preferred=wish,
        not_before=now + timedelta(minutes=10),
    )
    if when is None:
        return None
    item.scheduled_at = when
    if ContentStatus(item.status) == ContentStatus.approved:
        await transition(
            session, item, ContentStatus.scheduled, actor=actor, reason=f"время публикации {when.isoformat()}"
        )
    job = (
        await session.execute(
            select(PublishingJob).where(PublishingJob.version_id == item.approved_version_id)
        )
    ).scalar_one_or_none()
    if job is None:
        session.add(
            PublishingJob(
                item_id=item.id,
                version_id=item.approved_version_id,
                content_hash=item.approved_content_hash or "",
                scheduled_at=when,
                status=PublishingJobStatus.pending,
            )
        )
    elif job.status == PublishingJobStatus.pending:
        job.scheduled_at = when
    await session.flush()
    return when


async def approve(
    session: AsyncSession, user: User, item_id: uuid.UUID, version_id: uuid.UUID
) -> ActionResult:
    _require(user, Permission.content_approve)
    item = await _locked(session, item_id)
    _check_current(item, version_id)
    if ContentStatus(item.status) != ContentStatus.awaiting_approval:
        raise ApprovalError(f"материал в статусе «{item.status}», одобрение невозможно")
    version = await load_version(session, version_id)
    assert version is not None
    if version.frozen_at is None or not version.content_hash:
        raise ApprovalError("версия не заморожена — дождитесь окончания проверки")
    if QAStatus(version.qa_status) not in {QAStatus.passed, QAStatus.needs_review}:
        raise ApprovalError("обязательные проверки не пройдены — запросите правки или отклоните материал")
    actual_hash = await recompute_hash(session, item, version_id)
    if actual_hash != version.content_hash:
        raise ApprovalError("содержимое версии не совпадает с проверенным — одобрение невозможно")
    event = await _event(
        session,
        item,
        version_id,
        ApprovalAction.approve,
        user,
        content_hash=version.content_hash,
        payload={
            "qa_status": version.qa_status,
            "manual_checks_acknowledged": QAStatus(version.qa_status) == QAStatus.needs_review,
        },
    )
    item.approved_version_id = version_id
    item.approved_content_hash = version.content_hash
    item.approved_by_user_id = user.id
    item.approved_at = utcnow()
    await transition(session, item, ContentStatus.approved, actor=str(user.id))
    when = await schedule(session, item, actor=str(user.id))
    job = (
        await session.execute(select(PublishingJob).where(PublishingJob.version_id == version_id))
    ).scalar_one_or_none()
    if job is not None:
        job.approval_event_id = event.id
    if when is None:
        return ActionResult(
            "Одобрено. Свободного разрешённого времени не нашлось — назначьте время вручную.", item
        )
    return ActionResult(f"Одобрено. Публикация запланирована на {when.isoformat()}.", item)


async def request_changes(
    session: AsyncSession, user: User, item_id: uuid.UUID, version_id: uuid.UUID, comment: str
) -> ActionResult:
    _require(user, Permission.content_approve)
    comment = comment.strip()
    if not comment:
        raise ApprovalError("опишите, что нужно изменить")
    item = await _locked(session, item_id)
    _check_current(item, version_id)
    if ContentStatus(item.status) not in {
        ContentStatus.awaiting_approval,
        ContentStatus.approved,
        ContentStatus.scheduled,
    }:
        raise ApprovalError(f"в статусе «{item.status}» правки не принимаются")
    await _cancel_publishing(session, item)
    await _event(session, item, version_id, ApprovalAction.request_changes, user, comment=comment[:4000])
    item.pending_change_request = comment[:4000]
    item.auto_fix_rounds = 0
    await transition(session, item, ContentStatus.changes_requested, actor=str(user.id))
    await enqueue(session, "pipeline.advance", {"item_id": str(item.id)}, dedup_key=f"advance:{item.id}")
    return ActionResult("Правки приняты, готовлю новую версию.", item)


async def regenerate_text(
    session: AsyncSession, user: User, item_id: uuid.UUID, version_id: uuid.UUID
) -> ActionResult:
    return await request_changes(
        session,
        user,
        item_id,
        version_id,
        "Перепиши текст заново: другой заход, другой заголовок, те же факты и формат.",
    )


async def regenerate_video(
    session: AsyncSession, user: User, item_id: uuid.UUID, version_id: uuid.UUID, params: dict
) -> ActionResult:
    _require(user, Permission.content_approve)
    item = await _locked(session, item_id)
    _check_current(item, version_id)
    if item.format != "video":
        raise ApprovalError("у материала нет видео")
    if ContentStatus(item.status) not in {
        ContentStatus.awaiting_approval,
        ContentStatus.approved,
        ContentStatus.scheduled,
    }:
        raise ApprovalError(f"в статусе «{item.status}» перегенерация невозможна")
    await _cancel_publishing(session, item)
    await _event(session, item, version_id, ApprovalAction.regenerate_video, user, payload=params)
    item.pending_video_params = params
    await transition(session, item, ContentStatus.changes_requested, actor=str(user.id))
    await enqueue(session, "pipeline.advance", {"item_id": str(item.id)}, dedup_key=f"advance:{item.id}")
    return ActionResult("Видео будет пересобрано с новыми параметрами.", item)


async def reject(
    session: AsyncSession, user: User, item_id: uuid.UUID, version_id: uuid.UUID, comment: str | None = None
) -> ActionResult:
    _require(user, Permission.content_approve)
    item = await _locked(session, item_id)
    _check_current(item, version_id)
    await _cancel_publishing(session, item)
    await _event(session, item, version_id, ApprovalAction.reject, user, comment=comment)
    item.approved_version_id = None
    item.approved_content_hash = None
    try:
        await transition(session, item, ContentStatus.rejected, actor=str(user.id))
    except InvalidTransition as exc:
        raise ApprovalError(f"в статусе «{item.status}» отклонение невозможно") from exc
    return ActionResult("Материал отклонён.", item)


async def cancel(
    session: AsyncSession, user: User, item_id: uuid.UUID, comment: str | None = None
) -> ActionResult:
    _require(user, Permission.publishing_control)
    item = await _locked(session, item_id)
    if ContentStatus(item.status) in {ContentStatus.published, ContentStatus.publishing}:
        raise ApprovalError("материал уже публикуется или опубликован")
    await _cancel_publishing(session, item)
    await _event(session, item, item.current_version_id, ApprovalAction.cancel, user, comment=comment)
    try:
        await transition(session, item, ContentStatus.cancelled, actor=str(user.id))
    except InvalidTransition as exc:
        raise ApprovalError(f"в статусе «{item.status}» отмена невозможна") from exc
    return ActionResult("Материал отменён, публикации не будет.", item)


async def reschedule(
    session: AsyncSession, user: User, item_id: uuid.UUID, version_id: uuid.UUID, when: datetime
) -> ActionResult:
    _require(user, Permission.publishing_control)
    item = await _locked(session, item_id)
    _check_current(item, version_id)
    channel = await get_channel(session)
    if when.tzinfo is None:
        raise ApprovalError("укажите время с часовым поясом")
    if when < utcnow() + timedelta(minutes=5):
        raise ApprovalError("время уже прошло или слишком близко")
    if not is_allowed(channel.settings.schedule, when):
        raise ApprovalError("это время вне разрешённых окон публикации")
    status = ContentStatus(item.status)
    gap = timedelta(minutes=channel.settings.schedule.min_gap_minutes)
    clash = [t for t in await occupied_times(session, exclude=item.id) if abs(t - when) < gap]
    if clash:
        raise ApprovalError(
            f"слишком близко к другой публикации ({clash[0].isoformat()}), интервал — {channel.settings.schedule.min_gap_minutes} мин"
        )
    await _event(
        session,
        item,
        version_id,
        ApprovalAction.reschedule,
        user,
        payload={
            "from": item.scheduled_at.isoformat() if item.scheduled_at else None,
            "to": when.isoformat(),
        },
    )
    if status in {ContentStatus.scheduled, ContentStatus.approved}:
        item.scheduled_at = when
        job = (
            await session.execute(
                select(PublishingJob).where(
                    PublishingJob.item_id == item.id, PublishingJob.status == PublishingJobStatus.pending
                )
            )
        ).scalar_one_or_none()
        if job is not None:
            job.scheduled_at = when
        if status == ContentStatus.approved:
            await schedule(session, item, preferred=when, actor=str(user.id))
    elif status in {
        ContentStatus.awaiting_approval,
        ContentStatus.idea,
        ContentStatus.drafting,
        ContentStatus.quality_check,
        ContentStatus.media_generation,
        ContentStatus.researching,
        ContentStatus.changes_requested,
    }:
        # Пожелание по времени: будет применено при одобрении.
        item.scheduled_at = when
    else:
        raise ApprovalError(f"в статусе «{item.status}» перенос невозможен")
    return ActionResult(f"Время публикации: {when.isoformat()}.", item)


async def set_paused(session: AsyncSession, user: User, paused: bool, reason: str | None = None) -> str:
    _require(user, Permission.publishing_control)
    channel = await get_channel(session, for_update=True)
    channel.row.publishing_paused = paused
    channel.row.paused_reason = reason if paused else None
    await audit(
        session,
        "publishing.pause" if paused else "publishing.resume",
        actor_type="user",
        actor_id=str(user.id),
        entity_type="channel",
        entity_id=channel.id,
        reason=reason,
    )
    return "Очередь публикаций приостановлена." if paused else "Очередь публикаций возобновлена."


async def _cancel_publishing(session: AsyncSession, item: ContentItem) -> None:
    jobs = (
        await session.execute(
            select(PublishingJob)
            .where(PublishingJob.item_id == item.id, PublishingJob.status == PublishingJobStatus.pending)
            .with_for_update()
        )
    ).scalars()
    for job in jobs:
        job.status = PublishingJobStatus.cancelled
        job.finished_at = utcnow()
    if ContentStatus(item.status) == ContentStatus.publishing:
        raise ApprovalError("материал уже публикуется")


async def approvers(session: AsyncSession) -> list[User]:
    users = (
        await session.execute(
            select(User).where(User.is_active.is_(True), User.telegram_user_id.is_not(None))
        )
    ).scalars()
    return [u for u in users if has_permission(u.role, Permission.content_approve)]


async def owners(session: AsyncSession) -> list[User]:
    return list(
        (
            await session.execute(
                select(User).where(
                    User.is_active.is_(True),
                    User.telegram_user_id.is_not(None),
                    User.role.in_([UserRole.owner, UserRole.admin]),
                )
            )
        ).scalars()
    )
