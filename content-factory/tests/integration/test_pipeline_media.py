"""Медиа-конвейер: обложка по шаблону, монтаж исходников FFmpeg, ИИ-сцены через подставной генератор."""

from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import select, update

from app.approval import service as approval
from app.content.service import load_version
from app.database.enums import ContentStatus, MediaKind, MediaOrigin, VideoJobKind, VideoJobStatus
from app.database.models import ContentItem, ContentVersion, MediaAsset, Task, VideoJob
from app.database.session import session_scope, utcnow
from app.media.assets import store_file
from app.orchestration.queue import enqueue
from app.providers.base import ProviderUnavailable
from app.video.edl import EDL
from tests.conftest import requires_ffmpeg
from tests.fakes import FakeVideoGenerator, make_test_video
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

pytestmark = [pytest.mark.usefixtures("db"), requires_ffmpeg]
CHANNEL = "@brookclean_test_channel"

SCRIPT = {
    "aspect": "9:16",
    "target_duration_s": 12,
    "scenes": [
        {"duration_s": 2, "shot": "title_card", "description": "Титр", "on_screen_text": "Погрузка на автовоз"},
        {"duration_s": 4, "shot": "source", "description": "Машина заезжает на платформу",
         "voiceover": "Машину аккуратно закатывают на платформу"},
        {"duration_s": 4, "shot": "ai", "description": "Автовоз на трассе в Приморье", "voiceover": "Дальше — дорога через всю страну"},
    ],
}


def video_copy():
    return copy_handler(title="Как машину грузят на автовоз", body="Показываем погрузку автомобиля на автовоз: от заезда на платформу до крепления колёс.",
                        video_script=SCRIPT)


def visual_review(prompt):
    return {"ok": True, "issues": []}


@pytest.fixture
async def media_ready(services, fake_llm, tmp_path):
    await make_users()
    await approve_all_facts()
    fake_llm.handlers.update({"LLMReview": clean_review, "VisualReview": visual_review,
                              "ScenePrompts": lambda p: {"scenes": [{"scene_index": 2, "prompt": "Car carrier truck driving on a highway"}]}})
    return services


async def upload_source(services, item_id, tmp_path: Path, *, rights=True):
    path = make_test_video(tmp_path / "src.mp4", seconds=9)
    async with session_scope() as s:
        asset = await store_file(s, services.storage, path, kind=MediaKind.source_video, origin=MediaOrigin.owner_upload, mime="video/mp4",
                                 item_id=item_id, title="Погрузка", rights={"license": "own"}, rights_confirmed=rights)
        return asset.id


async def video_item(services, tmp_path, rights=True):
    item_id = await make_item("video", topic="Как машину грузят на автовоз")
    async with session_scope() as s:  # подготовка не стартует, пока не загружены исходники
        await s.execute(update(Task).values(run_at=utcnow() + timedelta(days=1)))
    source_id = await upload_source(services, item_id, tmp_path, rights=rights)
    async with session_scope() as s:
        await s.execute(update(Task).values(run_at=utcnow()))
    return item_id, source_id


async def test_image_post_gets_branded_cover_and_publishes_photo(media_ready, fake_llm, fake_tg):
    fake_llm.handlers["CopyDraft"] = copy_handler(image_brief={"headline": "Пять шагов подготовки", "subline": "Перед погрузкой во Владивостоке"})
    item_id = await make_item("image_post")
    await run_worker(media_ready)
    it = await item(item_id)
    assert it.status == ContentStatus.awaiting_approval, it.last_error
    async with session_scope() as s:
        version = await s.get(ContentVersion, it.current_version_id)
        cover = (await s.execute(select(MediaAsset).where(MediaAsset.kind == MediaKind.cover))).scalar_one()
    assert cover.width == 1280 and cover.render_params["template"] == "cover_text" and cover.rights_confirmed
    assert version.qa_status in {"passed", "needs_review"}, version.qa_report
    owner = await user(OWNER_TG)
    async with session_scope() as s:
        await approval.approve(s, owner, item_id, version.id)
        await s.execute(update(ContentItem).values(scheduled_at=utcnow() - timedelta(minutes=1)))
        await enqueue(s, "publish.dispatch", {})
    await run_worker(media_ready)
    posts = [m for m in fake_tg.sent if m["chat_id"] == CHANNEL]
    assert [p["method"] for p in posts] == ["sendPhoto"] and "Пять шагов" in posts[0]["caption"]


async def test_video_with_source_footage_and_ai_scene(media_ready, fake_llm, fake_tg, tmp_path):
    fake_llm.handlers["CopyDraft"] = video_copy()
    generator = FakeVideoGenerator(tmp_path, polls_until_done=1)
    media_ready.video = generator
    item_id, source_id = await video_item(media_ready, tmp_path)
    await run_worker(media_ready)
    # Опрос генерации отложен на интервал — «проматываем» время.
    for _ in range(4):
        async with session_scope() as s:
            await s.execute(update(Task).where(Task.status == "queued").values(run_at=utcnow()))
        await run_worker(media_ready)
    it = await item(item_id)
    assert it.status == ContentStatus.awaiting_approval, it.last_error
    async with session_scope() as s:
        version = await s.get(ContentVersion, it.current_version_id)
        render = (await s.execute(select(MediaAsset).where(MediaAsset.kind == MediaKind.render_video))).scalar_one()
        scene = (await s.execute(select(MediaAsset).where(MediaAsset.kind == MediaKind.ai_video_scene))).scalar_one()
        jobs = (await s.execute(select(VideoJob).order_by(VideoJob.created_at))).scalars().all()
    assert len(generator.submitted) == 1 and scene.is_synthetic
    assert [j.kind for j in jobs] == [VideoJobKind.ai_scene, VideoJobKind.assemble] and all(j.status == VideoJobStatus.succeeded for j in jobs)
    assert jobs[0].estimated_cost_usd and jobs[0].actual_cost_usd
    edl = EDL.model_validate(render.render_params["edl"])
    clip_sources = {s.source.asset_id for s in edl.segments if s.type == "clip"}
    assert clip_sources == {str(source_id), str(scene.id)}
    assert render.width == 1080 and render.height == 1920 and render.duration_s == pytest.approx(edl.duration, abs=0.3)
    assert edl.subtitles and render.render_params["synthetic_scenes"] == [2]
    # В подписи — пометка о синтетических кадрах.
    assert "создана с помощью ИИ" in version.body_html
    assert version.qa_status in {"passed", "needs_review"}, version.qa_report
    async with session_scope() as s:
        roles = {link.role for link in (await load_version(s, version.id)).media_links}
    assert roles == {"primary", "thumbnail"}
    owner = await user(OWNER_TG)
    async with session_scope() as s:
        await approval.approve(s, owner, item_id, version.id)
        await s.execute(update(ContentItem).values(scheduled_at=utcnow() - timedelta(minutes=1)))
        await enqueue(s, "publish.dispatch", {})
    await run_worker(media_ready)
    posts = [m for m in fake_tg.sent if m["chat_id"] == CHANNEL]
    assert [p["method"] for p in posts] == ["sendVideo"] and posts[0]["thumbnail"] and posts[0]["height"] == 1920


async def test_video_provider_unavailable_waits_not_fakes(media_ready, fake_llm, tmp_path):
    fake_llm.handlers["CopyDraft"] = video_copy()
    media_ready.video = FakeVideoGenerator(tmp_path, fail_submit=ProviderUnavailable("503", provider="openai_sora", retry_after_s=120))
    item_id, _ = await video_item(media_ready, tmp_path)
    await run_worker(media_ready)
    async with session_scope() as s:
        job = (await s.execute(select(VideoJob))).scalar_one()
        submit_task = (await s.execute(select(Task).where(Task.name == "video.submit"))).scalar_one()
    assert job.status == VideoJobStatus.waiting_provider and "недоступен" in job.error
    assert submit_task.status == "queued" and submit_task.run_at > utcnow() + timedelta(seconds=60)
    it = await item(item_id)
    assert it.status == ContentStatus.media_generation  # ролик не собран и не выдан за готовый


async def test_failed_ai_scene_falls_back_with_warning(media_ready, fake_llm, tmp_path):
    fake_llm.handlers["CopyDraft"] = video_copy()
    generator = FakeVideoGenerator(tmp_path, polls_until_done=0)
    generator.final_state = "failed"
    media_ready.video = generator
    item_id, _ = await video_item(media_ready, tmp_path)
    for _ in range(6):
        async with session_scope() as s:
            await s.execute(update(Task).where(Task.status == "queued").values(run_at=utcnow()))
        await run_worker(media_ready)
    async with session_scope() as s:
        job = (await s.execute(select(VideoJob).where(VideoJob.kind == VideoJobKind.ai_scene))).scalar_one()
        version = await s.get(ContentVersion, (await item(item_id)).current_version_id)
    assert job.status == VideoJobStatus.failed and job.attempts == 2  # лимит: 1 повтор
    assert len(generator.submitted) == 2
    findings = " ".join(f["message"] for f in version.qa_report["findings"])
    assert "ИИ-сцена" in findings or "исходников" in findings


async def test_unconfirmed_rights_block_video(media_ready, fake_llm, tmp_path):
    fake_llm.handlers["CopyDraft"] = copy_handler(video_script={**SCRIPT, "scenes": SCRIPT["scenes"][:2]})
    item_id, _ = await video_item(media_ready, tmp_path, rights=False)
    await run_worker(media_ready)
    it = await item(item_id)
    # Исходник без подтверждённых прав не попадает в монтаж: роликов из одних титров не делаем.
    assert it.status == ContentStatus.failed and "исходников" in it.last_error


async def test_budget_stop_puts_job_in_waiting_budget(media_ready, fake_llm, tmp_path):
    from app.content.channel import get_channel, save_channel_settings

    fake_llm.handlers["CopyDraft"] = video_copy()
    media_ready.video = FakeVideoGenerator(tmp_path)
    async with session_scope() as s:
        channel = await get_channel(s, for_update=True)
        budget = channel.settings.budget.model_copy(update={"video_generations_per_month": 0})
        await save_channel_settings(s, channel, channel.settings.model_copy(update={"budget": budget}))
    item_id, _ = await video_item(media_ready, tmp_path)
    await run_worker(media_ready)
    async with session_scope() as s:
        job = (await s.execute(select(VideoJob).where(VideoJob.kind == VideoJobKind.ai_scene))).scalar_one()
    assert job.status == VideoJobStatus.waiting_budget and not media_ready.video.submitted
    # Ролик собран без ИИ-сцены, с пометкой для владельца.
    assert (await item(item_id)).status == ContentStatus.awaiting_approval
