"""Библиотека съёмок владельца: видео и фото, загруженные без привязки к конкретному посту.

Монтаж и обложки берут материалы отсюда, если у поста нет своих. Сначала — те, что использовались
реже всего, чтобы одни и те же кадры не повторялись из ролика в ролик.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.enums import MediaKind
from app.database.models import MediaAsset

DERIVED_KINDS = [MediaKind.render_video, MediaKind.cover, MediaKind.infographic]


async def usage_counts(session: AsyncSession, asset_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Сколько готовых роликов и обложек уже сделано из каждого исходника."""
    counts: dict[uuid.UUID, int] = {}
    for asset_id in asset_ids:
        counts[asset_id] = (
            await session.execute(
                select(func.count())
                .select_from(MediaAsset)
                .where(
                    MediaAsset.kind.in_(DERIVED_KINDS), MediaAsset.parent_asset_ids.contains([str(asset_id)])
                )
            )
        ).scalar_one()
    return counts


async def library(session: AsyncSession, kind: MediaKind, *, limit: int = 8) -> list[MediaAsset]:
    """Материалы библиотеки с подтверждёнными правами: сначала реже использованные, затем новые."""
    assets = list(
        (
            await session.execute(
                select(MediaAsset)
                .where(
                    MediaAsset.kind == kind,
                    MediaAsset.item_id.is_(None),
                    MediaAsset.rights_confirmed.is_(True),
                )
                .order_by(MediaAsset.created_at.desc())
                .limit(200)
            )
        ).scalars()
    )
    counts = await usage_counts(session, [a.id for a in assets])
    assets.sort(key=lambda a: (counts.get(a.id, 0), -a.created_at.timestamp()))
    return assets[:limit]


async def library_summary(session: AsyncSession, *, limit: int = 30) -> list[str]:
    """Короткие описания доступных съёмок — для контент-стратега."""
    rows = (
        await session.execute(
            select(MediaAsset.kind, MediaAsset.title, MediaAsset.duration_s)
            .where(
                MediaAsset.kind.in_([MediaKind.source_video, MediaKind.source_image]),
                MediaAsset.item_id.is_(None),
                MediaAsset.rights_confirmed.is_(True),
            )
            .order_by(MediaAsset.created_at.desc())
            .limit(limit)
        )
    ).all()
    out = []
    for kind, title, duration in rows:
        what = "видео" if kind == MediaKind.source_video else "фото"
        length = f", {duration:.0f} с" if duration else ""
        out.append(f"{what}{length}: {title or 'без описания'}")
    return out
