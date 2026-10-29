"""Контент-план, материалы, версии, согласование через API (те же правила, что и в боте)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.api.deps import SessionDep, require
from app.api.schemas import (
    ApproveIn,
    ChangesIn,
    ItemCreate,
    ItemOut,
    PlanRequest,
    RejectIn,
    RescheduleIn,
    VersionOut,
    VideoRegenIn,
)
from app.approval import service as approval
from app.content.channel import get_channel
from app.content.service import InvalidTransition, load_version, new_version, transition
from app.database.enums import ContentStatus
from app.database.models import (
    ApprovalEvent,
    ContentItem,
    ContentPlan,
    ContentVersion,
    MediaAsset,
    ResearchSource,
    User,
)
from app.monitoring.audit import audit
from app.orchestration.queue import enqueue
from app.security.rbac import Permission

router = APIRouter(prefix="/api/v1")


def _err(exc: Exception) -> HTTPException:
    return HTTPException(409, str(exc))


@router.post("/plans", status_code=202)
async def request_plan(
    body: PlanRequest, session: SessionDep, user: User = Depends(require(Permission.content_write))
) -> dict[str, Any]:
    task_id = await enqueue(
        session,
        "plan.generate",
        {"horizon_days": body.horizon_days},
        dedup_key=f"plan.generate:{body.horizon_days}",
        max_attempts=2,
    )
    await audit(
        session, "plan.requested", actor_type="user", actor_id=str(user.id), horizon_days=body.horizon_days
    )
    return {"queued": task_id is not None, "task_id": str(task_id) if task_id else None}


@router.get("/plans", dependencies=[Depends(require(Permission.content_read))])
async def list_plans(session: SessionDep, limit: int = Query(20, le=100)) -> list[dict[str, Any]]:
    plans = (
        (await session.execute(select(ContentPlan).order_by(ContentPlan.created_at.desc()).limit(limit)))
        .scalars()
        .all()
    )
    return [
        {
            "id": str(p.id),
            "horizon_days": p.horizon_days,
            "period_start": p.period_start,
            "period_end": p.period_end,
            "status": p.status,
            "strategy_notes": p.strategy_notes,
            "created_at": p.created_at,
        }
        for p in plans
    ]


@router.get("/plans/{plan_id}", dependencies=[Depends(require(Permission.content_read))])
async def get_plan(plan_id: uuid.UUID, session: SessionDep) -> dict[str, Any]:
    plan = await session.get(ContentPlan, plan_id)
    if plan is None:
        raise HTTPException(404, "план не найден")
    items = (
        await session.execute(
            select(ContentItem).where(ContentItem.plan_id == plan_id).order_by(ContentItem.planned_at)
        )
    ).scalars()
    return {
        "id": str(plan.id),
        "horizon_days": plan.horizon_days,
        "strategy_notes": plan.strategy_notes,
        "items": [ItemOut.model_validate(i).model_dump(mode="json") for i in items],
    }


@router.get("/items", response_model=list[ItemOut], dependencies=[Depends(require(Permission.content_read))])
async def list_items(
    session: SessionDep, status: ContentStatus | None = None, limit: int = Query(50, le=200), offset: int = 0
) -> list[ContentItem]:
    stmt = select(ContentItem).order_by(
        ContentItem.planned_at.desc().nulls_last(), ContentItem.created_at.desc()
    )
    if status is not None:
        stmt = stmt.where(ContentItem.status == status)
    return list((await session.execute(stmt.limit(limit).offset(offset))).scalars())


@router.post("/items", response_model=ItemOut, status_code=201)
async def create_item(
    body: ItemCreate, session: SessionDep, user: User = Depends(require(Permission.content_write))
) -> ContentItem:
    channel = await get_channel(session)
    if body.format == "story" and not body.owner_brief:
        raise HTTPException(422, "для истории перевозки нужны материалы владельца (owner_brief)")
    for asset_id in body.source_asset_ids:
        if await session.get(MediaAsset, asset_id) is None:
            raise HTTPException(422, f"медиафайл {asset_id} не найден")
    item = ContentItem(
        channel_id=channel.id,
        status=ContentStatus.idea,
        format=body.format,
        topic=body.topic,
        rubric=body.rubric,
        goal=body.goal,
        audience=body.audience,
        thesis=body.thesis,
        cta=body.cta,
        cta_target=body.cta_target,
        success_criterion=body.success_criterion,
        needs_sources=body.needs_sources,
        owner_brief=body.owner_brief,
        planned_at=body.planned_at,
        created_by=f"user:{user.id}",
        media_requirements={"source_asset_ids": [str(a) for a in body.source_asset_ids]},
    )
    session.add(item)
    await session.flush()
    if body.start:
        await enqueue(session, "pipeline.advance", {"item_id": str(item.id)}, dedup_key=f"advance:{item.id}")
    await audit(
        session,
        "content.created",
        actor_type="user",
        actor_id=str(user.id),
        entity_type="content_item",
        entity_id=item.id,
    )
    return item


@router.get("/items/{item_id}", dependencies=[Depends(require(Permission.content_read))])
async def get_item(item_id: uuid.UUID, session: SessionDep) -> dict[str, Any]:
    item = await session.get(ContentItem, item_id)
    if item is None:
        raise HTTPException(404, "материал не найден")
    versions = (
        await session.execute(
            select(ContentVersion)
            .where(ContentVersion.item_id == item_id)
            .order_by(ContentVersion.version_no)
        )
    ).scalars()
    current = await load_version(session, item.current_version_id)
    sources = (
        await session.execute(select(ResearchSource).where(ResearchSource.item_id == item_id))
    ).scalars()
    events = (
        await session.execute(
            select(ApprovalEvent).where(ApprovalEvent.item_id == item_id).order_by(ApprovalEvent.created_at)
        )
    ).scalars()
    return {
        "item": ItemOut.model_validate(item).model_dump(mode="json"),
        "versions": [VersionOut.model_validate(v).model_dump(mode="json") for v in versions],
        "current_media": [
            {
                "role": link.role,
                "asset_id": str(link.asset_id),
                "kind": link.asset.kind,
                "mime_type": link.asset.mime_type,
                "sha256": link.asset.sha256,
            }
            for link in (current.media_links if current else [])
        ],
        "sources": [
            {
                "url": s.url,
                "title": s.title,
                "publisher": s.publisher,
                "published_at": s.published_at,
                "verification": s.verification,
                "claims": s.claims,
                "retrieved_at": s.retrieved_at,
            }
            for s in sources
        ],
        "approval_history": [
            {
                "action": e.action,
                "version_id": str(e.version_id) if e.version_id else None,
                "content_hash": e.content_hash,
                "actor_user_id": str(e.actor_user_id) if e.actor_user_id else None,
                "comment": e.comment,
                "payload": e.payload,
                "at": e.created_at,
            }
            for e in events
        ],
    }


@router.post("/items/{item_id}/approve")
async def approve(
    item_id: uuid.UUID,
    body: ApproveIn,
    session: SessionDep,
    user: User = Depends(require(Permission.content_approve)),
) -> dict[str, str]:
    try:
        return {"message": (await approval.approve(session, user, item_id, body.version_id)).message}
    except approval.ApprovalError as exc:
        raise _err(exc) from exc


@router.post("/items/{item_id}/request-changes")
async def request_changes(
    item_id: uuid.UUID,
    body: ChangesIn,
    session: SessionDep,
    user: User = Depends(require(Permission.content_approve)),
) -> dict[str, str]:
    try:
        return {
            "message": (
                await approval.request_changes(session, user, item_id, body.version_id, body.comment)
            ).message
        }
    except approval.ApprovalError as exc:
        raise _err(exc) from exc


@router.post("/items/{item_id}/regenerate-text")
async def regenerate_text(
    item_id: uuid.UUID,
    body: ApproveIn,
    session: SessionDep,
    user: User = Depends(require(Permission.content_approve)),
) -> dict[str, str]:
    try:
        return {"message": (await approval.regenerate_text(session, user, item_id, body.version_id)).message}
    except approval.ApprovalError as exc:
        raise _err(exc) from exc


@router.post("/items/{item_id}/regenerate-video")
async def regenerate_video(
    item_id: uuid.UUID,
    body: VideoRegenIn,
    session: SessionDep,
    user: User = Depends(require(Permission.content_approve)),
) -> dict[str, str]:
    params = body.model_dump(exclude={"version_id"}, exclude_none=True, mode="json")
    try:
        return {
            "message": (
                await approval.regenerate_video(session, user, item_id, body.version_id, params)
            ).message
        }
    except approval.ApprovalError as exc:
        raise _err(exc) from exc


@router.post("/items/{item_id}/reschedule")
async def reschedule(
    item_id: uuid.UUID,
    body: RescheduleIn,
    session: SessionDep,
    user: User = Depends(require(Permission.publishing_control)),
) -> dict[str, str]:
    try:
        return {
            "message": (
                await approval.reschedule(session, user, item_id, body.version_id, body.scheduled_at)
            ).message
        }
    except approval.ApprovalError as exc:
        raise _err(exc) from exc


@router.post("/items/{item_id}/reject")
async def reject(
    item_id: uuid.UUID,
    body: RejectIn,
    session: SessionDep,
    user: User = Depends(require(Permission.content_approve)),
) -> dict[str, str]:
    try:
        return {
            "message": (await approval.reject(session, user, item_id, body.version_id, body.comment)).message
        }
    except approval.ApprovalError as exc:
        raise _err(exc) from exc


@router.post("/items/{item_id}/cancel")
async def cancel(
    item_id: uuid.UUID, session: SessionDep, user: User = Depends(require(Permission.publishing_control))
) -> dict[str, str]:
    try:
        return {"message": (await approval.cancel(session, user, item_id)).message}
    except approval.ApprovalError as exc:
        raise _err(exc) from exc


@router.post("/items/{item_id}/retry")
async def retry(
    item_id: uuid.UUID, session: SessionDep, user: User = Depends(require(Permission.content_write))
) -> dict[str, str]:
    """Повтор после ошибки: материал возвращается на этап, где остановился (по наличию версии)."""
    item = (
        await session.execute(select(ContentItem).where(ContentItem.id == item_id).with_for_update())
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(404, "материал не найден")
    if ContentStatus(item.status) != ContentStatus.failed:
        raise HTTPException(409, "повтор возможен только для материалов в статусе failed")
    current = await load_version(session, item.current_version_id)
    if current is None:
        target = ContentStatus.drafting
    elif current.frozen_at is not None:
        # Замороженную версию менять нельзя: копия проходит проверку и согласование заново.
        await new_version(
            session,
            item,
            title=current.title,
            body_html=current.body_html,
            origin="retry",
            poll=current.poll,
            video_script=current.video_script,
            hashtags=current.hashtags,
            cta_text=current.cta_text,
            publish_options=current.publish_options,
            copy_media_from=current,
        )
        target = ContentStatus.quality_check
    elif item.format in {"video", "image_post", "infographic"} and not current.media_links:
        target = ContentStatus.media_generation
    else:
        target = ContentStatus.quality_check
    try:
        await transition(session, item, target, actor=str(user.id), reason="повтор по запросу")
    except InvalidTransition as exc:
        raise _err(exc) from exc
    await enqueue(session, "pipeline.advance", {"item_id": str(item.id)}, dedup_key=f"advance:{item.id}")
    return {"message": f"материал возвращён на этап {target}"}


@router.post("/publishing/pause")
async def pause(
    session: SessionDep,
    reason: str | None = None,
    user: User = Depends(require(Permission.publishing_control)),
) -> dict[str, str]:
    return {"message": await approval.set_paused(session, user, True, reason)}


@router.post("/publishing/resume")
async def resume(
    session: SessionDep, user: User = Depends(require(Permission.publishing_control))
) -> dict[str, str]:
    return {"message": await approval.set_paused(session, user, False)}
