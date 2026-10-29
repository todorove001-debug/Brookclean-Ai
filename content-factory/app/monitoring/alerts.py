"""Уведомления владельцу. Запись создаётся в транзакции вызывающего кода, отправка — фоновой задачей."""

from __future__ import annotations

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import Notification
from app.security.redaction import redact_text


async def notify_owner(session: AsyncSession, *, key: str, text: str, kind: str = "info") -> bool:
    """Ставит уведомление. Повторный вызов с тем же ключом ничего не делает. True — уведомление новое."""
    from app.orchestration.queue import enqueue

    stmt = (
        insert(Notification)
        .values(key=key[:200], kind=kind, text=redact_text(text)[:3500])
        .on_conflict_do_nothing(index_elements=["key"])
        .returning(Notification.id)
    )
    notification_id = (await session.execute(stmt)).scalar_one_or_none()
    if notification_id is None:
        return False
    await enqueue(session, "notify.send", {"notification_id": str(notification_id)}, max_attempts=8)
    return True
