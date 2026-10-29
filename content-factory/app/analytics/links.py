"""Отслеживаемые ссылки /r/<код>: считаем переходы без сохранения IP и User-Agent."""

from __future__ import annotations

import secrets
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import LinkClick, TrackedLink
from app.security.ssrf import UnsafeURLError, validate_url_syntax
from app.settings.config import get_settings


def public_url(code: str) -> str:
    return f"{get_settings().public_base_url.rstrip('/')}/r/{code}"


async def create_link(session: AsyncSession, target_url: str, *, item_id: uuid.UUID | None, label: str | None) -> TrackedLink:
    if not target_url.startswith("tg://"):
        validate_url_syntax(target_url)  # только http/https на стандартных портах
    for _ in range(5):
        code = secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")[:8]
        exists = (await session.execute(select(TrackedLink.id).where(TrackedLink.code == code))).first()
        if not exists:
            link = TrackedLink(code=code, target_url=target_url, item_id=item_id, label=label)
            session.add(link)
            await session.flush()
            return link
    raise RuntimeError("не удалось подобрать уникальный код ссылки")


async def register_click(session: AsyncSession, code: str) -> str | None:
    link = (await session.execute(select(TrackedLink).where(TrackedLink.code == code))).scalar_one_or_none()
    if link is None:
        return None
    await session.execute(update(TrackedLink).where(TrackedLink.id == link.id).values(clicks=TrackedLink.clicks + 1))
    session.add(LinkClick(link_id=link.id))
    return link.target_url


__all__ = ["UnsafeURLError", "create_link", "public_url", "register_click"]
