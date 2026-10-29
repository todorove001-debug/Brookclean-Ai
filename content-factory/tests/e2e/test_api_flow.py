"""Сквозной сценарий через HTTP API: идея → черновик → согласование → публикация → отчёт."""

from datetime import timedelta

import httpx
import pytest
from asgi_lifespan import LifespanManager
from sqlalchemy import update

from app.api.main import create_app
from app.database.enums import UserRole
from app.database.models import ContentItem, User
from app.database.session import session_scope, utcnow
from app.orchestration.queue import enqueue
from app.security.rbac import new_api_token
from tests.helpers import approve_all_facts, clean_review, copy_handler, run_worker

pytestmark = pytest.mark.usefixtures("db")


async def test_full_flow_over_http(services, fake_llm, fake_tg):
    await approve_all_facts()
    fake_llm.handlers.update({"CopyDraft": copy_handler(), "LLMReview": clean_review})
    token, digest, prefix = new_api_token()
    async with session_scope() as s:
        s.add(User(display_name="Владелец", role=UserRole.owner, telegram_user_id=111, api_token_hash=digest, api_token_prefix=prefix))
    headers = {"Authorization": f"Bearer {token}"}
    app = create_app(services)
    async with LifespanManager(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://f.example") as c:
        created = await c.post("/api/v1/items", headers=headers, json={"format": "short_post", "topic": "Как подготовить машину к автовозу",
                                                                       "cta_target": "manager", "cta": "Спросите менеджера"})
        item_id = created.json()["id"]
        await run_worker(services)
        detail = (await c.get(f"/api/v1/items/{item_id}", headers=headers)).json()
        assert detail["item"]["status"] == "awaiting_approval"
        version = detail["versions"][-1]
        assert version["frozen_at"] and version["content_hash"]

        wrong = await c.post(f"/api/v1/items/{item_id}/approve", headers=headers, json={"version_id": item_id})
        assert wrong.status_code == 409
        ok = await c.post(f"/api/v1/items/{item_id}/approve", headers=headers, json={"version_id": version["id"]})
        assert ok.status_code == 200, ok.text

        async with session_scope() as s:
            await s.execute(update(ContentItem).values(scheduled_at=utcnow() - timedelta(minutes=1)))
            await enqueue(s, "publish.dispatch", {})
        await run_worker(services)

        detail = (await c.get(f"/api/v1/items/{item_id}", headers=headers)).json()
        assert detail["item"]["status"] == "published"
        assert [e["action"] for e in detail["approval_history"]] == ["submitted", "approve"]
        report = (await c.get("/api/v1/analytics/report?days=7", headers=headers)).json()
        assert report["publications"] == 1 and report["publishing_success_rate"] == 1.0
        costs = (await c.get("/api/v1/monitoring/costs", headers=headers)).json()
        assert costs["month_usd"] > 0 and any(r["operation"] == "agent.copywriter" for r in costs["by_operation"])
        audit = (await c.get(f"/api/v1/audit?entity_id={item_id}", headers=headers)).json()
        assert any(a["action"] == "publishing.published" for a in audit)
    assert [m["method"] for m in fake_tg.sent if m["chat_id"] == "@brookclean_test_channel"] == ["sendMessage"]
