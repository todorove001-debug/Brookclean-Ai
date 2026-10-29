"""Интерфейс языковой модели. Одна модель обслуживает всех агентов; различаются системные инструкции и схемы."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Generic, Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


@dataclass(slots=True)
class LLMUsage:
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    web_search_requests: int = 0
    request_id: str | None = None


@dataclass(slots=True)
class LLMResult(Generic[T]):
    data: T
    usage: LLMUsage


@dataclass(slots=True)
class ImageInput:
    data: bytes
    media_type: str  # image/jpeg | image/png | image/webp


@dataclass(slots=True)
class WebHit:
    url: str
    title: str
    page_age: str | None = None


@dataclass(slots=True)
class WebSearchResult:
    hits: list[WebHit] = field(default_factory=list)
    summary: str = ""
    usage: LLMUsage | None = None


class LLMProvider(Protocol):
    name: str
    model: str

    async def structured(
        self,
        *,
        system: str,
        prompt: str,
        schema: type[T],
        images: list[ImageInput] | None = None,
        max_tokens: int = 16000,
        effort: str | None = None,
    ) -> LLMResult[T]: ...

    async def web_search(self, *, query: str, instructions: str, max_uses: int = 5) -> WebSearchResult: ...
