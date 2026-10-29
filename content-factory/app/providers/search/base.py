"""Поиск источников: веб-поиск через Claude и RSS-ленты. Оба возвращают кандидатов; проверка — в Research Agent."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Protocol

import feedparser

from app.providers.llm.base import LLMProvider, LLMUsage
from app.security.ssrf import FetchError, SafeFetcher, UnsafeURLError


@dataclass(slots=True)
class SearchCandidate:
    url: str
    title: str
    source_type: str  # web | rss
    published_at: datetime | None = None
    snippet: str = ""


@dataclass(slots=True)
class SearchResponse:
    candidates: list[SearchCandidate] = field(default_factory=list)
    usage: LLMUsage | None = None
    errors: list[str] = field(default_factory=list)


class SearchProvider(Protocol):
    name: str

    async def search(self, query: str, *, limit: int = 8) -> SearchResponse: ...


SEARCH_INSTRUCTIONS = (
    "Найди актуальные первоисточники по запросу: официальные сайты госорганов (pravo.gov.ru, publication.pravo.gov.ru, "
    "сайты министерств), отраслевые СМИ, сайты производителей. Предпочитай материалы последних 12 месяцев. "
    "Кратко перечисли найденные страницы. Не делай выводов, которых нет в источниках."
)


class AnthropicWebSearch:
    name = "anthropic_web"

    def __init__(self, llm: LLMProvider, max_uses: int = 4):
        self.llm = llm
        self.max_uses = max_uses

    async def search(self, query: str, *, limit: int = 8) -> SearchResponse:
        result = await self.llm.web_search(query=query, instructions=SEARCH_INSTRUCTIONS, max_uses=self.max_uses)
        candidates = [SearchCandidate(url=h.url, title=h.title, source_type="web", published_at=_parse_age(h.page_age))
                      for h in result.hits[:limit]]
        return SearchResponse(candidates=candidates, usage=result.usage)


def _parse_age(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in ("%B %d, %Y", "%Y-%m-%d", "%d %B %Y"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


def _tokens(text: str) -> set[str]:
    return {w[:6] for w in re.findall(r"[а-яёa-z0-9]{4,}", text.lower())}


class RssSearch:
    """Ищет по настроенным RSS-лентам. Ленты загружаются через SafeFetcher."""

    name = "rss"

    def __init__(self, feeds: list[str], fetcher: SafeFetcher):
        self.feeds = feeds
        self.fetcher = fetcher

    async def _load(self, url: str) -> tuple[list[SearchCandidate], str | None]:
        try:
            resource = await self.fetcher.fetch(url, accept="application/rss+xml,application/atom+xml,application/xml,text/xml")
        except (FetchError, UnsafeURLError) as exc:
            return [], f"{url}: {exc}"
        if resource.status_code != 200:
            return [], f"{url}: HTTP {resource.status_code}"
        parsed = feedparser.parse(resource.content)
        items = []
        for entry in parsed.entries[:100]:
            link = entry.get("link")
            if not link:
                continue
            published = None
            for key in ("published", "updated"):
                if entry.get(key):
                    try:
                        published = parsedate_to_datetime(entry[key])
                        if published.tzinfo is None:
                            published = published.replace(tzinfo=UTC)
                    except (TypeError, ValueError):
                        published = None
                    break
            summary = re.sub(r"<[^>]+>", " ", entry.get("summary", ""))[:500]
            items.append(SearchCandidate(url=link, title=entry.get("title", ""), source_type="rss", published_at=published, snippet=summary))
        return items, None

    async def search(self, query: str, *, limit: int = 8) -> SearchResponse:
        if not self.feeds:
            return SearchResponse()
        loaded = await asyncio.gather(*(self._load(f) for f in self.feeds))
        wanted = _tokens(query)
        scored: list[tuple[int, SearchCandidate]] = []
        errors: list[str] = []
        for items, error in loaded:
            if error:
                errors.append(error)
            for item in items:
                score = len(wanted & _tokens(f"{item.title} {item.snippet}"))
                if score:
                    scored.append((score, item))
        scored.sort(key=lambda p: (p[0], p[1].published_at or datetime.min.replace(tzinfo=UTC)), reverse=True)
        return SearchResponse(candidates=[c for _, c in scored[:limit]], errors=errors)
