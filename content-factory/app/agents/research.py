"""Research Agent: подбор и проверка источников для публикации.

1. Кандидаты из поиска (Claude web search) и RSS-лент.
2. Каждая страница загружается через SafeFetcher (защита от SSRF), из неё извлекается текст и дата.
3. Модель выписывает утверждения только с дословными цитатами.
4. Код проверяет, что цитата действительно есть на странице. Нет цитаты — утверждение «не подтверждено».
Тексты чужих статей не сохраняются целиком: в базе — URL, дата, хеш и короткие цитаты.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

from pydantic import BaseModel, Field
from selectolax.lexbor import LexborHTMLParser as HTMLParser

from app.agents.base import run_agent, untrusted
from app.budget.service import paid_call
from app.database.enums import SourceType, SourceVerification
from app.database.models import ContentItem, ResearchSource
from app.database.session import session_scope, utcnow
from app.monitoring.logging import get_logger
from app.orchestration.services import Services
from app.providers.search.base import SearchCandidate
from app.security.ssrf import FetchError, UnsafeURLError

log = get_logger(__name__)
MAX_PAGE_CHARS = 14000


class ExtractedClaim(BaseModel):
    claim: str
    quote: str


class SourceClaims(BaseModel):
    relevant: bool
    publisher: str = ""
    published_date: str = ""
    claims: list[ExtractedClaim] = Field(default_factory=list)


def normalize_for_match(text: str) -> str:
    text = text.lower().replace("ё", "е")
    text = re.sub(r"[«»“”„\"'`’]", "", text)
    text = re.sub(r"[‐-―−-]", "-", text)
    return re.sub(r"\s+", " ", text).strip()


def quote_found(quote: str, page_text: str) -> bool:
    q = normalize_for_match(quote)
    if len(q) < 15:
        return False
    return q in normalize_for_match(page_text)


def extract_page(html: str) -> tuple[str, str, datetime | None]:
    """Возвращает (заголовок, основной текст, дату публикации из метаданных)."""
    tree = HTMLParser(html)
    title = ""
    if tree.css_first("title"):
        title = tree.css_first("title").text(strip=True)
    published: datetime | None = None
    for selector in (
        'meta[property="article:published_time"]',
        'meta[name="pubdate"]',
        'meta[name="date"]',
        'meta[itemprop="datePublished"]',
        "time[datetime]",
    ):
        node = tree.css_first(selector)
        if node is None:
            continue
        value = node.attributes.get("content") or node.attributes.get("datetime")
        if value:
            published = parse_date(value)
            if published:
                break
    for tag in ("script", "style", "noscript", "nav", "header", "footer", "aside", "form", "iframe", "svg"):
        for node in tree.css(tag):
            node.decompose()
    root = tree.css_first("article") or tree.css_first("main") or tree.body
    text = root.text(separator="\n", strip=True) if root is not None else ""
    text = re.sub(r"\n{2,}", "\n", text)
    return title, text, published


def parse_date(value: str) -> datetime | None:
    value = value.strip()
    for candidate in (value, value.replace("Z", "+00:00"), value[:10]):
        try:
            dt = datetime.fromisoformat(candidate)
            return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
        except ValueError:
            continue
    return None


async def _search(services: Services, item: ContentItem) -> tuple[list[SearchCandidate], list[str]]:
    query = f"{item.topic}. {item.thesis or ''}".strip()
    candidates: list[SearchCandidate] = []
    errors: list[str] = []
    for provider in services.search:
        if provider.name == "anthropic_web":
            llm = services.require_llm()
            estimated = services.pricing.llm_cost(llm.model, 20000, 3000) + services.pricing.web_search_cost(
                4
            )
            async with paid_call(
                provider="anthropic",
                operation="research.web_search",
                estimated_usd=estimated,
                model=llm.model,
                item_id=item.id,
            ) as call:
                response = await provider.search(query, limit=10)
                if response.usage:
                    u = response.usage
                    actual = services.pricing.llm_cost(
                        u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens
                    ) + services.pricing.web_search_cost(u.web_search_requests)
                    call.set_actual(
                        actual,
                        source="tokens",
                        request_id=u.request_id,
                        units={
                            "web_search_requests": u.web_search_requests,
                            "input_tokens": u.input_tokens,
                            "output_tokens": u.output_tokens,
                        },
                    )
        else:
            response = await provider.search(query, limit=10)
        candidates += response.candidates
        errors += response.errors
    unique: dict[str, SearchCandidate] = {}
    for c in candidates:
        key = c.url.split("#")[0]
        unique.setdefault(key, c)
    return list(unique.values()), errors


async def _analyze(services: Services, item: ContentItem, candidate: SearchCandidate) -> ResearchSource:
    retrieved = utcnow()
    try:
        page = await services.fetcher.fetch(candidate.url)
    except (FetchError, UnsafeURLError) as exc:
        return ResearchSource(
            item_id=item.id,
            source_type=SourceType(candidate.source_type),
            url=candidate.url,
            title=candidate.title,
            retrieved_at=retrieved,
            verification=SourceVerification.unavailable,
            notes=f"не загружено: {exc}",
        )
    if page.status_code != 200 or "html" not in page.content_type.lower():
        return ResearchSource(
            item_id=item.id,
            source_type=SourceType(candidate.source_type),
            url=candidate.url,
            title=candidate.title,
            retrieved_at=retrieved,
            verification=SourceVerification.unavailable,
            notes=f"HTTP {page.status_code}, {page.content_type}",
        )
    title, text, meta_date = extract_page(page.text)
    sha = hashlib.sha256(text.encode()).hexdigest()
    excerpt = text[:MAX_PAGE_CHARS]
    result = await run_agent(
        services,
        agent="research_claims",
        schema=SourceClaims,
        item_id=item.id,
        expected_output_tokens=900,
        max_tokens=6000,
        effort="medium",
        prompt="\n".join(
            [
                f"Тема публикации: {item.topic}",
                f"Тезис: {item.thesis or '—'}",
                f"URL: {page.final_url}",
                untrusted("web_page", f"Заголовок: {title or candidate.title}\n\n{excerpt}"),
            ]
        ),
    )
    claims = [
        {"claim": c.claim, "quote": c.quote[:400], "verified": quote_found(c.quote, text)}
        for c in result.claims
    ]
    verified = [c for c in claims if c["verified"]]
    status = SourceVerification.verified if result.relevant and verified else SourceVerification.unverified
    published = (
        meta_date
        or (parse_date(result.published_date) if result.published_date else None)
        or candidate.published_at
    )
    return ResearchSource(
        item_id=item.id,
        source_type=SourceType(candidate.source_type),
        url=page.final_url,
        title=title or candidate.title,
        publisher=(result.publisher or urlsplit(page.final_url).hostname or "")[:200],
        published_at=published,
        retrieved_at=retrieved,
        content_sha256=sha,
        claims=claims,
        verification=status,
        notes=None if result.relevant else "модель сочла страницу нерелевантной",
    )


async def research_item(services: Services, item_id: uuid.UUID) -> dict[str, int]:
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        assert item is not None
        if item.owner_brief:
            # Материалы владельца — первоисточник для историй и кейсов. Утверждения не перепроверяются моделью.
            session.add(
                ResearchSource(
                    item_id=item.id,
                    source_type=SourceType.owner_material,
                    title="Материалы владельца",
                    retrieved_at=utcnow(),
                    claims=[{"claim": item.owner_brief, "quote": item.owner_brief[:400], "verified": True}],
                    verification=SourceVerification.verified,
                )
            )
        needs_sources = item.needs_sources
    if not needs_sources:
        return {"sources": 0, "verified": 0}

    candidates, errors = await _search(services, item)
    if errors:
        log.warning("research.search_errors", item_id=str(item_id), errors=errors[:5])
    limit = services.settings.research_max_sources
    results: list[ResearchSource] = []
    sem = asyncio.Semaphore(3)

    async def worker(c: SearchCandidate) -> None:
        async with sem:
            try:
                results.append(await _analyze(services, item, c))
            except Exception as exc:  # noqa: BLE001 — один источник не должен ронять исследование
                log.warning("research.source_failed", url=c.url, error=str(exc))
                if type(exc).__name__ in {"BudgetExceeded", "ProviderNotConfigured"}:
                    raise

    await asyncio.gather(*(worker(c) for c in candidates[: limit * 2]))
    results.sort(key=lambda s: (s.verification != SourceVerification.verified, -(len(s.claims or []))))
    keep = results[:limit]
    async with session_scope() as session:
        for source in keep:
            session.add(source)
    verified = sum(1 for s in keep if s.verification == SourceVerification.verified)
    return {"sources": len(keep), "verified": verified, "candidates": len(candidates)}
