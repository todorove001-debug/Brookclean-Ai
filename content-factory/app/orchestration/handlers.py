"""Обработчики фоновых задач — единственная точка, где задачи связываются с кодом."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select

from app.agents import ai_video
from app.agents.analytics import recommendations
from app.agents.strategist import generate_plan
from app.analytics import collector
from app.analytics.reports import build_report
from app.approval.service import owners
from app.budget.service import settle_stale_reservations
from app.content.channel import get_channel
from app.database.enums import ContentStatus, TaskStatus, VideoJobStatus
from app.database.models import BotConversation, ContentItem, Notification, Task, VideoJob
from app.database.session import session_scope, utcnow
from app.monitoring.alerts import notify_owner
from app.monitoring.logging import get_logger
from app.monitoring.metrics import CONTENT_ITEMS, QUEUE_DEPTH
from app.monitoring.summary import health_counters
from app.orchestration import pipeline
from app.orchestration.queue import Handler, TaskContext, enqueue
from app.providers.telegram.client import TelegramError
from app.publishing.service import due_items, publish_item, reconcile_stuck_sending

log = get_logger(__name__)


async def notify_send(ctx: TaskContext, payload: dict[str, Any]) -> None:
    async with session_scope() as session:
        note = await session.get(Notification, uuid.UUID(payload["notification_id"]))
        if note is None or note.sent_at is not None:
            return
        recipients = [u.telegram_user_id for u in await owners(session) if u.telegram_user_id]
        text = note.text
    if ctx.services.telegram is None or not recipients:
        async with session_scope() as session:
            note = await session.get(Notification, uuid.UUID(payload["notification_id"]))
            assert note is not None
            note.error = "нет Telegram-бота или получателей — уведомление доступно в API /api/v1/monitoring/notifications"
        return
    delivered = 0
    last_error: TelegramError | None = None
    for chat_id in recipients:
        try:
            await ctx.services.telegram.send_message(chat_id, text)
            delivered += 1
        except TelegramError as exc:
            last_error = exc
    async with session_scope() as session:
        note = await session.get(Notification, uuid.UUID(payload["notification_id"]))
        assert note is not None
        if delivered:
            note.sent_at = utcnow()
            note.error = None
        elif last_error is not None:
            note.error = last_error.description
    if not delivered and last_error is not None and last_error.retryable:
        raise RuntimeError(f"уведомление не доставлено: {last_error.description}")


async def approval_send(ctx: TaskContext, payload: dict[str, Any]) -> None:
    from app.approval.bot import ApprovalBot

    item_id, version_id = uuid.UUID(payload["item_id"]), uuid.UUID(payload["version_id"])
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        if (
            item is None
            or ContentStatus(item.status) != ContentStatus.awaiting_approval
            or item.current_version_id != version_id
        ):
            return
    if ctx.services.telegram is None:
        log.warning("approval.no_bot", item_id=str(item_id))
        return
    await ApprovalBot(ctx.services).send_draft(item_id, version_id)


async def plan_generate(ctx: TaskContext, payload: dict[str, Any]) -> None:
    days = int(payload.get("horizon_days", 7))
    insights = ""
    async with session_scope() as session:
        report = await build_report(session, days=30)
        if report["publications"]:
            insights = "; ".join(
                f"{k}: опубликовано {v['published']}, медиана реакций {v['reactions_median']} (n={v['reactions_n']})"
                for k, v in report["formats"].items()
            )
    result = await generate_plan(ctx.services, horizon_days=days, insights=insights)
    async with session_scope() as session:
        text = f"🗓 План на {days} дней: добавлено {result.created} материалов."
        if result.skipped:
            text += "\nНе заполнено или отклонено проверкой: " + "; ".join(result.skipped[:8])
        await notify_owner(
            session,
            key=f"plan:{result.plan_id or utcnow().isoformat()}",
            kind="info",
            text=text + "\n/plan — посмотреть.",
        )


async def plan_rolling(ctx: TaskContext, payload: dict[str, Any]) -> None:
    """Каждый день: план на 7 дней вперёд должен быть заполнен."""
    await generate_plan(ctx.services, horizon_days=7)


async def production_kick(ctx: TaskContext, payload: dict[str, Any]) -> None:
    """Запускает подготовку материалов, чья дата публикации входит в окно подготовки."""
    async with session_scope() as session:
        channel = await get_channel(session)
        horizon = utcnow() + timedelta(days=channel.settings.schedule.production_lead_days, hours=12)
        ids = (
            (
                await session.execute(
                    select(ContentItem.id)
                    .where(ContentItem.status == ContentStatus.idea, ContentItem.planned_at <= horizon)
                    .limit(30)
                )
            )
            .scalars()
            .all()
        )
        for item_id in ids:
            await enqueue(
                session, "pipeline.advance", {"item_id": str(item_id)}, dedup_key=f"advance:{item_id}"
            )


async def publish_dispatch(ctx: TaskContext, payload: dict[str, Any]) -> None:
    async with session_scope() as session:
        channel = await get_channel(session)
        if channel.row.publishing_paused:
            return
        for item_id in await due_items(session):
            await enqueue(
                session,
                "publish.item",
                {"item_id": str(item_id)},
                dedup_key=f"publish:{item_id}",
                max_attempts=10,
                priority=10,
            )


async def publish_one(ctx: TaskContext, payload: dict[str, Any]) -> None:
    result = await publish_item(ctx.services, uuid.UUID(payload["item_id"]))
    log.info("publish.result", item_id=payload["item_id"], result=result)


async def video_submit(ctx: TaskContext, payload: dict[str, Any]) -> None:
    await ai_video.submit_job(ctx.services, uuid.UUID(payload["job_id"]))


async def video_poll(ctx: TaskContext, payload: dict[str, Any]) -> None:
    await ai_video.poll_job(ctx.services, uuid.UUID(payload["job_id"]))


async def video_watchdog(ctx: TaskContext, payload: dict[str, Any]) -> None:
    """Задания генерации без активной задачи опроса (например, после сбоя) снова ставятся в очередь."""
    async with session_scope() as session:
        jobs = (
            (
                await session.execute(
                    select(VideoJob).where(
                        VideoJob.status.in_(
                            [
                                VideoJobStatus.submitted,
                                VideoJobStatus.processing,
                                VideoJobStatus.pending,
                                VideoJobStatus.waiting_provider,
                            ]
                        ),
                        VideoJob.updated_at < utcnow() - timedelta(minutes=15),
                    )
                )
            )
            .scalars()
            .all()
        )
        for job in jobs:
            if job.status in {VideoJobStatus.pending, VideoJobStatus.waiting_provider}:
                await enqueue(
                    session, "video.submit", {"job_id": str(job.id)}, dedup_key=f"video.submit:{job.id}"
                )
            else:
                await enqueue(
                    session, "video.poll", {"job_id": str(job.id)}, dedup_key=f"video.poll:{job.id}"
                )


async def analytics_collect(ctx: TaskContext, payload: dict[str, Any]) -> None:
    await collector.collect_subscribers(ctx.services)
    await collector.collect_link_clicks(ctx.services)
    await collector.collect_mtproto(ctx.services)


async def analytics_weekly(ctx: TaskContext, payload: dict[str, Any]) -> None:
    async with session_scope() as session:
        report = await build_report(session, days=7)
    recs = await recommendations(ctx.services, report, use_llm=False)
    lines = [
        f"📊 Неделя: публикаций {report['publications']}, успешность {report['publishing_success_rate'] or '—'}",
        f"Расходы за месяц: ${report['costs']['month_usd']:.2f}",
    ]
    lines += [f"• {r['title']}: {r['evidence']}. {r['action']}" for r in recs["rules"]]
    async with session_scope() as session:
        await notify_owner(session, key=f"weekly:{utcnow():%G-%V}", kind="report", text="\n".join(lines))


async def maintenance(ctx: TaskContext, payload: dict[str, Any]) -> None:
    async with session_scope() as session:
        settled = await settle_stale_reservations(session)
        await reconcile_stuck_sending(session)
        await session.execute(
            delete(Task).where(
                Task.status == TaskStatus.succeeded, Task.finished_at < utcnow() - timedelta(days=14)
            )
        )
        await session.execute(delete(BotConversation).where(BotConversation.expires_at < utcnow()))
        # Материалы, «застрявшие» в промежуточных статусах (например, задача потерялась), снова ставятся в конвейер.
        stuck = (
            (
                await session.execute(
                    select(ContentItem.id).where(
                        ContentItem.status.in_(
                            [
                                ContentStatus.researching,
                                ContentStatus.drafting,
                                ContentStatus.quality_check,
                                ContentStatus.changes_requested,
                                ContentStatus.approved,
                            ]
                        ),
                        ContentItem.status_changed_at < utcnow() - timedelta(hours=2),
                    )
                )
            )
            .scalars()
            .all()
        )
        for item_id in stuck:
            await enqueue(
                session, "pipeline.advance", {"item_id": str(item_id)}, dedup_key=f"advance:{item_id}"
            )
        counters = await health_counters(session)
    for status, count in counters["queue"].items():
        QUEUE_DEPTH.labels(status).set(count)
    for status, count in counters["items"].items():
        CONTENT_ITEMS.labels(status).set(count)
    if settled:
        log.warning("budget.stale_reservations_settled", count=settled)


async def advance(ctx: TaskContext, payload: dict[str, Any]) -> None:
    await pipeline.advance(ctx, payload)


HANDLERS: dict[str, Handler] = {
    "pipeline.advance": advance,
    "pipeline.fix": pipeline.fix,
    "notify.send": notify_send,
    "approval.send": approval_send,
    "plan.generate": plan_generate,
    "plan.rolling": plan_rolling,
    "production.kick": production_kick,
    "publish.dispatch": publish_dispatch,
    "publish.item": publish_one,
    "video.submit": video_submit,
    "video.poll": video_poll,
    "video.watchdog": video_watchdog,
    "analytics.collect": analytics_collect,
    "analytics.weekly": analytics_weekly,
    "maintenance": maintenance,
}
