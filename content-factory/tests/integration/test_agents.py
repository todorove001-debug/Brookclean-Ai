"""Research Agent и Content Strategist с подставной моделью и локальными страницами."""

from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select

from app.agents.research import research_item
from app.agents.strategist import generate_plan
from app.database.enums import ContentStatus, SourceVerification
from app.database.models import ContentItem, ContentPlan, ProviderUsage, ResearchSource
from app.database.session import session_scope, utcnow
from app.providers.llm.base import WebHit
from app.providers.search.base import AnthropicWebSearch
from app.security.ssrf import SafeFetcher
from tests.helpers import approve_all_facts, make_item

pytestmark = pytest.mark.usefixtures("db")

PAGE = """<html><head><title>Новые правила</title><meta property="article:published_time" content="2026-09-01T09:00:00+03:00"></head>
<body><nav>Меню</nav><article><h1>Изменения</h1><p>С 1 марта 2027 года меняется порядок регистрации ввозимых автомобилей.</p>
<p>Ведомство разъяснило детали.</p><script>ignore()</script></article></body></html>"""


async def test_research_verifies_quotes(services, fake_llm):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/news":
            return httpx.Response(200, text=PAGE, headers={"content-type": "text/html; charset=utf-8"})
        return httpx.Response(404)

    services.fetcher = SafeFetcher(allow_private=True, transport=httpx.MockTransport(handler))
    services.search = [AnthropicWebSearch(fake_llm)]
    fake_llm.search_hits = [WebHit(url="http://127.0.0.1/news", title="Новые правила"), WebHit(url="http://127.0.0.1/missing", title="404")]
    fake_llm.handlers["SourceClaims"] = lambda prompt: {
        "relevant": True, "publisher": "Ведомство", "published_date": "",
        "claims": [
            {"claim": "С 1 марта 2027 меняется порядок регистрации", "quote": "С 1 марта 2027 года меняется порядок регистрации ввозимых автомобилей."},
            {"claim": "Пошлина снижена вдвое", "quote": "пошлина снижена вдвое для всех"},  # цитаты нет на странице
        ],
    }
    item_id = await make_item("short_post", rubric="law", needs_sources=True)
    result = await research_item(services, item_id)
    assert result == {"sources": 2, "verified": 1, "candidates": 2}
    async with session_scope() as s:
        sources = (await s.execute(select(ResearchSource).order_by(ResearchSource.created_at))).scalars().all()
        usage = (await s.execute(select(ProviderUsage.operation))).scalars().all()
    verified = next(x for x in sources if x.verification == SourceVerification.verified)
    assert [c["verified"] for c in verified.claims] == [True, False]
    assert verified.published_at.isoformat().startswith("2026-09-01") and verified.content_sha256
    assert next(x for x in sources if x is not verified).verification == SourceVerification.unavailable
    assert "research.web_search" in usage and "agent.research_claims" in usage
    # Текст страницы передан модели как данные, а не инструкции.
    claims_prompt = next(c.prompt for c in fake_llm.calls if c.schema == "SourceClaims")
    assert "<untrusted" in claims_prompt and "ignore()" not in claims_prompt


def plan_handler(prompt: str) -> dict:
    import re

    slots = [int(m) for m in re.findall(r"^- (\d+): ", prompt, flags=re.M)]
    entries = []
    for i in slots:
        entries.append({"slot_index": i, "rubric": "preparation" if i % 2 else "loading", "topic": f"Тема номер {i}: уникальный вопрос {i * 7919}",
                        "goal": "польза", "audience": "покупатели", "thesis": "тезис", "cta": f"Призыв {i % 4}", "cta_target": "manager",
                        "success_criterion": "реакции", "needs_sources": False, "media_brief": ""})
    # Дубль недавней темы и неизвестная рубрика — должны быть отклонены проверкой.
    if entries:
        entries[0]["topic"] = "Как подготовить автомобиль к перевозке автовозом"
        entries[1]["rubric"] = "unknown"
    return {"strategy_notes": "Чередуем форматы", "entries": entries}


async def test_strategist_builds_plan_and_rejects_duplicates(services, fake_llm):
    await approve_all_facts()
    await make_item("short_post")  # «недавняя тема» для проверки повторов
    fake_llm.handlers["PlanDraft"] = plan_handler
    result = await generate_plan(services, horizon_days=7)
    async with session_scope() as s:
        plan = (await s.execute(select(ContentPlan))).scalar_one()
        items = (await s.execute(select(ContentItem).where(ContentItem.plan_id == plan.id).order_by(ContentItem.planned_at))).scalars().all()
    assert fake_llm.schemas_called() == ["PlanDraft", "PlanDraft"]  # второй раунд — замена отклонённых
    assert result.created == len(items) and 30 <= len(items) <= 35
    assert all(i.status == ContentStatus.idea and i.planned_at > utcnow() for i in items)
    assert "story" not in {i.format for i in items}
    assert len({i.topic for i in items}) == len(items)
    gaps = [(b.planned_at - a.planned_at) for a, b in zip(items, items[1:]) if a.planned_at.date() == b.planned_at.date()]
    assert all(g >= timedelta(minutes=90) for g in gaps)
    second_prompt = [c.prompt for c in fake_llm.calls][1]
    assert "отклонён проверкой" in second_prompt
    # Повторный запуск не дублирует уже заполненные слоты.
    again = await generate_plan(services, horizon_days=7)
    assert again.created == 0 or again.created <= 2
