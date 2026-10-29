"""Проверка орфографии через Яндекс.Спеллер (speller.yandex.net, JSON-интерфейс checkText)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import httpx

from app.monitoring.metrics import PROVIDER_CALLS
from app.providers.base import ProviderUnavailable

# Коды ошибок Спеллера: 1 — неизвестное слово, 2 — повтор слова, 3 — неверная капитализация, 4 — слишком много ошибок.
IGNORE_DIGITS = 2
IGNORE_URLS = 4
FIND_REPEAT_WORDS = 8


@dataclass(slots=True)
class SpellingIssue:
    word: str
    position: int
    code: int
    suggestions: list[str] = field(default_factory=list)


class SpellChecker(Protocol):
    name: str

    async def check(self, text: str) -> list[SpellingIssue]: ...


class YandexSpeller:
    name = "yandex_speller"
    CHUNK = 9000  # ограничение сервиса на длину текста в запросе — 10 000 символов

    def __init__(self, url: str, transport: httpx.AsyncBaseTransport | None = None):
        self.url = url
        self._http = httpx.AsyncClient(timeout=20, transport=transport)

    async def check(self, text: str) -> list[SpellingIssue]:
        issues: list[SpellingIssue] = []
        offset = 0
        while offset < len(text):
            chunk = text[offset : offset + self.CHUNK]
            try:
                response = await self._http.post(
                    self.url,
                    data={
                        "text": chunk,
                        "lang": "ru,en",
                        "options": IGNORE_DIGITS | IGNORE_URLS | FIND_REPEAT_WORDS,
                    },
                )
                response.raise_for_status()
            except httpx.HTTPError as exc:
                PROVIDER_CALLS.labels(self.name, "check", "error").inc()
                raise ProviderUnavailable(
                    f"Спеллер недоступен: {type(exc).__name__}", provider=self.name
                ) from exc
            PROVIDER_CALLS.labels(self.name, "check", "ok").inc()
            for item in response.json():
                issues.append(
                    SpellingIssue(
                        word=item.get("word", ""),
                        position=offset + int(item.get("pos", 0)),
                        code=int(item.get("code", 1)),
                        suggestions=list(item.get("s") or [])[:3],
                    )
                )
            offset += self.CHUNK
        return issues
