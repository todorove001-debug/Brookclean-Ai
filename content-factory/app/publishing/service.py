"""Publishing Service: публикация одобренных материалов в канал.

Публикация — отдельная контролируемая операция в три шага:
1. проверки и перевод задания в «sending» (транзакция с блокировкой строк);
2. запрос в Telegram;
3. фиксация результата и message ID (транзакция).
Повторная доставка задачи из очереди не приводит к дублю: задание в «sending», «succeeded» или
«uncertain» повторно не отправляется. Если ответ Telegram потерян после отправки, задание
получает статус «uncertain» и ждёт проверки человеком — автоматического повтора нет.
"""

from __future__ import annotations

import io
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.qa import caption_text
from app.content.channel import get_channel
from app.content.service import load_version, recompute_hash, transition
from app.database.enums import ApprovalAction, ContentStatus, MediaKind, PublishingJobStatus, QAStatus
from app.database.models import ApprovalEvent, ContentItem, ContentVersion, MediaAsset, PublishingJob, PublishingResult, User
from app.database.session import session_scope, utcnow
from app.media.assets import IntegrityError, fetch_verified
from app.monitoring.alerts import notify_owner
from app.monitoring.audit import audit
from app.monitoring.logging import get_logger
from app.monitoring.metrics import PUBLICATIONS
from app.orchestration.queue import Reschedule
from app.orchestration.services import Services
from app.providers.telegram.client import InputFile, TelegramError
from app.security.rbac import Permission, has_permission
from app.settings.channel import FORMATS_WITH_IMAGE, FORMATS_WITH_VIDEO

log = get_logger(__name__)
INVALIDATING = {ApprovalAction.invalidated, ApprovalAction.reject, ApprovalAction.cancel, ApprovalAction.request_changes,
                ApprovalAction.regenerate_text, ApprovalAction.regenerate_video}


@dataclass
class Readiness:
    blockers: list[str] = field(default_factory=list)
    wait: str | None = None  # причина подождать (время не наступило, очередь на паузе)
    version: ContentVersion | None = None
    media: dict[str, MediaAsset] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.blockers and self.wait is None


async def check_publishable(session: AsyncSession, item: ContentItem, *, now: datetime | None = None) -> Readiness:
    """Все условия публикации. Любой пункт blockers запрещает публикацию."""
    now = now or utcnow()
    r = Readiness()
    channel = await get_channel(session)
    if channel.row.publishing_paused:
        r.wait = "очередь публикаций приостановлена"
    status = ContentStatus(item.status)
    if status == ContentStatus.cancelled:
        r.blockers.append("материал отменён")
        return r
    if status not in {ContentStatus.scheduled, ContentStatus.publishing}:
        r.blockers.append(f"материал в статусе «{status}», а не «scheduled»")
    if item.approved_version_id is None or not item.approved_content_hash:
        r.blockers.append("материал не одобрен")
        return r
    if item.current_version_id != item.approved_version_id:
        r.blockers.append("материал изменён после одобрения")
        return r
    version = await load_version(session, item.approved_version_id)
    if version is None or version.frozen_at is None:
        r.blockers.append("одобренная версия не найдена или не заморожена")
        return r
    r.version = version
    actual_hash = await recompute_hash(session, item, version.id)
    if actual_hash != item.approved_content_hash or version.content_hash != item.approved_content_hash:
        r.blockers.append("содержимое изменено после одобрения: контрольная сумма не совпадает")
    if QAStatus(version.qa_status) not in {QAStatus.passed, QAStatus.needs_review}:
        r.blockers.append("обязательные проверки не пройдены")

    events = (await session.execute(
        select(ApprovalEvent).where(ApprovalEvent.item_id == item.id).order_by(ApprovalEvent.created_at)
    )).scalars().all()
    approval = next((e for e in reversed(events) if e.action == ApprovalAction.approve and e.version_id == version.id), None)
    if approval is None or approval.content_hash != item.approved_content_hash:
        r.blockers.append("нет записи об одобрении этой версии")
    else:
        later = [e for e in events if e.created_at > approval.created_at and e.action in INVALIDATING]
        if later:
            r.blockers.append(f"после одобрения было действие «{later[0].action}»")
        approver = await session.get(User, approval.actor_user_id) if approval.actor_user_id else None
        if approver is None or not approver.is_active or not has_permission(approver.role, Permission.content_approve):
            r.blockers.append("одобривший пользователь больше не имеет права одобрять публикации")

    for link in version.media_links:
        r.media[link.role] = link.asset
    if item.format in FORMATS_WITH_IMAGE | FORMATS_WITH_VIDEO and "primary" not in r.media:
        r.blockers.append("нет готового медиафайла")
    if item.scheduled_at is None:
        r.blockers.append("не назначено время публикации")
    elif item.scheduled_at > now:
        r.wait = r.wait or "время публикации не наступило"
    return r


def _thumbnail_jpeg(png: bytes) -> bytes:
    # Требования Bot API к превью: JPEG, до 200 КБ, сторона до 320 px.
    img = Image.open(io.BytesIO(png)).convert("RGB")
    img.thumbnail((320, 320))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=85)
    return out.getvalue()


@dataclass
class Prepared:
    files: dict[str, bytes] = field(default_factory=dict)


async def _prepare_media(services: Services, readiness: Readiness) -> Prepared:
    prepared = Prepared()
    for role, asset in readiness.media.items():
        prepared.files[role] = await fetch_verified(services.storage, asset)
    return prepared


async def _send(services: Services, chat_id: str, item_format: str, version: ContentVersion, media: dict[str, MediaAsset],
                files: dict[str, bytes], sent: list[dict]) -> None:
    tg = services.require_telegram()
    disable_preview = (version.publish_options or {}).get("disable_preview", True)
    if item_format == "poll":
        poll = version.poll or {}
        if version.body_html.strip():
            sent.append(await tg.send_message(chat_id, version.body_html, disable_preview=disable_preview))
        sent.append(await tg.send_poll(chat_id, poll["question"], poll["options"],
                                       allows_multiple_answers=bool(poll.get("allows_multiple_answers"))))
        return
    caption = caption_text(version)
    if item_format in FORMATS_WITH_VIDEO:
        video = media["primary"]
        thumb = files.get("thumbnail")
        sent.append(await tg.send_video(
            chat_id, InputFile("video.mp4", files["primary"], video.mime_type), caption=caption, width=video.width,
            height=video.height, duration=int(video.duration_s or 0) or None,
            thumbnail=InputFile("thumb.jpg", _thumbnail_jpeg(thumb), "image/jpeg") if thumb else None,
        ))
        return
    if item_format in FORMATS_WITH_IMAGE:
        image = media["primary"]
        sent.append(await tg.send_photo(chat_id, InputFile(f"image.{image.mime_type.split('/')[-1]}", files["primary"], image.mime_type),
                                        caption=caption))
        return
    sent.append(await tg.send_message(chat_id, caption, disable_preview=disable_preview))


async def publish_item(services: Services, item_id: uuid.UUID) -> str:
    # Шаг 0: предварительные проверки и загрузка файлов с проверкой контрольных сумм (без блокировок).
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        if item is None:
            return "материал не найден"
        readiness = await check_publishable(session, item)
        if readiness.wait and not readiness.blockers:
            return readiness.wait
    if readiness.blockers:
        await _block(item_id, readiness.blockers)
        return "; ".join(readiness.blockers)
    try:
        prepared = await _prepare_media(services, readiness)
    except IntegrityError as exc:
        await _block(item_id, [f"медиафайл недоступен или изменён: {exc}"])
        return str(exc)

    # Шаг 1: повторная проверка под блокировкой и перевод в «sending».
    async with session_scope() as session:
        item = (await session.execute(select(ContentItem).where(ContentItem.id == item_id).with_for_update())).scalar_one()
        job = (await session.execute(select(PublishingJob).where(PublishingJob.version_id == item.approved_version_id)
                                     .with_for_update())).scalar_one_or_none()
        if job is None:
            return "нет задания публикации"
        if job.status != PublishingJobStatus.pending:
            # Повторная доставка задачи: публикация уже идёт, завершена или требует ручной проверки.
            return f"задание в статусе {job.status}"
        readiness = await check_publishable(session, item)
        if readiness.blockers or readiness.wait:
            if readiness.blockers:
                job.status = PublishingJobStatus.cancelled
                job.last_error = "; ".join(readiness.blockers)
            return "; ".join(readiness.blockers) or readiness.wait or ""
        if any(readiness.media[role].sha256 != asset.sha256 for role, asset in readiness.media.items()):
            return "медиа изменились"
        channel = await get_channel(session)
        chat_id = channel.row.telegram_channel_id or services.settings.telegram_channel_id
        if not chat_id:
            job.last_error = "не задан канал (TELEGRAM_CHANNEL_ID)"
            return job.last_error
        job.status = PublishingJobStatus.sending
        job.attempts += 1
        job.started_at = utcnow()
        await transition(session, item, ContentStatus.publishing)
        version, media, job_id, item_format = readiness.version, readiness.media, job.id, item.format

    # Шаг 2: отправка.
    sent: list[dict] = []
    assert version is not None
    try:
        await _send(services, str(chat_id), item_format, version, media, prepared.files, sent)
    except TelegramError as exc:
        return await _on_send_error(item_id, job_id, exc, sent, str(chat_id))

    # Шаг 3: фиксация результата.
    async with session_scope() as session:
        job = await session.get(PublishingJob, job_id, with_for_update=True)
        item = await session.get(ContentItem, item_id, with_for_update=True)
        assert job is not None and item is not None
        ids = [m["message_id"] for m in sent]
        session.add(PublishingResult(publishing_job_id=job.id, item_id=item.id, chat_id=str(chat_id), primary_message_id=ids[-1],
                                     message_ids=ids, published_at=utcnow(),
                                     response={"messages": [{"message_id": m["message_id"], "date": m.get("date")} for m in sent],
                                               "poll_id": next((m["poll"]["id"] for m in sent if m.get("poll")), None)}))
        job.status = PublishingJobStatus.succeeded
        job.finished_at = utcnow()
        job.last_error = None
        item.published_at = utcnow()
        await transition(session, item, ContentStatus.published)
        await audit(session, "publishing.published", entity_type="content_item", entity_id=item.id, message_ids=ids, chat_id=str(chat_id))
        await notify_owner(session, key=f"published:{item.id}", kind="info",
                           text=f"✅ Опубликовано: «{version.title[:120]}» (сообщение {ids[-1]}).")
    PUBLICATIONS.labels("ok").inc()
    return f"опубликовано, message_id={ids[-1]}"


async def _on_send_error(item_id: uuid.UUID, job_id: uuid.UUID, exc: TelegramError, sent: list[dict], chat_id: str) -> str:
    async with session_scope() as session:
        job = await session.get(PublishingJob, job_id, with_for_update=True)
        item = await session.get(ContentItem, item_id, with_for_update=True)
        assert job is not None and item is not None
        job.last_error = f"{exc.error_code or ''} {exc.description}".strip()
        if sent:
            # Часть сообщений уже в канале: фиксируем их и не повторяем автоматически.
            ids = [m["message_id"] for m in sent]
            session.add(PublishingResult(publishing_job_id=job.id, item_id=item.id, chat_id=chat_id, primary_message_id=ids[-1],
                                         message_ids=ids, published_at=utcnow(), response={"partial": True}))
            job.status = PublishingJobStatus.uncertain
            await transition(session, item, ContentStatus.failed, reason="опубликована только часть сообщений")
            item.last_error = f"опубликована часть сообщений ({ids}); ошибка: {exc.description}"
            outcome = "partial"
        elif not exc.request_sent or exc.error_code == 429:
            # Запрос не дошёл до Telegram или отклонён лимитом — повтор безопасен.
            job.status = PublishingJobStatus.pending
            await transition(session, item, ContentStatus.scheduled, reason="повтор публикации")
            outcome = "retry"
        elif exc.request_sent and exc.error_code is None:
            job.status = PublishingJobStatus.uncertain
            await transition(session, item, ContentStatus.failed, reason="ответ Telegram не получен")
            item.last_error = "ответ Telegram не получен: проверьте канал вручную, автоматический повтор отключён"
            outcome = "uncertain"
        else:
            job.status = PublishingJobStatus.failed
            job.finished_at = utcnow()
            await transition(session, item, ContentStatus.failed, reason=exc.description)
            item.last_error = f"Telegram отклонил публикацию: {exc.description}"
            outcome = "failed"
        await audit(session, "publishing.error", entity_type="content_item", entity_id=item.id, outcome=outcome, error=job.last_error)
        if outcome != "retry":
            await notify_owner(session, key=f"publish-error:{job.id}:{job.attempts}", kind="error",
                               text=f"❗ Публикация {str(item.id)[:8]} не выполнена ({outcome}): {exc.description}")
    PUBLICATIONS.labels(outcome).inc()
    if outcome == "retry":
        raise Reschedule(exc.retry_after or 60, f"Telegram: {exc.description}")
    return outcome


async def _block(item_id: uuid.UUID, reasons: list[str]) -> None:
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id, with_for_update=True)
        if item is None or ContentStatus(item.status) != ContentStatus.scheduled:
            return
        jobs = (await session.execute(select(PublishingJob).where(PublishingJob.item_id == item_id,
                                                                  PublishingJob.status == PublishingJobStatus.pending))).scalars()
        for job in jobs:
            job.status = PublishingJobStatus.cancelled
            job.last_error = "; ".join(reasons)
        await transition(session, item, ContentStatus.failed, reason="; ".join(reasons))
        item.last_error = "Публикация запрещена: " + "; ".join(reasons)
        await notify_owner(session, key=f"publish-blocked:{item_id}:{utcnow():%Y%m%d%H}", kind="error",
                           text=f"⛔ Публикация {str(item_id)[:8]} остановлена: " + "; ".join(reasons))


async def due_items(session: AsyncSession, now: datetime | None = None) -> list[uuid.UUID]:
    now = now or utcnow()
    rows = await session.execute(select(ContentItem.id).where(ContentItem.status == ContentStatus.scheduled,
                                                              ContentItem.scheduled_at <= now).order_by(ContentItem.scheduled_at).limit(20))
    return [r[0] for r in rows]


__all__ = ["MediaKind", "check_publishable", "due_items", "publish_item"]
