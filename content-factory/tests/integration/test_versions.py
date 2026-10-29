import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.content.channel import get_channel
from app.content.service import attach_media, freeze, load_version, new_version, recompute_hash
from app.database.enums import ApprovalAction, MediaKind, MediaOrigin
from app.database.models import ApprovalEvent, ContentItem
from app.database.session import session_scope, utcnow
from app.media.assets import store_bytes

pytestmark = pytest.mark.usefixtures("db")

PNG = None


def png() -> bytes:
    import io

    from PIL import Image

    img = Image.linear_gradient("L").resize((800, 600)).convert("RGB")
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


async def make_item(session, fmt="image_post"):
    channel = await get_channel(session)
    item = ContentItem(channel_id=channel.id, format=fmt, topic="Подготовка автомобиля к перевозке")
    session.add(item)
    await session.flush()
    return item


async def test_frozen_version_is_immutable_in_database(storage):
    async with session_scope() as s:
        item = await make_item(s)
        v = await new_version(s, item, title="Заголовок", body_html="Текст", origin="test")
        asset = await store_bytes(s, storage, png(), kind=MediaKind.cover, origin=MediaOrigin.template, mime="image/png", rights_confirmed=True)
        await attach_media(s, v, asset, role="primary")
        digest = await freeze(s, item, v)
        assert digest == await recompute_hash(s, item, v.id)
        version_id, asset_id = v.id, asset.id
    with pytest.raises(DBAPIError, match="immutable"):
        async with session_scope() as s:
            await s.execute(text("UPDATE content_versions SET body_html = 'подмена' WHERE id = :id"), {"id": version_id})
    with pytest.raises(DBAPIError, match="frozen"):
        async with session_scope() as s:
            await s.execute(text("DELETE FROM version_media WHERE version_id = :id"), {"id": version_id})
    with pytest.raises(DBAPIError, match="immutable"):
        async with session_scope() as s:
            await s.execute(text("UPDATE media_assets SET sha256 = 'x' WHERE id = :id"), {"id": asset_id})
    # QA-поля замороженной версии менять можно — это не содержимое.
    async with session_scope() as s:
        await s.execute(text("UPDATE content_versions SET qa_status = 'passed' WHERE id = :id"), {"id": version_id})


async def test_hash_changes_with_content_and_media(storage):
    async with session_scope() as s:
        item = await make_item(s)
        v1 = await new_version(s, item, title="A", body_html="Текст", origin="test")
        h1 = await recompute_hash(s, item, v1.id)
        asset = await store_bytes(s, storage, png(), kind=MediaKind.cover, origin=MediaOrigin.template, mime="image/png")
        v1 = await load_version(s, v1.id)
        await attach_media(s, v1, asset, role="primary")
        h2 = await recompute_hash(s, item, v1.id)
        v2 = await new_version(s, item, title="A", body_html="Текст!", origin="test", copy_media_from=await load_version(s, v1.id))
        h3 = await recompute_hash(s, item, v2.id)
    assert len({h1, h2, h3}) == 3


async def test_new_version_invalidates_approval():
    async with session_scope() as s:
        item = await make_item(s, "short_post")
        v1 = await new_version(s, item, title="A", body_html="B", origin="test")
        item.approved_version_id, item.approved_content_hash, item.approved_at = v1.id, "h", utcnow()
        await new_version(s, item, title="A2", body_html="B2", origin="test")
        assert item.approved_version_id is None and item.approved_content_hash is None
        events = (await s.execute(select(ApprovalEvent).where(ApprovalEvent.item_id == item.id))).scalars().all()
    assert [e.action for e in events] == [ApprovalAction.invalidated]
