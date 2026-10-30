"""Приём загруженных файлов (веб-панель, API, Telegram-бот): проверка и сохранение в хранилище."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.database.enums import MediaKind, MediaOrigin
from app.database.models import MediaAsset, User
from app.database.session import utcnow
from app.media.assets import image_info, store_file
from app.monitoring.audit import audit
from app.providers.storage.base import Storage
from app.security.rbac import Permission, has_permission
from app.security.uploads import UploadRejected, validate_upload
from app.settings.config import Settings
from app.video.ffmpeg import FFmpegError, probe

KINDS = {
    ("source", "video"): MediaKind.source_video,
    ("source", "image"): MediaKind.source_image,
    ("source", "audio"): MediaKind.source_audio,
    ("music", "audio"): MediaKind.music,
    ("logo", "image"): MediaKind.logo,
    ("font", "font"): MediaKind.font,
}


class IntakeError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


async def accept_file(
    session: AsyncSession,
    storage: Storage,
    settings: Settings,
    path: Path,
    *,
    user: User,
    purpose: str = "source",
    title: str | None = None,
    item_id: uuid.UUID | None = None,
    rights: dict[str, Any] | None = None,
    confirm_rights: bool = False,
    channel: str = "api",
) -> MediaAsset:
    size = path.stat().st_size
    with path.open("rb") as fh:
        head = fh.read(64)
    try:
        detected = validate_upload(
            head,
            size,
            max_bytes=settings.max_upload_mb * 1024 * 1024,
            allowed_mime=settings.allowed_upload_mime,
        )
    except UploadRejected as exc:
        raise IntakeError(str(exc), 415) from exc
    kind = KINDS.get((purpose, detected.category))
    if kind is None:
        raise IntakeError(f"файл типа {detected.mime} не подходит для назначения «{purpose}»", 415)
    info = None
    if detected.category in {"video", "audio"}:
        try:
            info = await probe(path)
        except FFmpegError as exc:
            raise IntakeError("файл повреждён или не читается FFmpeg") from exc
        if detected.category == "video" and not info.has_video:
            raise IntakeError("в файле нет видеодорожки")
    # Подтверждать права может только тот, кто вправе согласовывать публикации.
    confirmed = confirm_rights and has_permission(user.role, Permission.content_approve)
    rights = {
        "license": "own",
        **(rights or {}),
        "uploaded_by": str(user.id),
        "uploaded_at": utcnow().isoformat(),
        "channel": channel,
    }
    asset = await store_file(
        session,
        storage,
        path,
        kind=kind,
        origin=MediaOrigin.owner_upload,
        mime=detected.mime,
        item_id=item_id,
        title=title,
        rights=rights,
        rights_confirmed=confirmed,
        probe_info=info,
        created_by=f"user:{user.id}",
    )
    if detected.category == "image":
        img = image_info(path.read_bytes())
        asset.width, asset.height = img.width, img.height
    if confirmed:
        asset.rights_confirmed_by = user.id
    await audit(
        session,
        "media.upload",
        actor_type="user",
        actor_id=str(user.id),
        entity_type="media_asset",
        entity_id=asset.id,
        kind=kind.value,
        size=size,
        sha256=asset.sha256,
        rights_confirmed=confirmed,
        channel=channel,
    )
    return asset
