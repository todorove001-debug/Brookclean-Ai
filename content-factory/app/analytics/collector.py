"""Сбор статистики. Только то, что реально доступно:

- Bot API: число подписчиков (getChatMemberCount); реакции на посты канала приходят обновлениями
  message_reaction_count (бот должен быть администратором канала); итоги опросов, отправленных ботом, —
  обновлениями poll.
- Отслеживаемые ссылки /r/<код>: число переходов.
- Просмотры и пересылки Bot API не отдаёт. Их можно получить через MTProto (Telethon) от имени
  пользователя-администратора — необязательный модуль, включается настройками MTPROTO_*.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select

from app.content.channel import get_channel
from app.database.models import AnalyticsSnapshot, LinkClick, PublishingResult, TrackedLink
from app.database.session import session_scope, utcnow
from app.monitoring.logging import get_logger
from app.orchestration.services import Services
from app.providers.telegram.client import TelegramError

log = get_logger(__name__)


async def collect_subscribers(services: Services) -> int | None:
    if services.telegram is None:
        return None
    async with session_scope() as session:
        channel = await get_channel(session)
        chat_id = channel.row.telegram_channel_id or services.settings.telegram_channel_id
    if not chat_id:
        return None
    try:
        count = await services.telegram.get_chat_member_count(chat_id)
    except TelegramError as exc:
        log.warning("analytics.subscribers_failed", error=exc.description)
        return None
    async with session_scope() as session:
        session.add(AnalyticsSnapshot(channel_id=channel.id, source="bot_api", subscribers=int(count)))
    return int(count)


async def collect_link_clicks(services: Services, days: int = 30) -> int:
    since = utcnow() - timedelta(days=days)
    async with session_scope() as session:
        channel = await get_channel(session)
        rows = (
            await session.execute(
                select(TrackedLink.item_id, TrackedLink.id, func.count(LinkClick.id))
                .join(LinkClick, LinkClick.link_id == TrackedLink.id, isouter=True)
                .where(TrackedLink.item_id.is_not(None), TrackedLink.created_at >= since)
                .group_by(TrackedLink.item_id, TrackedLink.id)
            )
        ).all()
        per_item: dict[Any, int] = {}
        for item_id, _link_id, clicks in rows:
            per_item[item_id] = per_item.get(item_id, 0) + int(clicks)
        for item_id, clicks in per_item.items():
            session.add(
                AnalyticsSnapshot(
                    channel_id=channel.id, item_id=item_id, source="tracked_links", link_clicks=clicks
                )
            )
    return len(per_item)


async def collect_mtproto(services: Services, days: int = 14) -> int:
    """Просмотры и пересылки через MTProto. Возвращает число обновлённых сообщений; 0 — модуль не настроен."""
    s = services.settings
    if not (s.mtproto_api_id and s.mtproto_api_hash and s.mtproto_session_path):
        return 0
    try:
        from telethon import TelegramClient  # type: ignore[import-not-found]
    except ImportError:
        log.warning("analytics.mtproto_not_installed")
        return 0
    async with session_scope() as session:
        channel = await get_channel(session)
        results = (
            (
                await session.execute(
                    select(PublishingResult).where(
                        PublishingResult.published_at >= utcnow() - timedelta(days=days)
                    )
                )
            )
            .scalars()
            .all()
        )
        chat_id = channel.row.telegram_channel_id or s.telegram_channel_id
    if not results or not chat_id:
        return 0
    client = TelegramClient(str(s.mtproto_session_path), s.mtproto_api_id, s.secret("mtproto_api_hash"))
    await client.connect()
    try:
        if not await client.is_user_authorized():
            log.warning("analytics.mtproto_unauthorized")
            return 0
        entity = await client.get_entity(int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id)
        by_id = {r.primary_message_id: r for r in results}
        messages = await client.get_messages(entity, ids=list(by_id))
        updated = 0
        async with session_scope() as session:
            for msg in messages:
                if msg is None:
                    continue
                reactions = {}
                if getattr(msg, "reactions", None) and msg.reactions.results:
                    for rc in msg.reactions.results:
                        key = getattr(rc.reaction, "emoticon", None) or str(
                            getattr(rc.reaction, "document_id", "?")
                        )
                        reactions[key] = rc.count
                session.add(
                    AnalyticsSnapshot(
                        channel_id=channel.id,
                        item_id=by_id[msg.id].item_id,
                        message_id=msg.id,
                        source="mtproto",
                        views=msg.views,
                        forwards=msg.forwards,
                        reactions=reactions or None,
                        reactions_total=sum(reactions.values()) if reactions else None,
                    )
                )
                updated += 1
        return updated
    finally:
        await client.disconnect()


async def store_poll_update(poll: dict[str, Any]) -> bool:
    """Обновление poll от Bot API: итоги опроса, отправленного ботом."""
    async with session_scope() as session:
        result = (
            await session.execute(
                select(PublishingResult).where(PublishingResult.response["poll_id"].astext == poll["id"])
            )
        ).scalar_one_or_none()
        if result is None:
            return False
        channel = await get_channel(session)
        options = {o["text"]: o.get("voter_count", 0) for o in poll.get("options") or []}
        session.add(
            AnalyticsSnapshot(
                channel_id=channel.id,
                item_id=result.item_id,
                message_id=result.primary_message_id,
                source="bot_api",
                raw={
                    "poll": {
                        "total_voter_count": poll.get("total_voter_count"),
                        "options": options,
                        "is_closed": poll.get("is_closed"),
                    }
                },
            )
        )
        return True
