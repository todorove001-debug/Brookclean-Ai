"""Настройки владельца: запрет цен, утверждённые сведения из файла, загрузка историй."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import select

from app.agents.qa import check_prices_forbidden
from app.content.channel import get_channel, sync_facts
from app.database.models import CompanyFact, ContentItem
from app.database.session import session_scope
from app.settings.channel import FactSeed, load_channel_settings

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.usefixtures("db")


def test_production_config_rules():
    s = load_channel_settings(ROOT / "config" / "channel.yaml")
    assert s.qa.publish_prices is False and s.budget.monthly_limit_usd == 250 and s.budget.video_generations_per_month == 0
    assert all("₽" not in f.statement and "руб" not in f.statement for f in s.approved_facts)
    # Утверждённые факты не должны «разрешать» гарантии: в них нет слова «гарантия».
    assert all("гарант" not in f.statement.lower() for f in s.approved_facts if f.approved)


def test_prices_blocked():
    findings = check_prices_forbidden("Доставка в Москву — 175 000 ₽ за седан.")
    assert findings and findings[0].severity == "blocking"
    assert not check_prices_forbidden("Ориентировочный срок: летом 10–12 дней.")


async def test_sync_facts_adds_missing_and_approves_confirmed():
    async with session_scope() as s:
        channel = await get_channel(s)
        added = await sync_facts(s, channel.id, [FactSeed(key="term.x", category="terms", statement="Срок 6–8 дней.", approved=True),
                                                  FactSeed(key="contact.addr", category="contact", statement="Адрес.")])
        again = await sync_facts(s, channel.id, [FactSeed(key="term.x", statement="Другое", approved=True)])
        facts = {f.key: f for f in (await s.execute(select(CompanyFact))).scalars()}
    assert added == ["term.x", "contact.addr"] and again == []
    assert facts["term.x"].approved_at is not None and facts["term.x"].statement == "Срок 6–8 дней."
    assert facts["contact.addr"].approved_at is None


def test_stories_load_idempotent(migrated_db):
    env = {**os.environ, "DATABASE_URL": migrated_db}
    first = subprocess.run([sys.executable, "-m", "app.cli", "stories", "load"], cwd=ROOT, env=env, capture_output=True, text=True)
    second = subprocess.run([sys.executable, "-m", "app.cli", "stories", "load"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    assert "Историй добавлено: 4" in first.stdout and "Историй добавлено: 0" in second.stdout


async def test_loaded_story_has_owner_brief():
    subprocess.run([sys.executable, "-m", "app.cli", "stories", "load"], cwd=ROOT, check=True, capture_output=True)
    async with session_scope() as s:
        items = (await s.execute(select(ContentItem).where(ContentItem.format == "story"))).scalars().all()
    pod = next(i for i in items if "C+pod" in i.topic)
    assert "Челябинск" in pod.owner_brief and pod.rubric == "cases" and pod.planned_at is not None
