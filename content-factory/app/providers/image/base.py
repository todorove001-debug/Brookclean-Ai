"""Генерация изображений: интерфейс и адаптер OpenAI Images API (POST /images/generations)."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from app.monitoring.metrics import PROVIDER_CALLS
from app.providers.base import ProviderRejected, ProviderUnavailable, classify_http_status


@dataclass(slots=True)
class GeneratedImage:
    data: bytes
    mime_type: str
    model: str
    size: str
    quality: str
    revised_prompt: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)


class ImageGenerator(Protocol):
    name: str
    model: str

    def size_for(self, aspect: str) -> str: ...
    async def generate(self, prompt: str, *, aspect: str, quality: str = "medium") -> GeneratedImage: ...


class OpenAIImageGenerator:
    name = "openai_images"
    SIZES = {"1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536", "4:5": "1024x1536"}

    def __init__(self, *, api_key: str, model: str, base_url: str = "https://api.openai.com/v1",
                 transport: httpx.AsyncBaseTransport | None = None, proxy: str | None = None):
        self.model = model
        self._http = httpx.AsyncClient(base_url=base_url.rstrip("/"), headers={"Authorization": f"Bearer {api_key}"},
                                       timeout=300, transport=transport, proxy=proxy)

    def size_for(self, aspect: str) -> str:
        return self.SIZES.get(aspect, "1024x1024")

    async def generate(self, prompt: str, *, aspect: str, quality: str = "medium") -> GeneratedImage:
        size = self.size_for(aspect)
        try:
            response = await self._http.post(
                "/images/generations",
                json={"model": self.model, "prompt": prompt[:30000], "size": size, "quality": quality, "n": 1, "output_format": "png"},
            )
        except httpx.HTTPError as exc:
            PROVIDER_CALLS.labels(self.name, "generate", "connection_error").inc()
            raise ProviderUnavailable(f"OpenAI Images: нет связи ({type(exc).__name__})", provider=self.name) from exc
        if response.status_code >= 400:
            PROVIDER_CALLS.labels(self.name, "generate", str(response.status_code)).inc()
            try:
                message = response.json().get("error", {}).get("message", "")
            except ValueError:
                message = response.text[:300]
            raise classify_http_status(response.status_code, self.name, f"OpenAI Images: {message}", response.headers.get("retry-after"))
        body = response.json()
        items = body.get("data") or []
        if not items or not items[0].get("b64_json"):
            raise ProviderRejected("OpenAI Images: в ответе нет изображения", provider=self.name)
        PROVIDER_CALLS.labels(self.name, "generate", "ok").inc()
        return GeneratedImage(
            data=base64.b64decode(items[0]["b64_json"]), mime_type="image/png", model=self.model, size=size, quality=quality,
            revised_prompt=items[0].get("revised_prompt"), usage=body.get("usage") or {},
        )
