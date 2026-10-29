"""Copywriter Agent: тексты постов, статей, опросов, сценарии видео и бриф для обложек."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.agents.base import run_agent, untrusted
from app.analytics.links import create_link, public_url
from app.content.channel import approved_facts, get_channel
from app.content.service import load_version, new_version
from app.database.enums import ContentStatus, SourceVerification
from app.database.models import ContentItem, ContentVersion, ResearchSource
from app.database.session import session_scope, utcnow
from app.orchestration.services import Services
from app.security import telegram_html


class VideoScene(BaseModel):
    duration_s: float
    shot: Literal["source", "ai", "title_card"]
    description: str
    voiceover: str = ""
    on_screen_text: str = ""


class VideoScript(BaseModel):
    aspect: Literal["9:16", "16:9", "1:1"] = "9:16"
    target_duration_s: float = 30
    scenes: list[VideoScene] = Field(default_factory=list)


class PollDraft(BaseModel):
    question: str
    options: list[str]
    allows_multiple_answers: bool = False


class ImageBrief(BaseModel):
    headline: str = ""
    subline: str = ""
    infographic_type: Literal["checklist", "route", "none"] = "none"
    points: list[str] = Field(default_factory=list)
    illustration_idea: str = ""


class CopyDraft(BaseModel):
    title: str
    body_html: str
    cta_text: str = ""
    hashtags: list[str] = Field(default_factory=list)
    poll: PollDraft | None = None
    video_script: VideoScript | None = None
    image_brief: ImageBrief | None = None
    used_fact_keys: list[str] = Field(default_factory=list)
    used_claims: list[int] = Field(default_factory=list)
    uncertain_statements: list[str] = Field(default_factory=list)


async def _context(session, item: ContentItem) -> dict:  # noqa: ANN001
    channel = await get_channel(session)
    facts = await approved_facts(session, channel.id)
    sources = (await session.execute(
        select(ResearchSource).where(ResearchSource.item_id == item.id).order_by(ResearchSource.created_at)
    )).scalars().all()
    claims: list[str] = []
    for source in sources:
        if source.verification != SourceVerification.verified:
            continue
        for c in source.claims or []:
            if c.get("verified"):
                date = source.published_at.date().isoformat() if source.published_at else "дата не указана"
                claims.append(f"[{len(claims)}] {c['claim']} (источник: {source.publisher or source.url}, {date})")
    recent = (await session.execute(
        select(ContentVersion.title, ContentVersion.cta_text).join(ContentItem, ContentItem.current_version_id == ContentVersion.id)
        .where(ContentItem.channel_id == channel.id, ContentItem.id != item.id,
               ContentItem.status.not_in([ContentStatus.rejected, ContentStatus.cancelled]))
        .order_by(ContentVersion.created_at.desc()).limit(40)
    )).all()
    previous = await load_version(session, item.current_version_id)
    return {"channel": channel, "facts": facts, "claims": claims, "recent": recent, "previous": previous}


def _prompt(item: ContentItem, ctx: dict, qa_feedback: list[str] | None) -> str:
    channel = ctx["channel"]
    brand = channel.settings.brand
    qa = channel.settings.qa
    lines = [
        f"Формат: {item.format}",
        f"Рубрика: {item.rubric or '—'}",
        f"Тема: {item.topic}",
        f"Цель: {item.goal or '—'}",
        f"Аудитория: {item.audience or '—'}",
        f"Основной тезис: {item.thesis or '—'}",
        f"Призыв к действию: {item.cta or '—'}",
        f"Пожелания к медиа: {(item.media_requirements or {}).get('brief', '—')}",
        f"Голос бренда: {brand.voice}",
        f"Хештеги бренда: {' '.join(brand.hashtags) or '—'}",
        "Запрещённые формулировки: " + "; ".join(qa.forbidden_phrases),
        "Утверждённые факты о компании (ключ — сведение):",
        *([f"- {f.key}: {f.statement}" for f in ctx["facts"]] or ["- нет. Не указывай цены, сроки, гарантии и цифры о компании."]),
        "Подтверждённые утверждения источников:",
        *(ctx["claims"] or ["- нет"]),
        "Недавние заголовки и призывы (не повторять):",
        *[f"- {t} | {c or ''}" for t, c in ctx["recent"]],
    ]
    if item.owner_brief:
        lines.append(untrusted("owner_brief", item.owner_brief))
    previous: ContentVersion | None = ctx["previous"]
    if previous is not None and (item.pending_change_request or qa_feedback):
        lines += ["Предыдущая версия:", untrusted("previous_version", f"{previous.title}\n\n{previous.body_html}")]
    if item.pending_change_request:
        lines += ["Запрос правок от владельца:", untrusted("owner_change_request", item.pending_change_request)]
    if qa_feedback:
        lines += ["Замечания проверки:", *[f"- {f}" for f in qa_feedback]]
    return "\n".join(lines)


def postprocess_body(body_html: str, allowed_links: set[str]) -> str:
    # Ссылки, которых нет среди разрешённых, превращаются в обычный текст: модель не придумывает URL.
    return telegram_html.sanitize(body_html, allowed_links)


async def write_copy(services: Services, item_id: uuid.UUID, *, qa_feedback: list[str] | None = None, origin: str = "copywriter") -> uuid.UUID:
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        assert item is not None
        ctx = await _context(session, item)
        prompt = _prompt(item, ctx, qa_feedback)
        cta_url = ctx["channel"].settings.cta_targets.get(item.cta_target or "")

    draft = await run_agent(services, agent="copywriter", schema=CopyDraft, prompt=prompt, item_id=item_id,
                            expected_output_tokens=2500, max_tokens=16000)

    async with session_scope() as session:
        item = await session.get(ContentItem, item_id, with_for_update=True)
        assert item is not None
        body = postprocess_body(draft.body_html, set())
        cta_text = telegram_html.visible_text(draft.cta_text).strip()
        publish_options: dict = {"used_fact_keys": draft.used_fact_keys, "used_claims": draft.used_claims,
                                 "uncertain_statements": draft.uncertain_statements, "written_at": utcnow().isoformat()}
        if cta_url and cta_text and item.format != "poll":
            link = await create_link(session, cta_url, item_id=item.id, label=item.cta_target)
            body = f'{body}\n\n<a href="{public_url(link.code)}">{telegram_html.escape(cta_text)}</a>'
            publish_options["tracked_link"] = link.code
        if draft.image_brief:
            publish_options["image_brief"] = draft.image_brief.model_dump()
        previous = await load_version(session, item.current_version_id)
        version = await new_version(
            session, item, title=telegram_html.visible_text(draft.title).strip(), body_html=body, origin=origin,
            poll=draft.poll.model_dump() if draft.poll else None,
            video_script=draft.video_script.model_dump() if draft.video_script else None,
            hashtags=[h if h.startswith("#") else f"#{h}" for h in draft.hashtags][:3], cta_text=cta_text or None,
            publish_options=publish_options, change_request=item.pending_change_request,
            # При правке текста видео и обложка сохраняются, если владелец не просил их переделать.
            copy_media_from=previous if previous is not None and not item.pending_video_params else None,
        )
        item.pending_change_request = None
        return version.id
