"""Общие фикстуры. Тестам с базой нужен PostgreSQL: TEST_DATABASE_URL (по умолчанию локальный factory_test)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_TMP = Path(tempfile.mkdtemp(prefix="cf-tests-"))
TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://factory:factory@localhost:5432/factory_test")

os.environ.update({
    "ENVIRONMENT": "test",
    "DATABASE_URL": TEST_DB,
    "DB_POOL_SIZE": "5",
    "STORAGE_BACKEND": "local",
    "STORAGE_DIR": str(_TMP / "media"),
    "WORK_DIR": str(_TMP / "work"),
    "PUBLIC_BASE_URL": "https://factory.example",
    "CHANNEL_CONFIG_PATH": str(ROOT / "tests" / "fixtures" / "channel.yaml"),
    "TELEGRAM_CHANNEL_ID": "@brookclean_test_channel",
    "SPELLER_ENABLED": "false",
    "LOG_JSON": "false",
    "LOG_LEVEL": "WARNING",
    "ANTHROPIC_API_KEY": "",
    "TELEGRAM_BOT_TOKEN": "",
})
for key in ("OPENAI_API_KEY", "RUNWAY_API_KEY", "SENTRY_DSN", "METRICS_TOKEN", "TELEGRAM_WEBHOOK_SECRET"):
    os.environ.pop(key, None)

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.budget.pricing import PricingTable  # noqa: E402
from app.database.session import dispose_engine, get_engine  # noqa: E402
from app.orchestration.services import Services  # noqa: E402
from app.providers.storage.base import LocalStorage  # noqa: E402
from app.security.ssrf import SafeFetcher  # noqa: E402
from app.settings.config import get_settings, reset_settings_cache  # noqa: E402
from tests.fakes import FakeLLM, FakeTelegram  # noqa: E402

reset_settings_cache()
HAS_FFMPEG = shutil.which("ffmpeg") is not None


def _sync_url(url: str) -> str:
    return url.replace("+asyncpg", "+psycopg")


@pytest.fixture(scope="session")
def migrated_db() -> str:
    """Чистая схема и миграции один раз на прогон."""
    from sqlalchemy import create_engine

    engine = create_engine(_sync_url(TEST_DB))
    try:
        with engine.begin() as conn:
            conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"PostgreSQL недоступен ({TEST_DB}): {exc}")
    finally:
        engine.dispose()
    subprocess.run([sys.executable, "-m", "alembic", "-c", str(ROOT / "alembic.ini"), "upgrade", "head"], check=True, cwd=ROOT,
                   env={**os.environ, "DATABASE_URL": TEST_DB})
    return TEST_DB


TABLES = [
    "link_clicks", "tracked_links", "bot_conversations", "bot_state", "notifications", "tasks", "audit_logs", "provider_usage",
    "analytics_snapshots", "publishing_results", "publishing_jobs", "approval_events", "video_jobs", "version_media",
    "research_sources", "media_assets", "content_versions", "content_items", "content_plans", "company_facts", "channel_configs", "users",
]


@pytest_asyncio.fixture
async def db(migrated_db: str):  # noqa: ANN201
    engine = get_engine()
    async with engine.begin() as conn:
        # Триггер заморозки версий не даёт удалять строки — на время очистки он отключается.
        await conn.execute(text("SET session_replication_role = replica"))
        await conn.execute(text(f"TRUNCATE {', '.join(TABLES)} CASCADE"))
        await conn.execute(text("SET session_replication_role = DEFAULT"))
    yield engine
    await dispose_engine()


@pytest.fixture
def storage(tmp_path: Path) -> LocalStorage:
    return LocalStorage(tmp_path / "media")


@pytest.fixture
def fake_llm() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
def fake_tg() -> FakeTelegram:
    return FakeTelegram()


@pytest.fixture
def services(storage: LocalStorage, fake_llm: FakeLLM, fake_tg: FakeTelegram, tmp_path: Path) -> Services:
    settings = get_settings()
    settings.work_dir = tmp_path / "work"
    return Services(
        settings=settings, storage=storage, pricing=PricingTable.load(ROOT / "config" / "pricing.yaml"),
        fetcher=SafeFetcher(allow_private=True), llm=fake_llm, telegram=fake_tg,  # type: ignore[arg-type]
    )


requires_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="нужен FFmpeg")
