from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.approval import service as approval
from app.content.service import new_version
from app.database.enums import ApprovalAction, ContentStatus, PublishingJobStatus, QAStatus
from app.database.models import (
    ApprovalEvent,
    ContentItem,
    ContentVersion,
    Notification,
    PublishingJob,
    PublishingResult,
    TrackedLink,
)
from app.database.session import session_scope, utcnow
from app.orchestration.queue import enqueue
from app.providers.telegram.client import TelegramError
from tests.helpers import (
    OWNER_TG,
    approve_all_facts,
    clean_review,
    copy_handler,
    item,
    make_item,
    make_users,
    run_worker,
    user,
)

pytestmark = pytest.mark.usefixtures("db")
CHANNEL = "@brookclean_test_channel"


@pytest.fixture
async def ready(services, fake_llm):
    await make_users()
    await approve_all_facts()
    fake_llm.handlers.update({"CopyDraft": copy_handler(), "LLMReview": clean_review})
    return services


async def to_approval(services, **kw):
    item_id = await make_item(**kw)
    await run_worker(services)
    return item_id


async def approve_and_make_due(item_id):
    owner = await user(OWNER_TG)
    it = await item(item_id)
    async with session_scope() as s:
        result = await approval.approve(s, owner, item_id, it.current_version_id)
    async with session_scope() as s:
        await s.execute(update(ContentItem).where(ContentItem.id == item_id).values(scheduled_at=utcnow() - timedelta(minutes=1)))
    return result


async def dispatch(services):
    async with session_scope() as s:
        await enqueue(s, "publish.dispatch", {})
    await run_worker(services)


async def channel_posts(fake_tg):
    return [m for m in fake_tg.sent if m["chat_id"] == CHANNEL]


async def test_full_text_pipeline_and_single_publication(ready, fake_tg, fake_llm):
    item_id = await to_approval(ready)
    it = await item(item_id)
    assert it.status == ContentStatus.awaiting_approval
    async with session_scope() as s:
        version = await s.get(ContentVersion, it.current_version_id)
        link = (await s.execute(select(TrackedLink))).scalar_one()
    assert version.frozen_at is not None and version.content_hash and version.qa_status == QAStatus.passed
    assert f"https://factory.example/r/{link.code}" in version.body_html
    assert fake_llm.schemas_called() == ["CopyDraft", "LLMReview"]
    # Владельцу пришли текст поста и карточка с кнопками, привязанными к версии.
    cards = [m for m in fake_tg.to_chat(OWNER_TG) if m.get("reply_markup")]
    buttons = [b["callback_data"] for row in cards[-1]["reply_markup"]["inline_keyboard"] for b in row]
    assert f"ap:{version.id.hex}" in buttons and all(len(b.encode()) <= 64 for b in buttons)

    result = await approve_and_make_due(item_id)
    assert "запланирована" in result.message
    await dispatch(ready)
    posts = await channel_posts(fake_tg)
    assert len(posts) == 1 and posts[0]["method"] == "sendMessage" and "Пять шагов" in posts[0]["text"]
    it = await item(item_id)
    assert it.status == ContentStatus.published and it.published_at
    async with session_scope() as s:
        res = (await s.execute(select(PublishingResult))).scalar_one()
        job = (await s.execute(select(PublishingJob))).scalar_one()
    assert res.primary_message_id == posts[0]["message_id"] and job.status == PublishingJobStatus.succeeded

    # Повторная доставка задачи публикации не создаёт дубль.
    async with session_scope() as s:
        await enqueue(s, "publish.item", {"item_id": str(item_id)})
    await run_worker(ready)
    assert len(await channel_posts(fake_tg)) == 1


async def test_change_after_approval_blocks_publication(ready, fake_tg):
    item_id = await to_approval(ready)
    await approve_and_make_due(item_id)
    async with session_scope() as s:
        it = await s.get(ContentItem, item_id, with_for_update=True)
        await new_version(s, it, title="Подменённый текст", body_html="Другое содержание", origin="manual")
    await dispatch(ready)
    assert await channel_posts(fake_tg) == []
    it = await item(item_id)
    assert it.status == ContentStatus.failed and "не одобрен" in it.last_error
    async with session_scope() as s:
        notes = [n.text for n in (await s.execute(select(Notification))).scalars()]
    assert any("остановлена" in n for n in notes)


async def test_unapproved_or_cancelled_never_published(ready, fake_tg):
    item_id = await to_approval(ready)
    async with session_scope() as s:  # время наступило, но одобрения нет
        await s.execute(update(ContentItem).where(ContentItem.id == item_id).values(scheduled_at=utcnow() - timedelta(minutes=5)))
    await dispatch(ready)
    assert await channel_posts(fake_tg) == []
    await approve_and_make_due(item_id)
    owner = await user(OWNER_TG)
    async with session_scope() as s:
        await approval.cancel(s, owner, item_id)
    await dispatch(ready)
    assert await channel_posts(fake_tg) == [] and (await item(item_id)).status == ContentStatus.cancelled


async def test_approver_losing_rights_blocks_publication(ready, fake_tg):
    item_id = await to_approval(ready)
    await approve_and_make_due(item_id)
    owner = await user(OWNER_TG)
    async with session_scope() as s:
        o = await s.get(type(owner), owner.id)
        o.is_active = False
    await dispatch(ready)
    assert await channel_posts(fake_tg) == []
    assert "права" in (await item(item_id)).last_error


async def test_pause_holds_queue(ready, fake_tg):
    item_id = await to_approval(ready)
    await approve_and_make_due(item_id)
    owner = await user(OWNER_TG)
    async with session_scope() as s:
        await approval.set_paused(s, owner, True, "проверка")
    await dispatch(ready)
    assert await channel_posts(fake_tg) == [] and (await item(item_id)).status == ContentStatus.scheduled
    async with session_scope() as s:
        await approval.set_paused(s, owner, False)
    await dispatch(ready)
    assert len(await channel_posts(fake_tg)) == 1


async def test_lost_response_is_uncertain_without_retry(ready, fake_tg):
    item_id = await to_approval(ready)
    await approve_and_make_due(item_id)
    fake_tg.fail_next = TelegramError("обрыв при обмене с Telegram: ReadTimeout", request_sent=True)
    await dispatch(ready)
    async with session_scope() as s:
        job = (await s.execute(select(PublishingJob))).scalar_one()
    assert job.status == PublishingJobStatus.uncertain
    assert (await item(item_id)).status == ContentStatus.failed
    await dispatch(ready)
    assert await channel_posts(fake_tg) == []  # автоповтора нет


async def test_not_sent_error_is_retried_once_safely(ready, fake_tg):
    item_id = await to_approval(ready)
    await approve_and_make_due(item_id)
    fake_tg.fail_next = TelegramError("нет соединения с Telegram", request_sent=False)
    await dispatch(ready)
    assert (await item(item_id)).status == ContentStatus.scheduled
    async with session_scope() as s:  # повтор задачи наступил
        await s.execute(update(__import__("app.database.models", fromlist=["Task"]).Task).values(run_at=utcnow()))
    await run_worker(ready)
    assert len(await channel_posts(fake_tg)) == 1 and (await item(item_id)).status == ContentStatus.published


async def test_qa_failure_auto_fix_then_cannot_approve(ready, fake_llm):
    bad = copy_handler(body="Мы гарантируем доставку за 5 дней всего за 50 000 рублей. Клиенты пишут отличные отзывы о перевозке автомобилей.")
    fake_llm.handlers["CopyDraft"] = bad
    item_id = await to_approval(ready)
    assert fake_llm.schemas_called().count("CopyDraft") == 2  # одно автоисправление
    it = await item(item_id)
    async with session_scope() as s:
        version = await s.get(ContentVersion, it.current_version_id)
    assert it.status == ContentStatus.awaiting_approval and version.qa_status == QAStatus.failed
    codes = {f["code"] for f in version.qa_report["findings"]}
    assert "unsupported_company_claim" in codes
    owner = await user(OWNER_TG)
    with pytest.raises(approval.ApprovalError, match="проверки"):
        async with session_scope() as s:
            await approval.approve(s, owner, item_id, version.id)


async def test_supported_price_from_approved_fact_passes(ready, fake_llm):
    fake_llm.handlers["CopyDraft"] = copy_handler(
        body="Перевозка седана Владивосток — Москва стоит от 150 000 рублей. Компания перевозит легковые автомобили автовозами.")
    item_id = await to_approval(ready, fmt="ad", rubric="service")
    async with session_scope() as s:
        version = await s.get(ContentVersion, (await item(item_id)).current_version_id)
    assert version.qa_status in {QAStatus.passed, QAStatus.needs_review}, version.qa_report


async def test_request_changes_creates_new_version_and_old_buttons_stale(ready, fake_llm):
    item_id = await to_approval(ready)
    first = (await item(item_id)).current_version_id
    owner = await user(OWNER_TG)
    async with session_scope() as s:
        await approval.request_changes(s, owner, item_id, first, "Сделайте заголовок короче")
    fake_llm.handlers["CopyDraft"] = copy_handler(title="Подготовка машины к автовозу")
    await run_worker(ready)
    it = await item(item_id)
    assert it.status == ContentStatus.awaiting_approval and it.current_version_id != first
    copy_prompt = [c.prompt for c in fake_llm.calls if c.schema == "CopyDraft"][-1]
    assert "Сделайте заголовок короче" in copy_prompt and "<untrusted" in copy_prompt
    with pytest.raises(approval.ApprovalError, match="устарела"):
        async with session_scope() as s:
            await approval.approve(s, owner, item_id, first)
    async with session_scope() as s:
        actions = [e.action for e in (await s.execute(select(ApprovalEvent).where(ApprovalEvent.item_id == item_id)
                                                     .order_by(ApprovalEvent.created_at))).scalars()]
    assert actions == [ApprovalAction.submitted, ApprovalAction.request_changes, ApprovalAction.submitted]


async def test_editor_cannot_approve(ready):
    item_id = await to_approval(ready)
    editor = await user(333)
    with pytest.raises(approval.ApprovalError, match="прав"):
        async with session_scope() as s:
            await approval.approve(s, editor, item_id, (await item(item_id)).current_version_id)


async def test_poll_published_with_poll_id(ready, fake_llm, fake_tg):
    fake_llm.handlers["CopyDraft"] = copy_handler(
        title="Опрос", body="", poll={"question": "Как вы обычно перевозите автомобиль?", "options": ["Автовозом", "Сам за рулём", "Поездом"]})
    item_id = await to_approval(ready, fmt="poll")
    await approve_and_make_due(item_id)
    await dispatch(ready)
    posts = await channel_posts(fake_tg)
    assert [p["method"] for p in posts] == ["sendPoll"]
    async with session_scope() as s:
        res = (await s.execute(select(PublishingResult))).scalar_one()
    assert res.response["poll_id"]
