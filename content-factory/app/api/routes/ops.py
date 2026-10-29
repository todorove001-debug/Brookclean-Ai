"""Задания видео, очередь задач, аналитика, мониторинг, журнал действий."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app.agents.analytics import recommendations
from app.analytics.reports import build_report
from app.api.deps import ServicesDep, SessionDep, require
from app.api.schemas import VideoJobOut
from app.database.enums import TaskStatus, VideoJobKind, VideoJobStatus
from app.database.models import AuditLog, Notification, Task, User, VideoJob
from app.monitoring.audit import audit
from app.monitoring.summary import costs_summary, errors_summary, health_counters
from app.orchestration.queue import enqueue
from app.security.rbac import Permission

router = APIRouter(prefix="/api/v1")


@router.get(
    "/video-jobs", response_model=list[VideoJobOut], dependencies=[Depends(require(Permission.content_read))]
)
async def list_video_jobs(
    session: SessionDep,
    item_id: uuid.UUID | None = None,
    status: VideoJobStatus | None = None,
    limit: int = Query(50, le=200),
) -> list[VideoJob]:
    stmt = select(VideoJob).order_by(VideoJob.created_at.desc())
    if item_id:
        stmt = stmt.where(VideoJob.item_id == item_id)
    if status:
        stmt = stmt.where(VideoJob.status == status)
    return list((await session.execute(stmt.limit(limit))).scalars())


@router.post("/video-jobs/{job_id}/retry")
async def retry_video_job(
    job_id: uuid.UUID, session: SessionDep, user: User = Depends(require(Permission.content_approve))
) -> dict[str, str]:
    """Ручное решение владельца: повторить платную генерацию (например, после ожидания бюджета). Лимит попыток +1."""
    job = await session.get(VideoJob, job_id, with_for_update=True)
    if job is None or job.kind != VideoJobKind.ai_scene:
        raise HTTPException(404, "задание не найдено")
    if job.status not in {
        VideoJobStatus.failed,
        VideoJobStatus.waiting_budget,
        VideoJobStatus.waiting_provider,
    }:
        raise HTTPException(409, f"задание в статусе {job.status}")
    job.status = VideoJobStatus.pending
    job.max_attempts = max(job.max_attempts, job.attempts + 1)
    job.error = None
    await enqueue(session, "video.submit", {"job_id": str(job.id)}, dedup_key=f"video.submit:{job.id}")
    await audit(
        session,
        "video_job.retry",
        actor_type="user",
        actor_id=str(user.id),
        entity_type="video_job",
        entity_id=job.id,
    )
    return {"message": "задание поставлено в очередь"}


@router.post("/video-jobs/{job_id}/cancel")
async def cancel_video_job(
    job_id: uuid.UUID, session: SessionDep, user: User = Depends(require(Permission.content_approve))
) -> dict[str, str]:
    job = await session.get(VideoJob, job_id, with_for_update=True)
    if job is None:
        raise HTTPException(404, "задание не найдено")
    if job.status in {VideoJobStatus.succeeded, VideoJobStatus.cancelled}:
        raise HTTPException(409, f"задание в статусе {job.status}")
    job.status = VideoJobStatus.cancelled
    await enqueue(
        session, "pipeline.advance", {"item_id": str(job.item_id)}, dedup_key=f"advance:{job.item_id}"
    )
    await audit(
        session,
        "video_job.cancel",
        actor_type="user",
        actor_id=str(user.id),
        entity_type="video_job",
        entity_id=job.id,
    )
    return {"message": "задание отменено; ролик соберётся без этой сцены"}


@router.get("/tasks", dependencies=[Depends(require(Permission.monitoring_read))])
async def list_tasks(
    session: SessionDep, status: TaskStatus | None = None, limit: int = Query(50, le=200)
) -> list[dict[str, Any]]:
    stmt = select(Task).order_by(Task.updated_at.desc())
    if status:
        stmt = stmt.where(Task.status == status)
    rows = (await session.execute(stmt.limit(limit))).scalars()
    return [
        {
            "id": str(t.id),
            "name": t.name,
            "status": t.status,
            "attempts": t.attempts,
            "max_attempts": t.max_attempts,
            "run_at": t.run_at,
            "last_error": (t.last_error or "")[:1000],
            "payload": t.payload,
        }
        for t in rows
    ]


@router.get("/analytics/report", dependencies=[Depends(require(Permission.content_read))])
async def analytics_report(session: SessionDep, days: int = Query(30, ge=1, le=365)) -> dict[str, Any]:
    return await build_report(session, days=days)


@router.get("/analytics/recommendations", dependencies=[Depends(require(Permission.content_read))])
async def analytics_recommendations(
    session: SessionDep, services: ServicesDep, days: int = Query(30, ge=7, le=365), use_llm: bool = False
) -> dict[str, Any]:
    report = await build_report(session, days=days)
    return await recommendations(services, report, use_llm=use_llm)


@router.get("/monitoring/costs", dependencies=[Depends(require(Permission.budget_read))])
async def costs(session: SessionDep) -> dict[str, Any]:
    return await costs_summary(session)


@router.get("/monitoring/errors", dependencies=[Depends(require(Permission.monitoring_read))])
async def errors(session: SessionDep, days: int = Query(7, ge=1, le=90)) -> dict[str, Any]:
    return await errors_summary(session, days=days)


@router.get("/monitoring/status", dependencies=[Depends(require(Permission.monitoring_read))])
async def system_status(session: SessionDep) -> dict[str, Any]:
    return await health_counters(session)


@router.get("/monitoring/notifications", dependencies=[Depends(require(Permission.monitoring_read))])
async def notifications(session: SessionDep, limit: int = Query(50, le=200)) -> list[dict[str, Any]]:
    rows = (
        await session.execute(select(Notification).order_by(Notification.created_at.desc()).limit(limit))
    ).scalars()
    return [
        {"kind": n.kind, "text": n.text, "created_at": n.created_at, "sent_at": n.sent_at, "error": n.error}
        for n in rows
    ]


@router.get("/audit", dependencies=[Depends(require(Permission.audit_read))])
async def audit_log(
    session: SessionDep, entity_id: str | None = None, limit: int = Query(100, le=500)
) -> list[dict[str, Any]]:
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc())
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    rows = (await session.execute(stmt.limit(limit))).scalars()
    return [
        {
            "at": a.created_at,
            "actor_type": a.actor_type,
            "actor_id": a.actor_id,
            "action": a.action,
            "entity_type": a.entity_type,
            "entity_id": a.entity_id,
            "details": a.details,
        }
        for a in rows
    ]
