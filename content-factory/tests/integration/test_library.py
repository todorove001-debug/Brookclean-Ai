"""Библиотека съёмок: загрузка через бота, подбор кадров для монтажа и обложек."""


import pytest
from sqlalchemy import select

from app.approval.bot import ApprovalBot
from app.database.enums import ContentStatus, MediaKind, MediaOrigin
from app.database.models import ContentVersion, MediaAsset
from app.database.session import session_scope
from app.media.assets import store_bytes, store_file
from app.media.library import library, usage_counts
from tests.conftest import requires_ffmpeg
from tests.fakes import make_test_video
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


def video_message(tg_id, file_id, size, caption=None, kind="video"):
    msg = {"message_id": 9, "chat": {"id": tg_id, "type": "private"}, "from": {"id": tg_id}}
    if kind == "video":
        msg["video"] = {"file_id": file_id, "file_size": size, "duration": 6, "mime_type": "video/mp4"}
    elif kind == "photo":
        msg["photo"] = [{"file_id": "small", "file_size": 100, "width": 90}, {"file_id": file_id, "file_size": size, "width": 1280}]
    else:
        msg["document"] = {"file_id": file_id, "file_size": size, "mime_type": "application/pdf", "file_name": "act.pdf"}
    if caption:
        msg["caption"] = caption
    return {"update_id": 5, "message": msg}


def last_text(fake_tg):
    return next(m["text"] for m in reversed(fake_tg.sent) if m["method"] == "sendMessage")


@requires_ffmpeg
async def test_owner_uploads_video_through_bot(services, fake_tg, tmp_path):
    await make_users()
    data = make_test_video(tmp_path / "v.mp4", seconds=3).read_bytes()
    fake_tg.files["vid1"] = data
    bot = ApprovalBot(services)
    await bot.handle_update(video_message(OWNER_TG, "vid1", len(data), caption="Погрузка Prius на верхний ярус"))
    assert "сохранено в библиотеку" in last_text(fake_tg)
    async with session_scope() as s:
        asset = (await s.execute(select(MediaAsset))).scalar_one()
    assert asset.kind == MediaKind.source_video and asset.item_id is None and asset.rights_confirmed
    assert asset.title == "Погрузка Prius на верхний ярус" and asset.rights["channel"] == "telegram"
    assert asset.duration_s == pytest.approx(3, abs=0.2)


async def test_bot_upload_limits_and_permissions(services, fake_tg, tmp_path):
    await make_users()
    bot = ApprovalBot(services)
    await bot.handle_update(video_message(OWNER_TG, "big", 80 * 1024 * 1024))
    assert "больше 20 МБ" in last_text(fake_tg) and "/admin/" in last_text(fake_tg)
    await bot.handle_update(video_message(OWNER_TG, "doc", 1000, kind="document"))
    assert "только видео и фото" in last_text(fake_tg)
    fake_tg.files["junk"] = b"MZ\x90\x00" * 50
    await bot.handle_update(video_message(OWNER_TG, "junk", 200))
    assert "не принят" in last_text(fake_tg)
    await bot.handle_update(video_message(999, "junk", 200))
    assert "Нет доступа" in last_text(fake_tg)


async def test_editor_upload_needs_owner_rights_confirmation(services, fake_tg):
    import io

    from PIL import Image

    await make_users()
    buf = io.BytesIO()
    Image.linear_gradient("L").resize((1280, 720)).convert("RGB").save(buf, "JPEG")
    fake_tg.files["ph"] = buf.getvalue()
    await ApprovalBot(services).handle_update(video_message(333, "ph", len(buf.getvalue()), kind="photo", caption="Автовоз на площадке"))
    assert "подтвердит владелец" in last_text(fake_tg)
    async with session_scope() as s:
        asset = (await s.execute(select(MediaAsset))).scalar_one()
    assert asset.kind == MediaKind.source_image and not asset.rights_confirmed and asset.width == 1280


@requires_ffmpeg
async def test_library_prefers_least_used(services, tmp_path):
    async with session_scope() as s:
        a = await store_file(s, services.storage, make_test_video(tmp_path / "a.mp4", seconds=2), kind=MediaKind.source_video,
                             origin=MediaOrigin.owner_upload, mime="video/mp4", title="a", rights_confirmed=True)
        b = await store_file(s, services.storage, make_test_video(tmp_path / "b.mp4", seconds=2), kind=MediaKind.source_video,
                             origin=MediaOrigin.owner_upload, mime="video/mp4", title="b", rights_confirmed=True)
        await store_file(s, services.storage, make_test_video(tmp_path / "c.mp4", seconds=2), kind=MediaKind.source_video,
                         origin=MediaOrigin.owner_upload, mime="video/mp4", title="без прав", rights_confirmed=False)
        # Из «b» уже собран ролик — его очередь позже.
        await store_bytes(s, services.storage, b"x" * 10, kind=MediaKind.render_video, origin=MediaOrigin.rendered, mime="video/mp4",
                          parent_ids=[b.id])
        counts = await usage_counts(s, [a.id, b.id])
        ordered = await library(s, MediaKind.source_video)
    assert counts == {a.id: 0, b.id: 1}
    assert [x.title for x in ordered] == ["a", "b"]


@requires_ffmpeg
async def test_video_item_without_own_footage_uses_library(services, fake_llm, tmp_path):
    await make_users()
    await approve_all_facts()
    async with session_scope() as s:
        lib = await store_file(s, services.storage, make_test_video(tmp_path / "lib.mp4", seconds=8), kind=MediaKind.source_video,
                               origin=MediaOrigin.owner_upload, mime="video/mp4", title="Погрузка машины на автовоз", rights_confirmed=True)
    script = {"aspect": "9:16", "scenes": [{"duration_s": 4, "shot": "source", "description": "Погрузка", "voiceover": "Грузим машину"}]}
    fake_llm.handlers.update({
        "CopyDraft": copy_handler(title="Погрузка на автовоз", body="Показываем, как машину грузят на автовоз.", video_script=script),
        "LLMReview": clean_review,
        "SceneSelection": lambda prompt: {"scenes": [{"scene_index": 0, "candidate_ids": ["c0"]}]},
    })
    item_id = await make_item("video", topic="Как машину грузят на автовоз")
    await run_worker(services)
    it = await item(item_id)
    assert it.status == ContentStatus.awaiting_approval, it.last_error
    selection_prompt = next(c.prompt for c in fake_llm.calls if c.schema == "SceneSelection")
    assert "Погрузка машины на автовоз" in selection_prompt  # описание от владельца помогает подбору
    async with session_scope() as s:
        render = (await s.execute(select(MediaAsset).where(MediaAsset.kind == MediaKind.render_video))).scalar_one()
    assert str(lib.id) in render.parent_asset_ids


async def test_image_post_uses_library_photo(services, fake_llm):
    import io

    from PIL import Image

    await approve_all_facts()
    buf = io.BytesIO()
    Image.linear_gradient("L").resize((1600, 900)).convert("RGB").save(buf, "JPEG")
    async with session_scope() as s:
        photo = await store_bytes(s, services.storage, buf.getvalue(), kind=MediaKind.source_image, origin=MediaOrigin.owner_upload,
                                  mime="image/jpeg", title="Автовоз во Владивостоке", rights_confirmed=True)
    fake_llm.handlers.update({"CopyDraft": copy_handler(image_brief={"headline": "Перед погрузкой"}), "LLMReview": clean_review})
    item_id = await make_item("image_post")
    await run_worker(services)
    async with session_scope() as s:
        cover = (await s.execute(select(MediaAsset).where(MediaAsset.kind == MediaKind.cover))).scalar_one()
        version = await s.get(ContentVersion, (await item(item_id)).current_version_id)
    assert cover.render_params["template"] == "cover_photo" and cover.render_params["photo_asset_id"] == str(photo.id)
    assert version.qa_status in {"passed", "needs_review"}




@requires_ffmpeg
async def test_selection_falls_back_when_model_refuses(services, fake_llm, tmp_path):
    from app.providers.base import ProviderRejected

    await approve_all_facts()
    async with session_scope() as s:
        await store_file(s, services.storage, make_test_video(tmp_path / "lib.mp4", seconds=8), kind=MediaKind.source_video,
                         origin=MediaOrigin.owner_upload, mime="video/mp4", title="Крепление колёс", rights_confirmed=True)

    def refuse(prompt):
        raise ProviderRejected("отказ модели", provider="fake")

    script = {"aspect": "9:16", "scenes": [{"duration_s": 4, "shot": "source", "description": "Крепление"}]}
    fake_llm.handlers.update({"CopyDraft": copy_handler(title="Крепление колёс", body="Как крепят колёса на автовозе.", video_script=script),
                              "LLMReview": clean_review, "SceneSelection": refuse})
    item_id = await make_item("video", topic="Крепление колёс на автовозе")
    await run_worker(services)
    assert (await item(item_id)).status == ContentStatus.awaiting_approval
