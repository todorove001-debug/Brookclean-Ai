"""Бот согласования: авторизация по Telegram ID, кнопки, диалоги, команды."""

import pytest
from sqlalchemy import select

from app.approval.bot import ApprovalBot
from app.database.enums import ContentStatus
from app.database.models import AnalyticsSnapshot, AuditLog, ContentItem
from app.database.session import session_scope
from tests.helpers import (
    OWNER_TG,
    approve_all_facts,
    clean_review,
    copy_handler,
    item,
    make_item,
    make_users,
    run_worker,
)

pytestmark = pytest.mark.usefixtures("db")


def message(tg_id, text, username="owner"):
    return {"update_id": 1, "message": {"message_id": 5, "chat": {"id": tg_id, "type": "private"},
                                        "from": {"id": tg_id, "username": username}, "text": text}}


def last_text(fake_tg):
    return next(m["text"] for m in reversed(fake_tg.sent) if m["method"] == "sendMessage")


def callback(tg_id, data):
    return {"update_id": 2, "callback_query": {"id": "cb1", "from": {"id": tg_id}, "data": data,
                                               "message": {"message_id": 77, "chat": {"id": tg_id}}}}


@pytest.fixture
async def bot(services, fake_llm):
    await make_users()
    await approve_all_facts()
    fake_llm.handlers.update({"CopyDraft": copy_handler(), "LLMReview": clean_review})
    return ApprovalBot(services)


async def test_unknown_user_rejected_even_with_owner_username(bot, fake_tg):
    await bot.handle_update(message(999, "/drafts", username="owner"))
    assert fake_tg.sent[-1]["text"].startswith("Нет доступа")
    async with session_scope() as s:
        assert (await s.execute(select(AuditLog).where(AuditLog.action == "bot.unauthorized"))).scalar_one()


async def test_unknown_user_cannot_press_buttons(bot, fake_tg, services):
    item_id = await make_item()
    await run_worker(services)
    version = (await item(item_id)).current_version_id
    await bot.handle_update(callback(999, f"ap:{version.hex}"))
    assert fake_tg.sent[-1] == {"method": "answerCallbackQuery", "text": "Нет доступа", "show_alert": True}
    assert (await item(item_id)).status == ContentStatus.awaiting_approval


async def test_approve_button_and_changes_dialog(bot, fake_tg, services, fake_llm):
    item_id = await make_item()
    await run_worker(services)
    v1 = (await item(item_id)).current_version_id
    # Правки: кнопка → текст → новая версия.
    await bot.handle_update(callback(OWNER_TG, f"ed:{v1.hex}"))
    assert "что изменить" in last_text(fake_tg)
    await bot.handle_update(message(OWNER_TG, "Добавьте совет про зимнюю погрузку"))
    assert "Правки приняты" in last_text(fake_tg)
    await run_worker(services)
    v2 = (await item(item_id)).current_version_id
    assert v2 != v1
    # Старая кнопка больше не работает.
    await bot.handle_update(callback(OWNER_TG, f"ap:{v1.hex}"))
    alert = fake_tg.sent[-1]
    assert alert["method"] == "answerCallbackQuery" and alert["show_alert"] and "устарела" in alert["text"]
    await bot.handle_update(callback(OWNER_TG, f"ap:{v2.hex}"))
    assert (await item(item_id)).status == ContentStatus.scheduled
    assert any(m["method"] == "editMessageReplyMarkup" for m in fake_tg.sent)


async def test_reschedule_buttons(bot, fake_tg, services):
    item_id = await make_item()
    await run_worker(services)
    v = (await item(item_id)).current_version_id
    await bot.handle_update(callback(OWNER_TG, f"ap:{v.hex}"))
    await bot.handle_update(callback(OWNER_TG, f"rs:{v.hex}"))
    keyboard = next(m for m in reversed(fake_tg.sent) if m.get("reply_markup"))["reply_markup"]["inline_keyboard"]
    slot = keyboard[1][0]["callback_data"]
    assert slot.startswith(f"sl:{v.hex}:")
    await bot.handle_update(callback(OWNER_TG, slot))
    assert "Время публикации" in last_text(fake_tg)
    it = await item(item_id)
    assert int(slot.rsplit(":", 1)[1], 16) * 60 == int(it.scheduled_at.timestamp())


async def test_commands(bot, fake_tg, services):
    await make_item()
    await run_worker(services)
    for command in ("/help", "/drafts", "/plan", "/queue", "/costs", "/errors", "/pause тест", "/resume"):
        await bot.handle_update(message(OWNER_TG, command))
        assert fake_tg.sent[-1]["method"] == "sendMessage", command
    texts = [m.get("text", "") for m in fake_tg.sent]
    assert any("Расходы" in t for t in texts) and any("приостановлена" in t for t in texts) and any("возобновлена" in t for t in texts)


async def test_story_command_creates_item_with_owner_brief(bot, fake_tg):
    await bot.handle_update(message(OWNER_TG, "/story Привезли Toyota Prius из Владивостока в Тюмень, клиент забрал машину на площадке"))
    async with session_scope() as s:
        created = (await s.execute(select(ContentItem).where(ContentItem.format == "story"))).scalar_one()
    assert created.owner_brief.startswith("Привезли") and "Добавлено" in fake_tg.sent[-1]["text"]


async def test_editor_cannot_pause(bot, fake_tg):
    await bot.handle_update(message(333, "/pause"))
    assert "прав" in fake_tg.sent[-1]["text"]


async def test_reaction_count_update_saved(bot):
    await bot.handle_update({"update_id": 3, "message_reaction_count": {
        "chat": {"id": -100123}, "message_id": 42, "date": 1, "reactions": [{"type": {"type": "emoji", "emoji": "👍"}, "total_count": 5}]}})
    async with session_scope() as s:
        snap = (await s.execute(select(AnalyticsSnapshot))).scalar_one()
    assert snap.reactions_total == 5 and snap.message_id == 42
