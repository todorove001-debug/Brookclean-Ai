"""Visual Agent: обложки, инфографика, постеры и превью.

- Вёрстка — детерминированные шаблоны с бренд-конфигурацией (цвета, шрифты, логотип, контакты).
- Фото: сначала материалы владельца с подтверждёнными правами; иначе, если подключён генератор,
  — ИИ-иллюстрация. Она проверяется моделью с компьютерным зрением на искажения техники и надписи,
  помечается как синтетическая и получает подпись-дисклеймер.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.agents.base import run_agent
from app.budget.service import paid_call
from app.content.channel import get_channel
from app.content.service import attach_media, load_version
from app.database.enums import MediaKind, MediaOrigin
from app.database.models import ContentItem, MediaAsset
from app.database.session import session_scope
from app.media.assets import fetch_verified, store_bytes
from app.media.library import library
from app.media.templates import TemplateRenderer
from app.monitoring.logging import get_logger
from app.orchestration.services import Services
from app.providers.base import ProviderError
from app.providers.llm.base import ImageInput
from app.settings.channel import BrandConfig
from app.settings.config import ROOT_DIR

log = get_logger(__name__)


class IllustrationPrompt(BaseModel):
    prompt: str
    negative_hints: list[str] = Field(default_factory=list)


class VisualIssue(BaseModel):
    severity: Literal["blocking", "manual_check"]
    description: str


class VisualReview(BaseModel):
    ok: bool
    issues: list[VisualIssue] = Field(default_factory=list)


async def load_brand_file(services: Services, ref: str | None) -> bytes | None:
    if not ref:
        return None
    if ref.startswith("storage:"):
        return await services.storage.get_bytes(ref.removeprefix("storage:"))
    path = Path(ref)
    if not path.is_absolute():
        path = ROOT_DIR / path
    return path.read_bytes() if path.exists() else None


async def brand_fonts(services: Services, brand: BrandConfig) -> dict[str, str]:
    fonts: dict[str, str] = {}
    cache = services.settings.work_dir / "fonts"
    for name in ("regular", "bold"):
        ref = getattr(brand.fonts, name)
        if ref.startswith("storage:"):
            key = ref.removeprefix("storage:")
            local = cache / hashlib.sha256(key.encode()).hexdigest()[:16] / Path(key).name
            if not local.exists():
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(await services.storage.get_bytes(key))
            fonts[name] = str(local)
        else:
            fonts[name] = ref
    return fonts


async def make_renderer(services: Services, brand: BrandConfig) -> TemplateRenderer:
    return TemplateRenderer(
        services.settings.templates_path,
        brand,
        logo_bytes=await load_brand_file(services, brand.logo),
        font_paths=await brand_fonts(services, brand),
    )


async def review_image(
    services: Services, data: bytes, mime: str, description: str, item_id: uuid.UUID | None
) -> VisualReview:
    return await run_agent(
        services,
        agent="visual_review",
        schema=VisualReview,
        item_id=item_id,
        effort="medium",
        images=[ImageInput(data=data, media_type=mime)],
        expected_output_tokens=500,
        max_tokens=4000,
        prompt=f"Описание, которому должно соответствовать изображение: {description}",
    )


async def generate_illustration(
    services: Services, item: ContentItem, idea: str, aspect: str
) -> MediaAsset | None:
    """ИИ-иллюстрация с проверкой зрением. None — генератор не подключён или результат забракован."""
    if services.images is None or not idea:
        return None
    channel_budget = None
    async with session_scope() as session:
        channel_budget = (await get_channel(session)).settings.budget
    prompt = await run_agent(
        services,
        agent="visual_prompt",
        schema=IllustrationPrompt,
        item_id=item.id,
        effort="low",
        expected_output_tokens=400,
        max_tokens=3000,
        prompt=f"Тема публикации: {item.topic}\nИдея иллюстрации: {idea}\nФормат кадра: {aspect}",
    )
    full_prompt = prompt.prompt + (
        " Avoid: " + ", ".join(prompt.negative_hints) if prompt.negative_hints else ""
    )
    quality = "medium"
    for attempt in range(1, channel_budget.max_retries_paid + 2):
        estimated = services.pricing.image_cost(services.images.model, quality)
        try:
            async with paid_call(
                provider=services.images.name,
                operation="image.generate",
                estimated_usd=estimated,
                model=services.images.model,
                item_id=item.id,
                charge_on_error=False,
            ) as call:
                image = await services.images.generate(full_prompt, aspect=aspect, quality=quality)
                call.set_actual(
                    estimated,
                    source="estimate",
                    units={"size": image.size, "quality": quality, **image.usage},
                )
        except ProviderError as exc:
            log.warning("visual.generation_failed", item_id=str(item.id), error=str(exc), attempt=attempt)
            if attempt > channel_budget.max_retries_paid:
                return None
            continue
        review = await review_image(services, image.data, image.mime_type, idea, item.id)
        blocking = [i for i in review.issues if i.severity == "blocking"]
        async with session_scope() as session:
            asset = await store_bytes(
                session,
                services.storage,
                image.data,
                kind=MediaKind.ai_image,
                origin=MediaOrigin.ai_generated,
                mime=image.mime_type,
                item_id=item.id,
                title=idea[:200],
                is_synthetic=True,
                rights={
                    "license": "generated",
                    "provider": services.images.name,
                    "model": image.model,
                    "note": "сгенерировано ИИ; использование по условиям поставщика",
                },
                rights_confirmed=True,
                render_params={
                    "prompt": full_prompt,
                    "model": image.model,
                    "size": image.size,
                    "quality": quality,
                    "revised_prompt": image.revised_prompt,
                },
                provider=services.images.name,
            )
            asset.probe = {**(asset.probe or {}), "vision_review": review.model_dump()}
            asset_id = asset.id
        if not blocking:
            async with session_scope() as session:
                return await session.get(MediaAsset, asset_id)
        log.info("visual.rejected_by_review", item_id=str(item.id), issues=[i.description for i in blocking])
    return None


async def owner_photo(session, item_id: uuid.UUID) -> MediaAsset | None:  # noqa: ANN001
    """Фото поста; если своего нет — реже всего использованное фото из библиотеки съёмок."""
    own = (
        (
            await session.execute(
                select(MediaAsset)
                .where(
                    MediaAsset.item_id == item_id,
                    MediaAsset.kind == MediaKind.source_image,
                    MediaAsset.rights_confirmed.is_(True),
                )
                .order_by(MediaAsset.created_at)
            )
        )
        .scalars()
        .first()
    )
    if own is not None:
        return own
    shared = await library(session, MediaKind.source_image, limit=1)
    return shared[0] if shared else None


async def prepare_visuals(services: Services, item_id: uuid.UUID, version_id: uuid.UUID) -> list[str]:
    warnings: list[str] = []
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        version = await load_version(session, version_id)
        assert item is not None and version is not None
        channel = await get_channel(session)
        brief = dict((version.publish_options or {}).get("image_brief") or {})
        photo_asset = await owner_photo(session, item_id)
        photo_bytes = await fetch_verified(services.storage, photo_asset) if photo_asset else None
    brand = channel.settings.brand
    headline = brief.get("headline") or version.title
    fields: dict = {
        "headline": headline,
        "subline": brief.get("subline", ""),
        "footer": " · ".join(brand.contacts[:2]),
        "points": brief.get("points") or [],
    }

    synthetic = False
    if item.format == "infographic":
        template = (
            "route"
            if brief.get("infographic_type") == "route" and len(fields["points"]) >= 2
            else "checklist"
        )
        if template == "checklist" and not fields["points"]:
            warnings.append("для инфографики нет пунктов — использована текстовая обложка")
            template = "square_post"
        kind = MediaKind.infographic
    else:
        kind = MediaKind.cover
        if photo_bytes is None and brief.get("illustration_idea"):
            ai = await generate_illustration(services, item, brief["illustration_idea"], "16:9")
            if ai is not None:
                photo_asset = ai
                photo_bytes = await fetch_verified(services.storage, ai)
                synthetic = True
            elif services.images is not None:
                warnings.append(
                    "ИИ-иллюстрация не прошла проверку или не сгенерирована — использована текстовая обложка"
                )
        template = "cover_photo" if photo_bytes else "cover_text"

    renderer = await make_renderer(services, brand)
    result = renderer.render(
        template, fields, images={"photo": photo_bytes} if photo_bytes else None, synthetic=synthetic
    )
    warnings += result.warnings
    async with session_scope() as session:
        version = await load_version(session, version_id)
        assert version is not None
        brand_digest = hashlib.sha256(
            json.dumps(brand.model_dump(mode="json"), sort_keys=True).encode()
        ).hexdigest()[:16]
        asset = await store_bytes(
            session,
            services.storage,
            result.png,
            kind=kind,
            origin=MediaOrigin.template,
            mime="image/png",
            item_id=item_id,
            channel_id=item.channel_id,
            title=headline[:200],
            is_synthetic=synthetic,
            rights={"license": "own", "note": "вёрстка по шаблону бренда"},
            rights_confirmed=True,
            parent_ids=[photo_asset.id] if photo_asset else [],
            render_params={
                "template": template,
                "fields": fields,
                "brand_digest": brand_digest,
                "synthetic": synthetic,
                "photo_asset_id": str(photo_asset.id) if photo_asset else None,
                "warnings": result.warnings,
            },
        )
        await attach_media(session, version, asset, role="primary")
    return warnings


__all__ = ["generate_illustration", "make_renderer", "prepare_visuals", "review_image"]
