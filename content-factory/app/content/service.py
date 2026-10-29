"""Материалы, версии, контрольные суммы и переходы статусов."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database.enums import TRANSITIONS, ApprovalAction, ContentStatus, QAStatus
from app.database.models import ApprovalEvent, ContentItem, ContentVersion, MediaAsset, VersionMedia
from app.database.session import utcnow
from app.monitoring.audit import audit


class InvalidTransition(Exception):
    pass


class VersionFrozen(Exception):
    pass


async def transition(
    session: AsyncSession,
    item: ContentItem,
    new_status: ContentStatus,
    *,
    actor: str = "system",
    reason: str | None = None,
) -> None:
    current = ContentStatus(item.status)
    if new_status == current:
        return
    if new_status not in TRANSITIONS[current]:
        raise InvalidTransition(f"переход {current} → {new_status} запрещён")
    item.status = new_status
    item.status_changed_at = utcnow()
    if new_status != ContentStatus.failed:
        item.last_error = None
    await audit(session, "content.status", actor_type="system" if actor == "system" else "user", actor_id=actor,
                entity_type="content_item", entity_id=item.id, from_status=current.value, to_status=new_status.value,
                reason=reason)


async def fail(session: AsyncSession, item: ContentItem, error: str) -> None:
    if ContentStatus(item.status) in {ContentStatus.published, ContentStatus.cancelled, ContentStatus.rejected}:
        return
    await transition(session, item, ContentStatus.failed, reason=error[:500])
    item.last_error = error[:4000]


async def load_item(session: AsyncSession, item_id: uuid.UUID, *, for_update: bool = False) -> ContentItem | None:
    stmt = select(ContentItem).where(ContentItem.id == item_id)
    if for_update:
        stmt = stmt.with_for_update()
    return (await session.execute(stmt)).scalar_one_or_none()


async def load_version(session: AsyncSession, version_id: uuid.UUID | None) -> ContentVersion | None:
    if version_id is None:
        return None
    stmt = (
        select(ContentVersion)
        .where(ContentVersion.id == version_id)
        .options(selectinload(ContentVersion.media_links).selectinload(VersionMedia.asset))
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


def canonical_payload(item_format: str, version: ContentVersion, links: list[tuple[VersionMedia, MediaAsset]]) -> dict[str, Any]:
    return {
        "format": item_format,
        "title": version.title or "",
        "body_html": version.body_html or "",
        "poll": version.poll,
        "hashtags": list(version.hashtags or []),
        "cta_text": version.cta_text,
        "publish_options": version.publish_options or {},
        "media": sorted(
            ({"role": link.role, "position": link.position, "asset_id": str(asset.id), "sha256": asset.sha256}
             for link, asset in links),
            key=lambda m: (m["role"], m["position"], m["asset_id"]),
        ),
    }


def content_hash(item_format: str, version: ContentVersion, links: list[tuple[VersionMedia, MediaAsset]]) -> str:
    payload = canonical_payload(item_format, version, links)
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def version_links(version: ContentVersion) -> list[tuple[VersionMedia, MediaAsset]]:
    return [(link, link.asset) for link in version.media_links]


async def invalidate_approval(session: AsyncSession, item: ContentItem, reason: str) -> None:
    if item.approved_version_id is None:
        return
    session.add(ApprovalEvent(item_id=item.id, version_id=item.approved_version_id, content_hash=item.approved_content_hash,
                              action=ApprovalAction.invalidated, comment=reason))
    item.approved_version_id = None
    item.approved_content_hash = None
    item.approved_at = None
    item.approved_by_user_id = None
    await audit(session, "approval.invalidated", entity_type="content_item", entity_id=item.id, reason=reason)


async def new_version(
    session: AsyncSession,
    item: ContentItem,
    *,
    title: str,
    body_html: str,
    origin: str,
    poll: dict[str, Any] | None = None,
    video_script: dict[str, Any] | None = None,
    hashtags: list[str] | None = None,
    cta_text: str | None = None,
    publish_options: dict[str, Any] | None = None,
    change_request: str | None = None,
    copy_media_from: ContentVersion | None = None,
) -> ContentVersion:
    """Создаёт новую версию и делает её текущей. Прежнее одобрение снимается."""
    last_no = (await session.execute(
        select(func.coalesce(func.max(ContentVersion.version_no), 0)).where(ContentVersion.item_id == item.id)
    )).scalar_one()
    version = ContentVersion(
        item_id=item.id, version_no=last_no + 1, title=title, body_html=body_html, poll=poll, video_script=video_script,
        hashtags=hashtags or [], cta_text=cta_text, publish_options=publish_options or {}, origin=origin,
        change_request=change_request, qa_status=QAStatus.pending,
    )
    session.add(version)
    await session.flush()
    if copy_media_from is not None:
        for link in copy_media_from.media_links:
            session.add(VersionMedia(version_id=version.id, asset_id=link.asset_id, role=link.role, position=link.position))
        await session.flush()
    item.current_version_id = version.id
    await invalidate_approval(session, item, f"создана версия {version.version_no}")
    return version


async def attach_media(session: AsyncSession, version: ContentVersion, asset: MediaAsset, *, role: str, position: int = 0,
                       replace_role: bool = True) -> None:
    if version.frozen_at is not None:
        raise VersionFrozen(f"версия {version.version_no} заморожена")
    if replace_role:
        for link in list(version.media_links):
            if link.role == role:
                await session.delete(link)
        await session.flush()
    session.add(VersionMedia(version_id=version.id, asset_id=asset.id, role=role, position=position))
    await session.flush()
    session.expire(version, ["media_links"])


async def freeze(session: AsyncSession, item: ContentItem, version: ContentVersion) -> str:
    """Замораживает версию перед отправкой на согласование. Возвращает контрольную сумму."""
    fresh = await load_version(session, version.id)
    assert fresh is not None
    if fresh.frozen_at is not None:
        return fresh.content_hash or ""
    digest = content_hash(item.format, fresh, version_links(fresh))
    fresh.content_hash = digest
    fresh.frozen_at = utcnow()
    await session.flush()
    return digest


async def recompute_hash(session: AsyncSession, item: ContentItem, version_id: uuid.UUID) -> str | None:
    version = await load_version(session, version_id)
    if version is None:
        return None
    return content_hash(item.format, version, version_links(version))


# --- Похожесть текстов (защита от повторов) ---

_WORD = re.compile(r"[а-яёa-z0-9]+", re.IGNORECASE)
_STOP = {"и", "в", "на", "с", "по", "для", "как", "что", "это", "из", "к", "от", "не", "а", "о", "у", "за", "до", "или", "the", "a"}


def normalize_words(text: str) -> list[str]:
    plain = re.sub(r"<[^>]+>", " ", text or "").lower().replace("ё", "е")
    # Грубая нормализация словоформ: обрезка окончаний до 6 символов.
    return [w[:6] for w in _WORD.findall(plain) if w not in _STOP]


def shingles(text: str, size: int = 2) -> set[str]:
    words = normalize_words(text)
    if len(words) < size:
        return set(words)
    return {" ".join(words[i:i + size]) for i in range(len(words) - size + 1)}


def similarity(a: str, b: str, size: int = 2) -> float:
    sa, sb = shingles(a, size), shingles(b, size)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def title_similarity(a: str, b: str) -> float:
    wa, wb = set(normalize_words(a)), set(normalize_words(b))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)
