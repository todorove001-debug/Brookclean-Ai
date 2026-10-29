"""Регистрация файлов в хранилище и базе, проверка целостности."""

from __future__ import annotations

import hashlib
import io
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageStat, UnidentifiedImageError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.enums import MediaKind, MediaOrigin
from app.database.models import MediaAsset
from app.database.session import utcnow
from app.providers.storage.base import Storage, StorageError
from app.video.ffmpeg import FFmpegError, ProbeInfo, probe

EXTENSIONS = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov",
    "video/x-matroska": "mkv", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a",
    "audio/aac": "aac", "font/ttf": "ttf", "font/otf": "otf", "application/json": "json", "text/x-ass": "ass",
}

FOLDERS = {
    MediaKind.source_video: "sources/video", MediaKind.source_image: "sources/image", MediaKind.source_audio: "sources/audio",
    MediaKind.music: "library/music", MediaKind.logo: "library/brand", MediaKind.font: "library/fonts",
}


class IntegrityError(RuntimeError):
    pass


def storage_key(kind: MediaKind, mime: str) -> str:
    ext = EXTENSIONS.get(mime, "bin")
    folder = FOLDERS.get(kind, f"generated/{kind.value}")
    now = utcnow()
    return f"{folder}/{now:%Y/%m}/{uuid.uuid4().hex}.{ext}"


@dataclass(slots=True)
class ImageInfo:
    width: int
    height: int
    mean_luma: float
    stddev_luma: float


def image_info(data: bytes) -> ImageInfo:
    try:
        img = Image.open(io.BytesIO(data))
        img.verify()
        img = Image.open(io.BytesIO(data))
        gray = img.convert("L")
    except (UnidentifiedImageError, OSError) as exc:
        raise IntegrityError(f"изображение повреждено: {exc}") from exc
    stat = ImageStat.Stat(gray)
    return ImageInfo(width=img.width, height=img.height, mean_luma=stat.mean[0], stddev_luma=stat.stddev[0])


async def store_bytes(
    session: AsyncSession, storage: Storage, data: bytes, *, kind: MediaKind, origin: MediaOrigin, mime: str,
    item_id: uuid.UUID | None = None, channel_id: uuid.UUID | None = None, title: str | None = None,
    is_synthetic: bool = False, rights: dict[str, Any] | None = None, rights_confirmed: bool = False,
    parent_ids: list[uuid.UUID] | None = None, render_params: dict[str, Any] | None = None, provider: str | None = None,
    provider_job_id: str | None = None, created_by: str = "system",
) -> MediaAsset:
    width = height = None
    probe_data: dict[str, Any] | None = None
    if mime.startswith("image/"):
        info = image_info(data)
        width, height = info.width, info.height
        probe_data = {"mean_luma": round(info.mean_luma, 2), "stddev_luma": round(info.stddev_luma, 2)}
    stored = await storage.put_bytes(storage_key(kind, mime), data, mime)
    asset = MediaAsset(
        channel_id=channel_id, item_id=item_id, kind=kind, origin=origin, title=title, storage_key=stored.key, mime_type=mime,
        size_bytes=stored.size, sha256=stored.sha256, width=width, height=height, is_synthetic=is_synthetic,
        rights=rights or {}, rights_confirmed=rights_confirmed, parent_asset_ids=[str(p) for p in parent_ids or []],
        render_params=render_params, probe=probe_data, provider=provider, provider_job_id=provider_job_id, created_by=created_by,
    )
    session.add(asset)
    await session.flush()
    return asset


async def store_file(
    session: AsyncSession, storage: Storage, path: Path, *, kind: MediaKind, origin: MediaOrigin, mime: str,
    item_id: uuid.UUID | None = None, channel_id: uuid.UUID | None = None, title: str | None = None,
    is_synthetic: bool = False, rights: dict[str, Any] | None = None, rights_confirmed: bool = False,
    parent_ids: list[uuid.UUID] | None = None, render_params: dict[str, Any] | None = None, provider: str | None = None,
    provider_job_id: str | None = None, created_by: str = "system", probe_info: ProbeInfo | None = None,
    extra_probe: dict[str, Any] | None = None,
) -> MediaAsset:
    info = probe_info
    if info is None and (mime.startswith("video/") or mime.startswith("audio/")):
        info = await probe(path)
    stored = await storage.put_file(storage_key(kind, mime), path, mime)
    size = info.display_size if info else None
    asset = MediaAsset(
        channel_id=channel_id, item_id=item_id, kind=kind, origin=origin, title=title, storage_key=stored.key, mime_type=mime,
        size_bytes=stored.size, sha256=stored.sha256, width=size[0] if size else None, height=size[1] if size else None,
        duration_s=info.duration_s if info else None, has_audio=info.has_audio if info else None, is_synthetic=is_synthetic,
        rights=rights or {}, rights_confirmed=rights_confirmed, parent_asset_ids=[str(p) for p in parent_ids or []],
        render_params=render_params, probe={**(info.summary() if info else {}), **(extra_probe or {})},
        provider=provider, provider_job_id=provider_job_id, created_by=created_by,
    )
    session.add(asset)
    await session.flush()
    return asset


async def fetch_verified(storage: Storage, asset: MediaAsset) -> bytes:
    """Скачивает файл и сверяет контрольную сумму с записью в базе."""
    try:
        data = await storage.get_bytes(asset.storage_key)
    except StorageError as exc:
        raise IntegrityError(f"файл {asset.storage_key} не найден в хранилище") from exc
    if len(data) != asset.size_bytes or hashlib.sha256(data).hexdigest() != asset.sha256:
        raise IntegrityError(f"файл {asset.storage_key} изменён или повреждён: контрольная сумма не совпадает")
    return data


async def download_verified(storage: Storage, asset: MediaAsset, dest: Path) -> Path:
    await storage.download(asset.storage_key, dest)
    digest = hashlib.sha256()
    with dest.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != asset.sha256:
        dest.unlink(missing_ok=True)
        raise IntegrityError(f"файл {asset.storage_key} изменён или повреждён: контрольная сумма не совпадает")
    return dest


def temp_dir(base: Path, prefix: str) -> tempfile.TemporaryDirectory[str]:
    base.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=prefix, dir=base)


__all__ = ["FFmpegError", "IntegrityError", "download_verified", "fetch_verified", "image_info", "store_bytes", "store_file", "temp_dir"]
