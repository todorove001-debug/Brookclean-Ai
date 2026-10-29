"""Загрузка и изменение настроек канала, утверждённые факты о компании."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import ChannelConfig, CompanyFact
from app.settings.channel import ChannelSettings, load_channel_settings
from app.settings.config import get_settings

DEFAULT_SLUG = "main"


@dataclass(slots=True)
class Channel:
    row: ChannelConfig
    settings: ChannelSettings

    @property
    def id(self):  # noqa: ANN201
        return self.row.id


async def get_channel(session: AsyncSession, slug: str = DEFAULT_SLUG, *, for_update: bool = False) -> Channel:
    stmt = select(ChannelConfig).where(ChannelConfig.slug == slug)
    if for_update:
        stmt = stmt.with_for_update()
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        row = await bootstrap_channel(session, slug)
    return Channel(row=row, settings=ChannelSettings.model_validate(row.settings or {}))


async def bootstrap_channel(session: AsyncSession, slug: str = DEFAULT_SLUG) -> ChannelConfig:
    """Создаёт канал из YAML при первом запуске. Факты из YAML попадают в базу как неутверждённые."""
    app_settings = get_settings()
    channel_settings = load_channel_settings(app_settings.channel_config_path)
    row = ChannelConfig(
        slug=slug,
        name=channel_settings.name,
        telegram_channel_id=app_settings.telegram_channel_id,
        settings=channel_settings.model_dump(mode="json", exclude={"approved_facts"}),
    )
    session.add(row)
    await session.flush()
    for fact in channel_settings.approved_facts:
        session.add(
            CompanyFact(
                channel_id=row.id,
                category=fact.get("category", "other"),
                key=fact["key"],
                statement=fact["statement"],
            )
        )
    await session.flush()
    return row


async def save_channel_settings(session: AsyncSession, channel: Channel, new_settings: ChannelSettings) -> None:
    channel.row.settings = new_settings.model_dump(mode="json", exclude={"approved_facts"})
    channel.row.name = new_settings.name
    channel.settings = new_settings


async def approved_facts(session: AsyncSession, channel_id, today: date | None = None) -> list[CompanyFact]:  # noqa: ANN001
    """Только утверждённые, активные и не просроченные факты — единственный источник сведений о компании."""
    today = today or date.today()
    rows = (
        await session.execute(
            select(CompanyFact).where(
                CompanyFact.channel_id == channel_id,
                CompanyFact.is_active.is_(True),
                CompanyFact.approved_at.is_not(None),
            ).order_by(CompanyFact.category, CompanyFact.key)
        )
    ).scalars().all()
    return [f for f in rows if f.valid_until is None or f.valid_until >= today]
