"""Административный Telegram-бот: согласование, план, очередь, статусы, расходы, ошибки.

Авторизация — только по числовому Telegram user ID из таблицы users (username не используется).
Каждая кнопка содержит ID версии: действие над устаревшей версией отклоняется сервисом согласования.
Обновления принимаются long polling или вебхуком (FastAPI, проверка секретного заголовка).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import String, cast, delete, func, select

from app.analytics.collector import store_poll_update
from app.approval import render
from app.approval import service as approval
from app.content.channel import get_channel
from app.content.service import load_version
from app.database.enums import ContentStatus, MediaKind, UserRole
from app.database.models import (
    AnalyticsSnapshot,
    BotConversation,
    BotState,
    ContentItem,
    ContentVersion,
    PublishingResult,
    ResearchSource,
    User,
    VideoJob,
)
from app.database.session import session_scope, utcnow
from app.media.assets import IntegrityError, fetch_verified, temp_dir
from app.media.intake import IntakeError, accept_file
from app.monitoring.audit import audit
from app.monitoring.logging import get_logger
from app.monitoring.summary import costs_summary, errors_summary
from app.orchestration.queue import enqueue
from app.orchestration.services import Services
from app.providers.telegram.client import InputFile, TelegramBotClient, TelegramError
from app.publishing.slots import next_free_slot
from app.security.rbac import Permission, has_permission
from app.security.telegram_html import escape

log = get_logger(__name__)
ALLOWED_UPDATES = ["message", "callback_query", "message_reaction_count", "poll"]
CONVERSATION_TTL = timedelta(minutes=30)


class ApprovalBot:
    def __init__(self, services: Services):
        self.services = services
        self.tg: TelegramBotClient = services.require_telegram()

    # --- Вход ---
    async def handle_update(self, update: dict[str, Any]) -> None:
        try:
            if "message_reaction_count" in update:
                await self._reactions(update["message_reaction_count"])
            elif "poll" in update:
                await store_poll_update(update["poll"])
            elif "callback_query" in update:
                await self._callback(update["callback_query"])
            elif "message" in update:
                await self._message(update["message"])
        except TelegramError as exc:
            log.warning("bot.telegram_error", error=exc.description)
        except Exception as exc:  # noqa: BLE001 — одно обновление не должно останавливать бота
            log.exception("bot.update_failed", error=str(exc))

    async def _user(self, tg_user: dict[str, Any]) -> User | None:
        async with session_scope() as session:
            user = (
                await session.execute(
                    select(User).where(User.telegram_user_id == int(tg_user["id"]), User.is_active.is_(True))
                )
            ).scalar_one_or_none()
            if user is None:
                await audit(
                    session,
                    "bot.unauthorized",
                    actor_type="telegram",
                    actor_id=str(tg_user.get("id")),
                    username=tg_user.get("username"),
                )
            elif tg_user.get("username") != user.telegram_username:
                user.telegram_username = tg_user.get("username")
            return user

    async def _message(self, message: dict[str, Any]) -> None:
        chat = message.get("chat") or {}
        if chat.get("type") != "private" or "from" not in message:
            return
        user = await self._user(message["from"])
        if user is None:
            await self.tg.send_message(chat["id"], "Нет доступа. Обратитесь к владельцу канала.")
            return
        incoming = incoming_media(message)
        if incoming is not None and incoming.get("unsupported"):
            await self.tg.send_message(chat["id"], "Принимаю только видео и фото.")
            return
        if incoming is not None:
            await self._upload(chat["id"], user, message, incoming)
            return
        text = (message.get("text") or "").strip()
        if text.startswith("/"):
            command, _, arg = text.partition(" ")
            await self._command(chat["id"], user, command.split("@")[0].lower(), arg.strip())
            return
        await self._conversation_reply(chat["id"], user, text)

    # --- Загрузка съёмок в библиотеку ---
    async def _upload(self, chat_id: int, user: User, message: dict[str, Any], media: dict[str, Any]) -> None:
        if not has_permission(user.role, Permission.media_write):
            await self.tg.send_message(chat_id, "Недостаточно прав для загрузки файлов.")
            return
        settings = self.services.settings
        panel = f"{settings.public_base_url.rstrip('/')}/admin/"
        if (media.get("file_size") or 0) > TelegramBotClient.BOT_DOWNLOAD_LIMIT:
            await self.tg.send_message(
                chat_id,
                "Файл больше 20 МБ — Telegram не позволяет ботам скачивать такие файлы.\n"
                f"Загрузите его через панель: {escape(panel)} → «Загрузка» (до {settings.max_upload_mb} МБ).",
            )
            return
        caption = (message.get("caption") or "").strip()
        try:
            info = await self.tg.get_file(media["file_id"])
            with temp_dir(settings.work_dir, "tg-") as tmp:
                path = Path(tmp) / "upload.bin"
                await self.tg.download_file(
                    info["file_path"], path, max_bytes=TelegramBotClient.BOT_DOWNLOAD_LIMIT
                )
                async with session_scope() as session:
                    asset = await accept_file(
                        session,
                        self.services.storage,
                        settings,
                        path,
                        user=user,
                        purpose="source",
                        title=caption[:300] or None,
                        confirm_rights=True,
                        channel="telegram",
                        rights={"license": "own", "notes": "загружено владельцем через Telegram-бота"},
                    )
        except IntakeError as exc:
            await self.tg.send_message(chat_id, f"Файл не принят: {escape(str(exc))}")
            return
        except TelegramError as exc:
            await self.tg.send_message(
                chat_id, f"Не удалось получить файл из Telegram: {escape(exc.description)}"
            )
            return
        what = "Видео" if asset.kind == MediaKind.source_video else "Фото"
        details = []
        if asset.duration_s:
            details.append(f"{int(asset.duration_s // 60)}:{int(asset.duration_s % 60):02d}")
        if asset.width and asset.height:
            details.append(f"{asset.width}×{asset.height}")
        lines = [
            f"✅ {what} сохранено в библиотеку съёмок" + (f" ({', '.join(details)})" if details else "") + "."
        ]
        if caption:
            lines.append(f"Описание: {escape(caption[:200])}")
        else:
            lines.append(
                "Совет: подписывайте файлы — что снято (погрузка, крепление, в пути, выдача). "
                "Так монтаж точнее подберёт кадры к сценарию."
            )
        if not asset.rights_confirmed:
            lines.append("Права на файл подтвердит владелец — до этого он не используется в публикациях.")
        if asset.kind == MediaKind.source_image and (asset.width or 0) < 800:
            lines.append("Фото маленького размера: для обложек отправляйте его «файлом», без сжатия.")
        await self.tg.send_message(chat_id, "\n".join(lines))

    # --- Команды ---
    async def _command(self, chat_id: int, user: User, command: str, arg: str) -> None:
        handlers = {
            "/start": self._help,
            "/help": self._help,
            "/drafts": self._drafts,
            "/item": self._item,
            "/plan": self._plan,
            "/newplan": self._newplan,
            "/queue": self._queue,
            "/status": self._status,
            "/costs": self._costs,
            "/errors": self._errors,
            "/pause": self._pause,
            "/resume": self._resume,
            "/idea": self._idea,
            "/story": self._story,
        }
        handler = handlers.get(command)
        if handler is None:
            await self.tg.send_message(chat_id, "Неизвестная команда. /help — список команд.")
            return
        await handler(chat_id, user, arg)

    async def _help(self, chat_id: int, user: User, arg: str) -> None:
        await self.tg.send_message(chat_id, render.HELP)

    async def _find(self, session, ref: str) -> ContentItem | None:  # noqa: ANN001
        ref = ref.strip().replace("-", "").lower()
        if len(ref) < 6 or not all(c in "0123456789abcdef" for c in ref):
            return None
        rows = (
            (
                await session.execute(
                    select(ContentItem)
                    .where(func.replace(cast(ContentItem.id, String), "-", "").like(f"{ref}%"))
                    .limit(2)
                )
            )
            .scalars()
            .all()
        )
        return rows[0] if len(rows) == 1 else None

    async def _drafts(self, chat_id: int, user: User, arg: str) -> None:
        async with session_scope() as session:
            channel = await get_channel(session)
            rows = (
                (
                    await session.execute(
                        select(ContentItem)
                        .where(ContentItem.status == ContentStatus.awaiting_approval)
                        .order_by(ContentItem.planned_at)
                        .limit(20)
                    )
                )
                .scalars()
                .all()
            )
        if not rows:
            await self.tg.send_message(chat_id, "Черновиков на согласовании нет.")
            return
        tz = channel.settings.schedule.timezone
        keyboard = {
            "inline_keyboard": [
                [
                    {
                        "text": f"{render.local(r.planned_at, tz)} · {render.FORMAT_RU.get(r.format, r.format)} · {r.topic[:40]}",
                        "callback_data": f"op:{r.id.hex}",
                    }
                ]
                for r in rows
            ]
        }
        await self.tg.send_message(chat_id, f"Ждут согласования: {len(rows)}", reply_markup=keyboard)

    async def _item(self, chat_id: int, user: User, arg: str) -> None:
        async with session_scope() as session:
            item = await self._find(session, arg)
        if item is None:
            await self.tg.send_message(chat_id, "Материал не найден. Укажите первые 8 символов ID.")
            return
        await self.send_draft(item.id, item.current_version_id, chat_ids=[chat_id])

    async def _plan(self, chat_id: int, user: User, arg: str) -> None:
        days = 30 if arg.strip() == "30" else 7
        async with session_scope() as session:
            channel = await get_channel(session)
            tz = channel.settings.schedule.timezone
            now = utcnow()
            rows = (
                (
                    await session.execute(
                        select(ContentItem)
                        .where(
                            ContentItem.planned_at >= now - timedelta(hours=12),
                            ContentItem.planned_at < now + timedelta(days=days),
                            ContentItem.status.not_in([ContentStatus.cancelled, ContentStatus.rejected]),
                        )
                        .order_by(ContentItem.planned_at)
                    )
                )
                .scalars()
                .all()
            )
        if not rows:
            await self.tg.send_message(chat_id, f"План на {days} дней пуст. /newplan {days} — составить.")
            return
        lines = [f"<b>План на {days} дней</b> ({tz})"]
        current_day = None
        for r in rows:
            when = r.scheduled_at or r.planned_at
            day = when.astimezone(ZoneInfo(tz)).strftime("%a %d.%m") if when else "—"
            if day != current_day:
                lines.append(f"\n<b>{day}</b>")
                current_day = day
            lines.append(
                f"{render.local(when, tz)[-5:]} {render.FORMAT_RU.get(r.format, r.format)} · "
                f"{render.STATUS_RU.get(r.status, r.status)} · {escape(r.topic[:60])} <code>{render.short(r.id)}</code>"
            )
        text = "\n".join(lines)
        for i in range(0, len(text), 3900):
            await self.tg.send_message(chat_id, text[i : i + 3900])

    async def _newplan(self, chat_id: int, user: User, arg: str) -> None:
        if not has_permission(user.role, Permission.content_write):
            await self.tg.send_message(chat_id, "Недостаточно прав.")
            return
        days = 30 if arg.strip() == "30" else 7
        async with session_scope() as session:
            await enqueue(
                session,
                "plan.generate",
                {"horizon_days": days},
                dedup_key=f"plan.generate:{days}",
                max_attempts=2,
            )
            await audit(
                session, "plan.requested", actor_type="user", actor_id=str(user.id), horizon_days=days
            )
        await self.tg.send_message(chat_id, f"Составляю план на {days} дней. Пришлю, когда будет готов.")

    async def _queue(self, chat_id: int, user: User, arg: str) -> None:
        async with session_scope() as session:
            channel = await get_channel(session)
            rows = (
                (
                    await session.execute(
                        select(ContentItem)
                        .where(ContentItem.status == ContentStatus.scheduled)
                        .order_by(ContentItem.scheduled_at)
                        .limit(40)
                    )
                )
                .scalars()
                .all()
            )
        tz = channel.settings.schedule.timezone
        head = (
            "⏸ Очередь на паузе. " + (channel.row.paused_reason or "")
            if channel.row.publishing_paused
            else "▶️ Очередь активна."
        )
        lines = [
            head,
            *[
                f"{render.local(r.scheduled_at, tz)} · {render.FORMAT_RU.get(r.format, r.format)} · {escape(r.topic[:60])} "
                f"<code>{render.short(r.id)}</code>"
                for r in rows
            ],
        ]
        if not rows:
            lines.append("Запланированных публикаций нет.")
        await self.tg.send_message(chat_id, "\n".join(lines))

    async def _status(self, chat_id: int, user: User, arg: str) -> None:
        async with session_scope() as session:
            item = await self._find(session, arg)
            if item is None:
                await self.tg.send_message(chat_id, "Материал не найден.")
                return
            channel = await get_channel(session)
            tz = channel.settings.schedule.timezone
            version = await load_version(session, item.current_version_id)
            jobs = (
                (
                    await session.execute(
                        select(VideoJob).where(VideoJob.item_id == item.id).order_by(VideoJob.created_at)
                    )
                )
                .scalars()
                .all()
            )
            result = (
                await session.execute(select(PublishingResult).where(PublishingResult.item_id == item.id))
            ).scalar_one_or_none()
        lines = [
            f"<b>{escape(item.topic[:150])}</b> <code>{render.short(item.id)}</code>",
            f"Статус: {render.STATUS_RU.get(item.status, item.status)} с {render.local(item.status_changed_at, tz)}",
            f"Формат: {render.FORMAT_RU.get(item.format, item.format)}; версия: {version.version_no if version else '—'}",
            f"План: {render.local(item.planned_at, tz)}; публикация: {render.local(item.scheduled_at, tz)}",
        ]
        if item.last_error:
            lines.append(f"Ошибка: {escape(item.last_error[:500])}")
        for j in jobs[-8:]:
            cost = f", ${j.actual_cost_usd or j.estimated_cost_usd or 0}" if j.kind == "ai_scene" else ""
            lines.append(
                f"🎬 {j.kind} {'сцена ' + str(j.scene_index + 1) if j.scene_index is not None else ''}: {j.status}{cost}"
                + (f" — {escape((j.error or '')[:150])}" if j.error else "")
            )
        if result is not None:
            lines.append(
                f"Опубликовано: сообщение {result.primary_message_id}, {render.local(result.published_at, tz)}"
            )
        await self.tg.send_message(chat_id, "\n".join(lines))

    async def _costs(self, chat_id: int, user: User, arg: str) -> None:
        if not has_permission(user.role, Permission.budget_read):
            await self.tg.send_message(chat_id, "Недостаточно прав.")
            return
        async with session_scope() as session:
            c = await costs_summary(session)
        lines = [
            f"<b>Расходы</b>\nСегодня: ${c['day_usd']:.2f} из ${c['daily_limit_usd']:.2f}",
            f"Месяц: ${c['month_usd']:.2f} из ${c['monthly_limit_usd']:.2f}",
            f"Генераций видео в месяце: {c['video_generations_month']} из {c['video_generations_limit']}",
            "",
            "За месяц по операциям:",
        ]
        lines += [
            f"• {r['provider']} / {r['operation']}: ${r['usd']:.2f} ({r['calls']})"
            for r in c["by_operation"][:12]
        ]
        if c["records_with_estimated_cost"]:
            lines.append(
                f"\nЗаписей с расчётной (не фактической) стоимостью: {c['records_with_estimated_cost']}"
            )
        await self.tg.send_message(chat_id, "\n".join(lines))

    async def _errors(self, chat_id: int, user: User, arg: str) -> None:
        async with session_scope() as session:
            e = await errors_summary(session)
        lines = ["<b>Ошибки за 7 дней</b>"]
        lines += [
            f"❗ <code>{i['id'][:8]}</code> {escape(i['topic'][:50])}: {escape((i['error'] or '')[:150])}"
            for i in e["failed_items"][:10]
        ]
        lines += [f"⚙️ задача {t['name']}: {t['count']}" for t in e["failed_tasks"]]
        lines += [
            f"🎬 {v['kind']} {v['status']}: {escape((v['error'] or '')[:120])}" for v in e["video_jobs"][:8]
        ]
        lines += [f"📤 публикация {p['status']}: {escape((p['error'] or '')[:120])}" for p in e["publishing"]]
        if len(lines) == 1:
            lines.append("Ошибок нет.")
        await self.tg.send_message(chat_id, "\n".join(lines)[:4000])

    async def _pause(self, chat_id: int, user: User, arg: str) -> None:
        async with session_scope() as session:
            try:
                text = await approval.set_paused(session, user, True, arg or "пауза из бота")
            except approval.ApprovalError as exc:
                text = str(exc)
        await self.tg.send_message(chat_id, text)

    async def _resume(self, chat_id: int, user: User, arg: str) -> None:
        async with session_scope() as session:
            try:
                text = await approval.set_paused(session, user, False)
            except approval.ApprovalError as exc:
                text = str(exc)
        await self.tg.send_message(chat_id, text)

    async def _idea(self, chat_id: int, user: User, arg: str, *, story: bool = False) -> None:
        if not has_permission(user.role, Permission.content_write):
            await self.tg.send_message(chat_id, "Недостаточно прав.")
            return
        if len(arg) < 10:
            await self.tg.send_message(chat_id, "Опишите тему подробнее (от 10 символов).")
            return
        async with session_scope() as session:
            channel = await get_channel(session)
            item = ContentItem(
                channel_id=channel.id,
                status=ContentStatus.idea,
                format="story" if story else "short_post",
                topic=arg[:300] if not story else f"История перевозки: {arg[:120]}",
                owner_brief=arg if story else None,
                rubric="cases" if story else None,
                created_by=f"user:{user.id}",
                planned_at=utcnow() + timedelta(days=channel.settings.schedule.production_lead_days),
            )
            session.add(item)
            await session.flush()
            await enqueue(
                session, "pipeline.advance", {"item_id": str(item.id)}, dedup_key=f"advance:{item.id}"
            )
            await audit(
                session,
                "content.created",
                actor_type="user",
                actor_id=str(user.id),
                entity_type="content_item",
                entity_id=item.id,
            )
        await self.tg.send_message(
            chat_id, f"Добавлено, ID <code>{render.short(item.id)}</code>. Пришлю черновик на согласование."
        )

    async def _story(self, chat_id: int, user: User, arg: str) -> None:
        await self._idea(chat_id, user, arg, story=True)

    # --- Кнопки ---
    async def _callback(self, query: dict[str, Any]) -> None:
        user = await self._user(query["from"])
        if user is None:
            await self.tg.answer_callback_query(query["id"], "Нет доступа", show_alert=True)
            return
        data = query.get("data") or ""
        chat_id = query["message"]["chat"]["id"] if query.get("message") else query["from"]["id"]
        code, _, rest = data.partition(":")
        try:
            if code == "op":
                async with session_scope() as session:
                    item = await session.get(ContentItem, uuid.UUID(hex=rest))
                await self.tg.answer_callback_query(query["id"])
                if item is not None:
                    await self.send_draft(item.id, item.current_version_id, chat_ids=[chat_id])
                return
            version_hex, _, extra = rest.partition(":")
            version_id = uuid.UUID(hex=version_hex)
        except ValueError:
            await self.tg.answer_callback_query(query["id"], "Некорректная кнопка", show_alert=True)
            return
        async with session_scope() as session:
            version = await session.get(ContentVersion, version_id)
            item_id = version.item_id if version else None
        if item_id is None:
            await self.tg.answer_callback_query(query["id"], "Версия не найдена", show_alert=True)
            return
        try:
            message = await self._apply_callback(code, user, item_id, version_id, extra, chat_id)
        except approval.ApprovalError as exc:
            await self.tg.answer_callback_query(query["id"], str(exc)[:190], show_alert=True)
            return
        await self.tg.answer_callback_query(query["id"], (message or "Готово")[:190])
        if message:
            await self.tg.send_message(chat_id, message)
        if code in {"ap", "rj"} and query.get("message"):
            try:
                await self.tg.edit_message_reply_markup(chat_id, query["message"]["message_id"], None)
            except TelegramError:
                pass

    async def _apply_callback(
        self, code: str, user: User, item_id: uuid.UUID, version_id: uuid.UUID, extra: str, chat_id: int
    ) -> str | None:
        if code == "ap":
            async with session_scope() as session:
                return (await approval.approve(session, user, item_id, version_id)).message
        if code == "rj":
            async with session_scope() as session:
                return (await approval.reject(session, user, item_id, version_id)).message
        if code == "rt":
            async with session_scope() as session:
                return (await approval.regenerate_text(session, user, item_id, version_id)).message
        if code in {"ed", "rv", "ct"}:
            if not has_permission(user.role, Permission.content_approve):
                raise approval.ApprovalError("недостаточно прав")
            kind = {"ed": "changes", "rv": "video", "ct": "time"}[code]
            async with session_scope() as session:
                await session.execute(
                    delete(BotConversation).where(BotConversation.telegram_user_id == user.telegram_user_id)
                )
                session.add(
                    BotConversation(
                        telegram_user_id=user.telegram_user_id,
                        kind=kind,
                        item_id=item_id,
                        version_id=version_id,
                        expires_at=utcnow() + CONVERSATION_TTL,
                    )
                )
            prompts = {
                "changes": "Напишите одним сообщением, что изменить в материале.",
                "video": "Напишите параметры пересборки, например: <code>формат 1:1, длительность 20, без ии, спокойнее и больше трассы</code>",
                "time": "Напишите время в формате <code>25.11 14:30</code>, <code>завтра 10:00</code> или <code>18:30</code>.",
            }
            await self.tg.send_message(chat_id, prompts[kind])
            return None
        if code == "rs":
            async with session_scope() as session:
                channel = await get_channel(session)
                occupied = await approval.occupied_times(session, exclude=item_id)
            sched = channel.settings.schedule
            slots, cursor = [], utcnow() + timedelta(minutes=30)
            for _ in range(6):
                slot = next_free_slot(sched, occupied + slots, preferred=cursor, not_before=cursor)
                if slot is None:
                    break
                slots.append(slot)
                cursor = slot + timedelta(minutes=sched.min_gap_minutes)
            await self.tg.send_message(
                chat_id,
                "Выберите время публикации:",
                reply_markup=render.slots_keyboard(version_id, slots, sched.timezone),
            )
            return None
        if code == "sl":
            when = datetime.fromtimestamp(int(extra, 16) * 60, tz=UTC)
            async with session_scope() as session:
                return (await approval.reschedule(session, user, item_id, version_id, when)).message
        raise approval.ApprovalError("неизвестное действие")

    async def _conversation_reply(self, chat_id: int, user: User, text: str) -> None:
        async with session_scope() as session:
            conv = await session.get(BotConversation, user.telegram_user_id)
            if conv is not None:
                await session.delete(conv)
        if conv is None or conv.expires_at < utcnow():
            await self.tg.send_message(chat_id, "Не понял. /help — список команд.")
            return
        if not text:
            await self.tg.send_message(chat_id, "Нужен текст.")
            return
        try:
            async with session_scope() as session:
                if conv.kind == "changes":
                    result = await approval.request_changes(
                        session, user, conv.item_id, conv.version_id, text
                    )
                elif conv.kind == "video":
                    params = render.parse_video_params(text)
                    result = await approval.regenerate_video(
                        session, user, conv.item_id, conv.version_id, params
                    )
                else:
                    channel = await get_channel(session)
                    when = render.parse_local_time(text, channel.settings.schedule.timezone, utcnow())
                    if when is None:
                        raise approval.ApprovalError("не удалось разобрать время")
                    result = await approval.reschedule(session, user, conv.item_id, conv.version_id, when)
            await self.tg.send_message(chat_id, result.message)
        except approval.ApprovalError as exc:
            await self.tg.send_message(chat_id, f"Не выполнено: {exc}")

    # --- Отправка черновика ---
    async def send_draft(
        self, item_id: uuid.UUID, version_id: uuid.UUID | None, *, chat_ids: list[int] | None = None
    ) -> None:
        from app.agents.qa import caption_text

        async with session_scope() as session:
            item = await session.get(ContentItem, item_id)
            version = await load_version(session, version_id)
            if item is None or version is None:
                return
            channel = await get_channel(session)
            sources = (
                (await session.execute(select(ResearchSource).where(ResearchSource.item_id == item_id)))
                .scalars()
                .all()
            )
            if chat_ids is None:
                chat_ids = [
                    u.telegram_user_id for u in await approval.approvers(session) if u.telegram_user_id
                ]
            media = {link.role: link.asset for link in version.media_links}
        tz = channel.settings.schedule.timezone
        limit = self.services.settings.telegram_max_upload_mb * 1024 * 1024
        for chat_id in chat_ids:
            primary = media.get("primary")
            try:
                if primary is not None:
                    data = await fetch_verified(self.services.storage, primary)
                    if primary.mime_type.startswith("video/") and primary.size_bytes <= limit:
                        await self.tg.send_video(
                            chat_id,
                            InputFile("preview.mp4", data, primary.mime_type),
                            caption=f"Видео к черновику {render.short(item.id)}",
                            width=primary.width,
                            height=primary.height,
                            duration=int(primary.duration_s or 0) or None,
                        )
                    elif primary.mime_type.startswith("image/"):
                        await self.tg.send_photo(
                            chat_id,
                            InputFile("preview.png", data, primary.mime_type),
                            caption=f"Изображение к черновику {render.short(item.id)}",
                        )
                    elif "thumbnail" in media:
                        thumb = await fetch_verified(self.services.storage, media["thumbnail"])
                        await self.tg.send_photo(
                            chat_id,
                            InputFile("thumb.png", thumb, "image/png"),
                            caption="Видео больше лимита Bot API — показано превью. Скачайте файл в панели.",
                        )
            except IntegrityError as exc:
                await self.tg.send_message(
                    chat_id, f"⚠️ Медиафайл не прошёл проверку целостности: {escape(str(exc))}"
                )
            if item.format == "poll" and version.poll:
                preview = f"<b>Опрос:</b> {escape(version.poll.get('question', ''))}\n" + "\n".join(
                    f"• {escape(o)}" for o in version.poll.get("options", [])
                )
                if version.body_html:
                    preview = version.body_html + "\n\n" + preview
            else:
                preview = caption_text(version)
            await self.tg.send_message(chat_id, preview[:4096], disable_preview=True)
            await self.tg.send_message(
                chat_id,
                render.draft_card(item, version, list(sources), tz),
                reply_markup=render.draft_keyboard(item, version)
                if ContentStatus(item.status) == ContentStatus.awaiting_approval
                else None,
            )

    # --- Статистика реакций (канал) ---
    async def _reactions(self, data: dict[str, Any]) -> None:
        chat_id = str((data.get("chat") or {}).get("id"))
        message_id = int(data["message_id"])
        reactions = {}
        for r in data.get("reactions") or []:
            kind = r.get("type") or {}
            key = kind.get("emoji") or kind.get("custom_emoji_id") or kind.get("type", "?")
            reactions[key] = int(r.get("total_count", 0))
        async with session_scope() as session:
            result = (
                await session.execute(
                    select(PublishingResult).where(PublishingResult.primary_message_id == message_id)
                )
            ).scalars()
            match = next(
                (r for r in result if r.chat_id == chat_id or chat_id.endswith(r.chat_id.lstrip("@"))), None
            )
            channel = await get_channel(session)
            session.add(
                AnalyticsSnapshot(
                    channel_id=channel.id,
                    item_id=match.item_id if match else None,
                    message_id=message_id,
                    source="bot_api",
                    reactions=reactions,
                    reactions_total=sum(reactions.values()),
                    raw=data,
                )
            )

    # --- Получение обновлений ---
    async def _offset(self) -> int | None:
        async with session_scope() as session:
            state = await session.get(BotState, "updates_offset")
            return int(state.value["offset"]) if state else None

    async def _save_offset(self, offset: int) -> None:
        async with session_scope() as session:
            state = await session.get(BotState, "updates_offset")
            if state is None:
                session.add(BotState(key="updates_offset", value={"offset": offset}))
            else:
                state.value = {"offset": offset}

    async def poll_forever(self, stop: asyncio.Event) -> None:
        await self.tg.delete_webhook()
        offset = await self._offset()
        log.info("bot.polling_started")
        while not stop.is_set():
            try:
                updates = await self.tg.get_updates(offset, timeout=25, allowed_updates=ALLOWED_UPDATES)
            except TelegramError as exc:
                log.warning("bot.get_updates_failed", error=exc.description)
                await asyncio.sleep(exc.retry_after or 5)
                continue
            for update in updates:
                await self.handle_update(update)
                offset = int(update["update_id"]) + 1
                # Смещение сохраняется после обработки: при перезапуске обновление не потеряется.
                await self._save_offset(offset)


def incoming_media(message: dict[str, Any]) -> dict[str, Any] | None:
    """Видео, фото или файл в сообщении. Для фото берётся самый крупный вариант."""
    if message.get("video"):
        return message["video"]
    if message.get("photo"):
        return max(message["photo"], key=lambda p: (p.get("file_size") or 0, p.get("width", 0)))
    document = message.get("document")
    if document and (document.get("mime_type") or "").split("/")[0] in {"video", "image"}:
        return document
    if document:
        return {**document, "unsupported": True}
    return None


async def ensure_bootstrap_users(services: Services) -> None:
    """Создаёт владельца и администраторов из переменных окружения при первом запуске."""
    settings = services.settings
    async with session_scope() as session:
        for tg_id, role in [(i, UserRole.owner) for i in settings.bootstrap_owner_telegram_ids] + [
            (i, UserRole.admin) for i in settings.bootstrap_admin_telegram_ids
        ]:
            exists = (
                await session.execute(select(User).where(User.telegram_user_id == tg_id))
            ).scalar_one_or_none()
            if exists is None:
                session.add(User(display_name=f"{role.value} {tg_id}", role=role, telegram_user_id=tg_id))
                await audit(session, "user.bootstrap", entity_type="user", entity_id=tg_id, role=role.value)
