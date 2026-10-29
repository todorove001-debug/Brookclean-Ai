"""Распознавание речи для субтитров: интерфейс и адаптер OpenAI (POST /audio/transcriptions, verbose_json)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

from app.monitoring.metrics import PROVIDER_CALLS
from app.providers.base import ProviderUnavailable, classify_http_status


@dataclass(slots=True)
class TranscriptSegment:
    start: float
    end: float
    text: str


@dataclass(slots=True)
class Transcript:
    language: str
    duration_s: float
    text: str
    segments: list[TranscriptSegment] = field(default_factory=list)


class Transcriber(Protocol):
    name: str
    model: str

    async def transcribe(self, audio_path: Path, *, language: str = "ru") -> Transcript: ...


class OpenAITranscriber:
    name = "openai_transcription"
    # Лимит API на размер файла — 25 МБ; аудио заранее извлекается в моно mp3 64 кбит/с.
    MAX_BYTES = 25 * 1024 * 1024

    def __init__(self, *, api_key: str, model: str = "whisper-1", base_url: str = "https://api.openai.com/v1",
                 transport: httpx.AsyncBaseTransport | None = None, proxy: str | None = None):
        self.model = model
        self._http = httpx.AsyncClient(base_url=base_url.rstrip("/"), headers={"Authorization": f"Bearer {api_key}"},
                                       timeout=600, transport=transport, proxy=proxy)

    async def transcribe(self, audio_path: Path, *, language: str = "ru") -> Transcript:
        data = audio_path.read_bytes()
        if len(data) > self.MAX_BYTES:
            raise ValueError("аудио больше 25 МБ — разделите исходник")
        form = [
            ("model", self.model),
            ("language", language),
            ("response_format", "verbose_json"),
            ("timestamp_granularities[]", "segment"),
        ]
        try:
            response = await self._http.post("/audio/transcriptions", data=form, files={"file": (audio_path.name, data, "audio/mpeg")})
        except httpx.HTTPError as exc:
            PROVIDER_CALLS.labels(self.name, "transcribe", "connection_error").inc()
            raise ProviderUnavailable(f"распознавание речи: нет связи ({type(exc).__name__})", provider=self.name) from exc
        if response.status_code >= 400:
            PROVIDER_CALLS.labels(self.name, "transcribe", str(response.status_code)).inc()
            raise classify_http_status(response.status_code, self.name, f"распознавание речи: {response.text[:300]}",
                                       response.headers.get("retry-after"))
        PROVIDER_CALLS.labels(self.name, "transcribe", "ok").inc()
        body = response.json()
        segments = [TranscriptSegment(float(s["start"]), float(s["end"]), s["text"].strip()) for s in body.get("segments") or []]
        return Transcript(language=body.get("language", language), duration_s=float(body.get("duration") or 0),
                          text=body.get("text", ""), segments=segments)
