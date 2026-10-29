"""Проверка загружаемых файлов: размер, тип по сигнатуре (не по расширению и не по заголовку клиента)."""

from __future__ import annotations

from dataclasses import dataclass


class UploadRejected(ValueError):
    pass


@dataclass(slots=True)
class DetectedType:
    mime: str
    extension: str
    category: str  # video | image | audio | font


def sniff_mime(head: bytes) -> DetectedType | None:
    """Определяет тип по первым байтам файла."""
    if head.startswith(b"\xff\xd8\xff"):
        return DetectedType("image/jpeg", "jpg", "image")
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return DetectedType("image/png", "png", "image")
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return DetectedType("image/webp", "webp", "image")
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return DetectedType("audio/wav", "wav", "audio")
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return DetectedType("video/quicktime", "mov", "video")
        if brand in {b"M4A ", b"M4B "}:
            return DetectedType("audio/mp4", "m4a", "audio")
        if brand in {b"heic", b"heix", b"mif1"}:
            return None  # HEIC пока не поддерживается конвейером
        return DetectedType("video/mp4", "mp4", "video")
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        # EBML: Matroska или WebM.
        if b"webm" in head[:64]:
            return DetectedType("video/webm", "webm", "video")
        return DetectedType("video/x-matroska", "mkv", "video")
    if head.startswith(b"ID3") or head[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
        return DetectedType("audio/mpeg", "mp3", "audio")
    if head[:2] in {b"\xff\xf1", b"\xff\xf9"}:
        return DetectedType("audio/aac", "aac", "audio")
    if head.startswith(b"\x00\x01\x00\x00") or head.startswith(b"true"):
        return DetectedType("font/ttf", "ttf", "font")
    if head.startswith(b"OTTO"):
        return DetectedType("font/otf", "otf", "font")
    return None


def validate_upload(head: bytes, size: int, *, max_bytes: int, allowed_mime: list[str]) -> DetectedType:
    if size <= 0:
        raise UploadRejected("пустой файл")
    if size > max_bytes:
        raise UploadRejected(f"файл больше допустимых {max_bytes // (1024 * 1024)} МБ")
    detected = sniff_mime(head)
    if detected is None:
        raise UploadRejected("тип файла не распознан или не поддерживается")
    if detected.mime not in allowed_mime:
        raise UploadRejected(f"тип {detected.mime} не разрешён")
    return detected
