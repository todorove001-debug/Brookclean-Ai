"""Admin API: авторизация, RBAC, загрузка файлов, настройки, ссылки, вебхук."""

from pathlib import Path

import httpx
import pytest
from asgi_lifespan import LifespanManager
from pydantic import SecretStr
from sqlalchemy import select

from app.api.main import create_app
from app.database.enums import UserRole
from app.database.models import CompanyFact, LinkClick, Task, TrackedLink, User
from app.database.session import session_scope
from app.security.rbac import new_api_token
from tests.conftest import requires_ffmpeg
from tests.fakes import make_test_video

pytestmark = pytest.mark.usefixtures("db")


async def token_for(role: UserRole, tg: int | None = None) -> str:
    token, digest, prefix = new_api_token()
    async with session_scope() as s:
        s.add(User(display_name=role.value, role=role, telegram_user_id=tg, api_token_hash=digest, api_token_prefix=prefix))
    return token


@pytest.fixture
async def client(services):
    app = create_app(services)
    async with LifespanManager(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://factory.example") as c:
        yield c


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_authentication_and_rbac(client):
    assert (await client.get("/api/v1/me")).status_code == 401
    assert (await client.get("/api/v1/me", headers=auth("cf_wrong"))).status_code == 401
    owner, editor = await token_for(UserRole.owner, 1), await token_for(UserRole.editor)
    assert (await client.get("/api/v1/me", headers=auth(owner))).json()["role"] == "owner"
    assert (await client.get("/api/v1/budget", headers=auth(editor))).status_code == 403
    assert (await client.get("/api/v1/users", headers=auth(editor))).status_code == 403
    users = (await client.get("/api/v1/users", headers=auth(owner))).json()
    assert all("api_token_hash" not in u for u in users)


async def test_budget_and_facts(client):
    owner = await token_for(UserRole.owner)
    admin = await token_for(UserRole.admin)
    budget = (await client.get("/api/v1/budget", headers=auth(owner))).json()["settings"]
    bad = {**budget, "warn_thresholds": [1.5]}
    assert (await client.put("/api/v1/budget", json=bad, headers=auth(owner))).status_code == 422
    assert (await client.put("/api/v1/budget", json={**budget, "daily_limit_usd": "20"}, headers=auth(admin))).status_code == 403
    ok = await client.put("/api/v1/budget", json={**budget, "daily_limit_usd": "20"}, headers=auth(owner))
    assert ok.status_code == 200 and ok.json()["settings"]["daily_limit_usd"] == "20"
    r = await client.put("/api/v1/facts", headers=auth(owner), json={"category": "contact", "key": "contact.tg", "statement": "Менеджер в Telegram: @brook", "approve": True})
    assert r.status_code == 200 and r.json()["approved_at"]
    async with session_scope() as s:
        fact = (await s.execute(select(CompanyFact).where(CompanyFact.key == "contact.tg"))).scalar_one()
    assert fact.approved_by_user_id is not None


async def test_create_item_queues_pipeline(client):
    editor = await token_for(UserRole.editor)
    r = await client.post("/api/v1/items", headers=auth(editor), json={"format": "short_post", "topic": "Зимняя погрузка автомобиля"})
    assert r.status_code == 201
    async with session_scope() as s:
        task = (await s.execute(select(Task).where(Task.name == "pipeline.advance"))).scalar_one()
    assert task.payload["item_id"] == r.json()["id"]
    story = await client.post("/api/v1/items", headers=auth(editor), json={"format": "story", "topic": "История"})
    assert story.status_code == 422


@requires_ffmpeg
async def test_media_upload_validation(client, tmp_path: Path):
    editor, owner = await token_for(UserRole.editor), await token_for(UserRole.owner)
    video = make_test_video(tmp_path / "v.mp4", seconds=2)
    r = await client.post("/api/v1/media", headers=auth(editor), data={"purpose": "source", "rights_confirmed": "true"},
                          files={"file": ("v.mp4", video.read_bytes(), "video/mp4")})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "source_video" and body["width"] == 1280 and body["rights_confirmed"] is False  # редактор не подтверждает права
    rights = await client.put(f"/api/v1/media/{body['id']}/rights", headers=auth(owner), json={"license": "own", "confirmed": True})
    assert rights.json()["rights_confirmed"] is True
    exe = await client.post("/api/v1/media", headers=auth(editor), files={"file": ("x.mp4", b"MZ\x90\x00" * 100, "video/mp4")})
    assert exe.status_code == 415
    broken = await client.post("/api/v1/media", headers=auth(editor), files={"file": ("b.mp4", b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 500, "video/mp4")})
    assert broken.status_code == 422
    assert (await client.get(f"/api/v1/media/{body['id']}/content")).status_code == 401
    content = await client.get(f"/api/v1/media/{body['id']}/content", headers=auth(owner))
    assert content.status_code == 200 and content.content == video.read_bytes()


async def test_tracked_link_redirect(client):
    async with session_scope() as s:
        s.add(TrackedLink(code="abc123", target_url="https://t.me/brookclean_manager"))
    r = await client.get("/r/abc123", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "https://t.me/brookclean_manager"
    assert (await client.get("/r/zzz999")).status_code == 404
    async with session_scope() as s:
        link = (await s.execute(select(TrackedLink))).scalar_one()
        clicks = (await s.execute(select(LinkClick))).scalars().all()
    assert link.clicks == 1 and len(clicks) == 1


async def test_webhook_requires_secret(client, services, fake_tg):
    update = {"update_id": 1, "message": {"message_id": 1, "chat": {"id": 555, "type": "private"}, "from": {"id": 555}, "text": "/help"}}
    assert (await client.post("/telegram/webhook", json=update)).status_code == 403
    services.settings.telegram_webhook_secret = SecretStr("s3cret")
    try:
        assert (await client.post("/telegram/webhook", json=update, headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"})).status_code == 403
        ok = await client.post("/telegram/webhook", json=update, headers={"X-Telegram-Bot-Api-Secret-Token": "s3cret"})
        assert ok.status_code == 200
        assert fake_tg.sent[-1]["text"].startswith("Нет доступа")
    finally:
        services.settings.telegram_webhook_secret = None


async def test_health_metrics_and_panel(client):
    ready = await client.get("/health/ready")
    assert ready.status_code == 200 and ready.json()["checks"]["database"] == "ok"
    assert "cf_tasks_total" in (await client.get("/metrics")).text or (await client.get("/metrics")).status_code == 200
    panel = await client.get("/admin/")
    assert panel.status_code == 200 and "default-src 'self'" in panel.headers["content-security-policy"]
    assert panel.headers["x-frame-options"] == "DENY"
