"""S3-совместимое хранилище (Reg.ru, Yandex Object Storage, MinIO, AWS). Бакет приватный."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError

from app.providers.storage.base import ObjectExists, StorageError, StoredObject, sha256_file, validate_key


class S3Storage:
    name = "s3"

    def __init__(self, *, endpoint: str | None, region: str, bucket: str, access_key: str, secret_key: str, client: Any = None):
        self.bucket = bucket
        self._client = client or boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}, s3={"addressing_style": "path"}),
        )
        self._transfer = TransferConfig(multipart_threshold=32 * 1024 * 1024, multipart_chunksize=16 * 1024 * 1024)

    def _head(self, key: str) -> dict[str, Any] | None:
        try:
            return self._client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise StorageError(f"S3 head_object: {exc}") from exc

    async def put_file(self, key: str, path: Path, content_type: str) -> StoredObject:
        validate_key(key)

        def _upload() -> StoredObject:
            if self._head(key) is not None:
                raise ObjectExists(key)
            digest = sha256_file(path)
            self._client.upload_file(
                str(path), self.bucket, key, Config=self._transfer,
                ExtraArgs={"ContentType": content_type, "Metadata": {"sha256": digest}},
            )
            return StoredObject(key, path.stat().st_size, digest)

        return await asyncio.to_thread(_upload)

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> StoredObject:
        validate_key(key)

        def _put() -> StoredObject:
            if self._head(key) is not None:
                raise ObjectExists(key)
            digest = hashlib.sha256(data).hexdigest()
            self._client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, Metadata={"sha256": digest})
            return StoredObject(key, len(data), digest)

        return await asyncio.to_thread(_put)

    async def get_bytes(self, key: str) -> bytes:
        def _get() -> bytes:
            try:
                return self._client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
            except ClientError as exc:
                raise StorageError(f"объект не найден или недоступен: {key}") from exc

        return await asyncio.to_thread(_get)

    async def download(self, key: str, dest: Path) -> Path:
        def _dl() -> Path:
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                self._client.download_file(self.bucket, key, str(dest), Config=self._transfer)
            except ClientError as exc:
                raise StorageError(f"не удалось скачать {key}") from exc
            return dest

        return await asyncio.to_thread(_dl)

    async def exists(self, key: str) -> bool:
        return await asyncio.to_thread(lambda: self._head(key) is not None)

    async def size(self, key: str) -> int | None:
        head = await asyncio.to_thread(self._head, key)
        return int(head["ContentLength"]) if head else None

    async def presigned_url(self, key: str, expires_s: int = 600) -> str | None:
        return await asyncio.to_thread(
            self._client.generate_presigned_url, "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires_s
        )

    async def check(self) -> None:
        def _check() -> None:
            try:
                self._client.head_bucket(Bucket=self.bucket)
            except ClientError as exc:
                raise StorageError(f"бакет {self.bucket} недоступен: {exc}") from exc

        await asyncio.to_thread(_check)
