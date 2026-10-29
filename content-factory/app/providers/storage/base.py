"""Объектное хранилище медиафайлов: интерфейс и две реализации (локальный диск и S3)."""

from __future__ import annotations

import asyncio
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class StorageError(RuntimeError):
    pass


class ObjectExists(StorageError):
    """Попытка перезаписать существующий объект. Оригиналы неизменяемы."""


@dataclass(slots=True)
class StoredObject:
    key: str
    size: int
    sha256: str


class Storage(Protocol):
    name: str

    async def put_file(self, key: str, path: Path, content_type: str) -> StoredObject: ...
    async def put_bytes(self, key: str, data: bytes, content_type: str) -> StoredObject: ...
    async def get_bytes(self, key: str) -> bytes: ...
    async def download(self, key: str, dest: Path) -> Path: ...
    async def exists(self, key: str) -> bool: ...
    async def size(self, key: str) -> int | None: ...
    async def presigned_url(self, key: str, expires_s: int = 600) -> str | None: ...
    async def check(self) -> None: ...
    async def list_keys(self, prefix: str) -> list[tuple[str, int]]: ...


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_key(key: str) -> str:
    if not key or key.startswith("/") or ".." in key.split("/") or "\\" in key or "\x00" in key:
        raise StorageError(f"недопустимый ключ объекта: {key!r}")
    return key


class LocalStorage:
    name = "local"

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / validate_key(key)).resolve()
        if not path.is_relative_to(self.root):
            raise StorageError("ключ выходит за пределы хранилища")
        return path

    async def put_file(self, key: str, path: Path, content_type: str) -> StoredObject:
        dest = self._path(key)
        if dest.exists():
            raise ObjectExists(key)

        def _copy() -> StoredObject:
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            h = hashlib.sha256()
            size = 0
            with path.open("rb") as src, tmp.open("wb") as out:
                for chunk in iter(lambda: src.read(1024 * 1024), b""):
                    h.update(chunk)
                    size += len(chunk)
                    out.write(chunk)
            os.replace(tmp, dest)
            return StoredObject(key, size, h.hexdigest())

        return await asyncio.to_thread(_copy)

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> StoredObject:
        dest = self._path(key)
        if dest.exists():
            raise ObjectExists(key)

        def _write() -> StoredObject:
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            os.replace(tmp, dest)
            return StoredObject(key, len(data), hashlib.sha256(data).hexdigest())

        return await asyncio.to_thread(_write)

    async def get_bytes(self, key: str) -> bytes:
        path = self._path(key)
        if not path.exists():
            raise StorageError(f"объект не найден: {key}")
        return await asyncio.to_thread(path.read_bytes)

    async def download(self, key: str, dest: Path) -> Path:
        data = await self.get_bytes(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(dest.write_bytes, data)
        return dest

    async def exists(self, key: str) -> bool:
        return self._path(key).exists()

    async def size(self, key: str) -> int | None:
        path = self._path(key)
        return path.stat().st_size if path.exists() else None

    async def presigned_url(self, key: str, expires_s: int = 600) -> str | None:
        return None  # локальные файлы отдаются только через API с авторизацией

    async def check(self) -> None:
        probe = self.root / ".healthcheck"
        await asyncio.to_thread(probe.write_text, "ok")

    async def list_keys(self, prefix: str) -> list[tuple[str, int]]:
        base = self._path(prefix.rstrip("/")) if prefix.strip("/") else self.root
        if not base.exists():
            return []
        return sorted((str(p.relative_to(self.root)), p.stat().st_size) for p in base.rglob("*") if p.is_file())
