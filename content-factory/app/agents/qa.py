"""Quality Assurance Agent.

Проверки делятся на обязательные детерминированные (длина, ссылки, повторы, права, целостность
файлов, разрешение, чёрные кадры, субтитры) и проверку языковой моделью (язык, стиль, логика,
неподтверждённые утверждения). Проверка моделью — не гарантия достоверности: сомнительные факты
помечаются manual_check и показываются владельцу.
"""

from __future__ import annotations

import re
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.agents.base import run_agent, untrusted
from app.content.channel import approved_facts, get_channel
from app.content.service import load_version, similarity, title_similarity
from app.database.enums import ContentStatus, MediaKind, QAStatus, SourceVerification
from app.database.models import ContentItem, ContentVersion, MediaAsset, ResearchSource, TrackedLink
from app.database.session import session_scope, utcnow
from app.media.assets import IntegrityError, download_verified, fetch_verified, image_info, temp_dir
from app.orchestration.services import Services
from app.providers.base import ProviderError
from app.providers.telegram.client import CAPTION_LIMIT, MESSAGE_LIMIT
from app.security import telegram_html
from app.security.ssrf import FetchError, UnsafeURLError
from app.settings.channel import FORMATS_WITH_IMAGE, FORMATS_WITH_VIDEO
from app.video import subtitles as subs
from app.video.edl import EDL
from app.video.ffmpeg import FFmpegError, analyze, decode_errors, probe

Severity = Literal["blocking", "warning", "manual_check", "info"]

TEXT_FIXABLE = {"length", "spelling", "forbidden_phrase", "unsupported_company_claim", "llm_blocking", "duplicate_title",
                "duplicate_body", "ad_marking", "poll_format", "synthetic_disclosure"}


class Finding(BaseModel):
    code: str
    severity: Severity
    message: str
    quote: str = ""


class QAReport(BaseModel):
    status: QAStatus
    findings: list[Finding] = Field(default_factory=list)
    checked_at: str = ""
    checks_run: list[str] = Field(default_factory=list)

    @property
    def blocking(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "blocking"]

    @property
    def manual(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "manual_check"]

    def text_fixable_only(self) -> bool:
        return bool(self.blocking) and all(f.code in TEXT_FIXABLE for f in self.blocking)


class LLMIssue(BaseModel):
    category: str
    severity: Literal["blocking", "warning", "manual_check"]
    quote: str = ""
    recommendation: str


class LLMReview(BaseModel):
    issues: list[LLMIssue] = Field(default_factory=list)


# --- Текст ---

MONEY = re.compile(r"\d[\d\s]*(?:[.,]\d+)?\s*(?:₽|руб|р\.|тыс\.?\s*руб|млн|\$|usd|евро|€)", re.IGNORECASE)
PERCENT = re.compile(r"\d+(?:[.,]\d+)?\s*%")
TERM = re.compile(r"\b(?:за|от|до|в течение)?\s*\d+(?:[–-]\d+)?\s*(?:дн(?:я|ей|ь)|сут(?:ок|ки)|недел[ьиюя]|час(?:а|ов)?)\b", re.IGNORECASE)
GUARANTEE = re.compile(r"гарантир\w*|гаранти[яи]\b|\bобещаем\b|\bточно в срок\b", re.IGNORECASE)
REVIEW = re.compile(r"\bотзыв\w*|\bклиент\w*\s+(?:рассказал|написал|отметил|поблагодарил)\w*", re.IGNORECASE)
COUNTS = re.compile(r"\b(?:более|свыше|больше|уже)\s+\d[\d\s]*\s*(?:авто|машин|автомобил|клиент|рейс|перевоз)", re.IGNORECASE)
SUPERLATIVE = re.compile(r"\b(?:сам(?:ый|ая|ое|ые|ых)|лучш\w+|единственн\w+|непревзойд\w+|№\s?1|номер\s+один)\b", re.IGNORECASE)
COMPANY = re.compile(r"\b(?:мы|наш\w*|нас|компани\w+|brookclean)\b", re.IGNORECASE)
SENTENCE = re.compile(r"(?<=[.!?…])\s+")


def _numbers(text: str) -> set[str]:
    return {re.sub(r"\s", "", n) for n in re.findall(r"\d[\d\s]*(?:[.,]\d+)?", text)}


def caption_text(version: ContentVersion) -> str:
    parts = [f"<b>{telegram_html.escape(version.title)}</b>" if version.title else "", version.body_html or "",
             " ".join(version.hashtags or [])]
    return "\n\n".join(p for p in parts if p)


def check_length(item_format: str, version: ContentVersion) -> list[Finding]:
    out: list[Finding] = []
    if item_format == "poll":
        poll = version.poll or {}
        options = poll.get("options") or []
        if not poll.get("question") or not 2 <= len(options) <= 10:
            out.append(Finding(code="poll_format", severity="blocking", message="в опросе нужен вопрос и 2–10 вариантов"))
        if len(poll.get("question") or "") > 300:
            out.append(Finding(code="poll_format", severity="blocking", message="вопрос опроса длиннее 300 символов"))
        if any(len(o) > 100 for o in options):
            out.append(Finding(code="poll_format", severity="blocking", message="вариант ответа длиннее 100 символов"))
        if len(set(o.strip().lower() for o in options)) != len(options):
            out.append(Finding(code="poll_format", severity="blocking", message="повторяющиеся варианты ответа"))
        return out
    if not version.title.strip():
        out.append(Finding(code="length", severity="blocking", message="нет заголовка"))
    visible = telegram_html.visible_text(caption_text(version))
    limit = CAPTION_LIMIT if item_format in FORMATS_WITH_IMAGE | FORMATS_WITH_VIDEO else MESSAGE_LIMIT
    if len(visible) > limit:
        out.append(Finding(code="length", severity="blocking",
                           message=f"текст {len(visible)} символов — больше лимита Telegram {limit} для этого формата"))
    if len(telegram_html.visible_text(version.body_html)) < 80 and item_format not in {"poll"}:
        out.append(Finding(code="length", severity="warning", message="очень короткий текст"))
    return out


def check_readability(body_html: str) -> list[Finding]:
    text = telegram_html.visible_text(body_html)
    sentences = [s for s in SENTENCE.split(text) if s.strip()]
    out: list[Finding] = []
    long = [s for s in sentences if len(s.split()) > 30]
    if long:
        out.append(Finding(code="readability", severity="warning", message=f"длинные предложения: {len(long)}", quote=long[0][:200]))
    for paragraph in text.split("\n\n"):
        if len(paragraph) > 700:
            out.append(Finding(code="readability", severity="warning", message="абзац длиннее 700 символов", quote=paragraph[:120]))
            break
    if text.count("!") > 3:
        out.append(Finding(code="style", severity="warning", message="много восклицательных знаков"))
    return out


def check_claims(text: str, *, supported_text: str, item_format: str) -> list[Finding]:
    """Цены, сроки, проценты, гарантии, отзывы, количества — только с опорой на факты или источники."""
    out: list[Finding] = []
    supported_numbers = _numbers(supported_text)
    for sentence in SENTENCE.split(text):
        about_company = bool(COMPANY.search(sentence)) or item_format == "ad"
        for pattern, label in ((MONEY, "цена"), (TERM, "срок"), (PERCENT, "процент"), (COUNTS, "количество")):
            for match in pattern.finditer(sentence):
                nums = _numbers(match.group(0))
                if nums and nums <= supported_numbers:
                    continue
                out.append(Finding(code="unsupported_company_claim" if about_company else "unverified_number",
                                   severity="blocking" if about_company else "manual_check",
                                   message=f"{label} без опоры на утверждённые факты или источники", quote=sentence.strip()[:240]))
        if GUARANTEE.search(sentence) and not GUARANTEE.search(supported_text):
            out.append(Finding(code="unsupported_company_claim", severity="blocking" if about_company else "manual_check",
                               message="гарантия или обещание без утверждённого факта", quote=sentence.strip()[:240]))
        if REVIEW.search(sentence) and "отзыв" not in supported_text.lower():
            out.append(Finding(code="unsupported_company_claim", severity="blocking",
                               message="упоминание отзывов или слов клиентов без материалов владельца", quote=sentence.strip()[:240]))
        if SUPERLATIVE.search(sentence):
            out.append(Finding(code="advertising_claim", severity="manual_check",
                               message="превосходная степень требует доказательств (закон «О рекламе»)", quote=sentence.strip()[:240]))
    return out


def check_forbidden(text: str, phrases: list[str]) -> list[Finding]:
    low = text.lower()
    return [Finding(code="forbidden_phrase", severity="blocking", message=f"запрещённая формулировка «{p}»")
            for p in phrases if p.lower() in low]


def check_topic(text: str, keywords: list[str]) -> list[Finding]:
    low = text.lower()
    if not any(k in low for k in keywords):
        return [Finding(code="topic", severity="warning", message="в тексте нет ключевых слов тематики канала")]
    return []


# --- Медиа ---

async def check_image(services: Services, asset: MediaAsset, item_format: str) -> list[Finding]:
    out: list[Finding] = []
    try:
        info = image_info(await fetch_verified(services.storage, asset))
    except IntegrityError as exc:
        return [Finding(code="media_integrity", severity="blocking", message=str(exc))]
    if min(info.width, info.height) < 600:
        out.append(Finding(code="media_resolution", severity="blocking", message=f"изображение {info.width}×{info.height} — слишком маленькое"))
    if info.stddev_luma < 4:
        out.append(Finding(code="media_empty", severity="blocking", message="изображение однотонное или пустое"))
    if asset.size_bytes > 10 * 1024 * 1024:
        out.append(Finding(code="media_size", severity="blocking", message="фото больше 10 МБ — Telegram не примет"))
    if item_format == "infographic" and info.height < info.width:
        out.append(Finding(code="media_orientation", severity="warning", message="инфографика горизонтальная — в ленте читается хуже"))
    warnings = (asset.render_params or {}).get("warnings") or []
    out += [Finding(code="media_layout", severity="warning", message=w) for w in warnings]
    return out


async def check_video(services: Services, asset: MediaAsset, expected_aspect: str | None, render: dict[str, Any] | None) -> list[Finding]:
    out: list[Finding] = []
    limit = services.settings.telegram_max_upload_mb * 1024 * 1024
    if asset.size_bytes > limit:
        out.append(Finding(code="media_size", severity="blocking",
                           message=f"видео {asset.size_bytes / 1048576:.1f} МБ больше лимита Bot API {services.settings.telegram_max_upload_mb} МБ"))
    with temp_dir(services.settings.work_dir, "qa-") as tmp:
        path = Path(tmp) / "video.mp4"
        try:
            await download_verified(services.storage, asset, path)
            info = await probe(path)
            errors = await decode_errors(path)
            analysis = await analyze(path, info)
        except (IntegrityError, FFmpegError) as exc:
            return out + [Finding(code="media_integrity", severity="blocking", message=f"видео не читается: {exc}")]
    if errors:
        out.append(Finding(code="media_integrity", severity="blocking", message="ошибки декодирования: " + "; ".join(errors[:3])))
    if not info.has_video:
        out.append(Finding(code="media_integrity", severity="blocking", message="нет видеодорожки"))
    if info.video_codec != "h264" or info.pix_fmt != "yuv420p":
        out.append(Finding(code="media_format", severity="blocking", message=f"кодек {info.video_codec}/{info.pix_fmt}, нужен h264/yuv420p"))
    size = info.display_size or (0, 0)
    if min(size) < 720:
        out.append(Finding(code="media_resolution", severity="blocking", message=f"разрешение {size[0]}×{size[1]} ниже 720p"))
    expected = {"9:16": "vertical", "16:9": "horizontal", "1:1": "square"}.get(expected_aspect or "")
    if expected and info.orientation != expected:
        out.append(Finding(code="media_orientation", severity="blocking", message=f"ориентация {info.orientation}, ожидалась {expected}"))
    if not 5 <= info.duration_s <= 180:
        out.append(Finding(code="media_duration", severity="warning", message=f"длительность {info.duration_s:.0f} с"))
    black = analysis.ratio(analysis.black)
    if black > 0.3:
        out.append(Finding(code="media_empty", severity="blocking", message=f"чёрные кадры {black:.0%} длительности"))
    elif black > 0.1:
        out.append(Finding(code="media_empty", severity="warning", message=f"чёрные кадры {black:.0%} длительности"))
    if analysis.ratio(analysis.frozen) > 0.5:
        out.append(Finding(code="media_frozen", severity="warning", message="больше половины ролика — статичные кадры"))
    if not info.has_audio:
        out.append(Finding(code="media_audio", severity="warning", message="в ролике нет звука"))
    loud = (render or {}).get("loudness_out")
    if loud and abs(loud.get("input_i", -16) - -16) > 3:
        out.append(Finding(code="media_audio", severity="warning", message=f"громкость {loud['input_i']:.1f} LUFS вместо −16"))
    edl_data = (render or {}).get("edl")
    if edl_data:
        edl = EDL.model_validate(edl_data)
        normalized = subs.normalize(edl.subtitles, edl.duration)
        for issue in subs.check(normalized, edl.duration)[:10]:
            out.append(Finding(code="subtitles", severity="warning", message=f"субтитр {issue.index + 1}: {issue.problem}",
                               quote=normalized[issue.index].text[:120] if issue.index < len(normalized) else ""))
        out += [Finding(code="video_material", severity="manual_check", message=w) for w in (render or {}).get("edit_warnings", [])]
    return out


async def check_rights(session, assets: list[MediaAsset]) -> list[Finding]:  # noqa: ANN001
    out: list[Finding] = []
    seen: set[str] = set()
    queue = list(assets)
    while queue:
        asset = queue.pop()
        if str(asset.id) in seen:
            continue
        seen.add(str(asset.id))
        if not asset.rights_confirmed:
            out.append(Finding(code="media_rights", severity="blocking",
                               message=f"права на файл «{asset.title or asset.storage_key}» не подтверждены"))
        for parent_id in asset.parent_asset_ids or []:
            parent = await session.get(MediaAsset, uuid.UUID(parent_id))
            if parent is not None:
                queue.append(parent)
    edl_sources = []
    for asset in assets:
        edl = (asset.render_params or {}).get("edl") or {}
        edl_sources += [s["source"]["asset_id"] for s in edl.get("segments", []) if s.get("type") == "clip"]
        if edl.get("music"):
            edl_sources.append(edl["music"]["source"]["asset_id"])
    for source_id in set(edl_sources) - seen:
        source = await session.get(MediaAsset, uuid.UUID(source_id))
        if source is None or not source.rights_confirmed:
            out.append(Finding(code="media_rights", severity="blocking", message="в монтаже есть материал без подтверждённых прав"))
    return out


async def check_links(services: Services, session, body_html: str) -> list[Finding]:  # noqa: ANN001
    out: list[Finding] = []
    base = services.settings.public_base_url.rstrip("/") + "/r/"
    for link in telegram_html.extract_links(body_html):
        if link.startswith(base):
            code = link[len(base):]
            exists = (await session.execute(select(TrackedLink.id).where(TrackedLink.code == code))).first()
            if not exists:
                out.append(Finding(code="links", severity="blocking", message=f"отслеживаемая ссылка {code} не найдена"))
            continue
        if link.startswith("tg://"):
            continue
        try:
            page = await services.fetcher.fetch(link)
            if page.status_code >= 400:
                out.append(Finding(code="links", severity="blocking", message=f"ссылка отвечает {page.status_code}", quote=link))
        except UnsafeURLError as exc:
            out.append(Finding(code="links", severity="blocking", message=f"небезопасная ссылка: {exc}", quote=link))
        except FetchError as exc:
            out.append(Finding(code="links", severity="warning", message=f"ссылка недоступна: {exc}", quote=link))
    return out


async def run_qa(services: Services, item_id: uuid.UUID, version_id: uuid.UUID) -> QAReport:
    findings: list[Finding] = []
    checks: list[str] = []
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        version = await load_version(session, version_id)
        assert item is not None and version is not None
        channel = await get_channel(session)
        qa = channel.settings.qa
        facts = await approved_facts(session, channel.id)
        sources = (await session.execute(select(ResearchSource).where(ResearchSource.item_id == item_id))).scalars().all()
        verified_claims = [c for s in sources if s.verification == SourceVerification.verified for c in s.claims or [] if c.get("verified")]
        supported = "\n".join([f.statement for f in facts] + [c["claim"] + " " + c.get("quote", "") for c in verified_claims]
                              + [item.owner_brief or ""])
        text = telegram_html.visible_text(f"{version.title}\n{version.body_html}\n{(version.poll or {}).get('question', '')} "
                                          + " ".join((version.poll or {}).get("options", [])))

        findings += check_length(item.format, version); checks.append("length")  # noqa: E702
        findings += check_readability(version.body_html); checks.append("readability")  # noqa: E702
        findings += check_claims(text, supported_text=supported, item_format=item.format); checks.append("claims")  # noqa: E702
        findings += check_forbidden(text, qa.forbidden_phrases); checks.append("forbidden")  # noqa: E702
        findings += check_topic(text, qa.topic_keywords); checks.append("topic")  # noqa: E702
        if item.format == "ad" and qa.ad_marking_required and not ("реклама" in text.lower() and "erid" in text.lower()):
            findings.append(Finding(code="ad_marking", severity="blocking", message="нет маркировки рекламы (пометка «Реклама» и erid)"))
        if item.needs_sources and not verified_claims:
            findings.append(Finding(code="sources", severity="blocking", message="для темы нужны источники, подтверждённых нет"))
        for s in sources:
            if s.verification == SourceVerification.unverified and s.claims:
                findings.append(Finding(code="sources", severity="manual_check",
                                        message=f"источник без подтверждённых цитат: {s.url}"))
        for statement in (version.publish_options or {}).get("uncertain_statements") or []:
            findings.append(Finding(code="uncertain", severity="manual_check", message="автор отметил как требующее проверки",
                                    quote=str(statement)[:240]))

        # Повторы.
        since = utcnow() - timedelta(days=60)
        others = (await session.execute(
            select(ContentVersion.title, ContentVersion.body_html, ContentVersion.cta_text, ContentItem.scheduled_at)
            .join(ContentItem, ContentItem.current_version_id == ContentVersion.id)
            .where(ContentItem.id != item_id, ContentItem.created_at >= since,
                   ContentItem.status.in_([ContentStatus.published, ContentStatus.scheduled, ContentStatus.approved,
                                           ContentStatus.awaiting_approval, ContentStatus.publishing]))
        )).all()
        for title, body, _cta, _when in others:
            if version.title and title and title_similarity(version.title, title) >= qa.max_title_similarity:
                findings.append(Finding(code="duplicate_title", severity="blocking", message="заголовок повторяет другой материал", quote=title[:160]))
                break
        for title, body, _cta, _when in others:
            if body and similarity(version.body_html, body) >= qa.max_body_similarity:
                findings.append(Finding(code="duplicate_body", severity="blocking", message="текст во многом повторяет другой материал", quote=title[:160]))
                break
        if version.cta_text:
            week = utcnow() - timedelta(days=7)
            same_cta = (await session.execute(
                select(func.count()).select_from(ContentVersion).join(ContentItem, ContentItem.current_version_id == ContentVersion.id)
                .where(ContentItem.id != item_id, func.lower(ContentVersion.cta_text) == version.cta_text.lower(),
                       ContentItem.created_at >= week)
            )).scalar_one()
            if same_cta >= qa.max_same_cta_per_week:
                findings.append(Finding(code="duplicate_cta", severity="warning", message=f"призыв уже использован {same_cta} раз за неделю"))
        checks.append("duplicates")
        findings += await check_links(services, session, version.body_html); checks.append("links")  # noqa: E702

        # Медиа.
        links = list(version.media_links)
        assets = [link.asset for link in links]
        primary = next((link.asset for link in links if link.role == "primary"), None)
        if item.format in FORMATS_WITH_IMAGE | FORMATS_WITH_VIDEO and primary is None:
            findings.append(Finding(code="media_missing", severity="blocking", message="нет готового медиафайла"))
        findings += await check_rights(session, assets); checks.append("rights")  # noqa: E702
        if any(a.is_synthetic for a in assets) or any((a.render_params or {}).get("synthetic_scenes") for a in assets):
            disclosure = channel.settings.brand.synthetic_disclosure.lower()
            if disclosure and disclosure not in text.lower():
                findings.append(Finding(code="synthetic_disclosure", severity="blocking",
                                        message="в подписи нет пометки о синтетическом изображении/видео"))
        item_format = item.format
        expected_aspect = (version.video_script or {}).get("aspect")

    for asset in assets:
        if asset.kind in {MediaKind.cover, MediaKind.infographic, MediaKind.image, MediaKind.thumbnail, MediaKind.ai_image}:
            findings += await check_image(services, asset, item_format)
        elif asset.kind in {MediaKind.render_video, MediaKind.source_video, MediaKind.ai_video_scene}:
            render = asset.render_params or {}
            findings += await check_video(services, asset, render.get("edl", {}).get("output", {}).get("aspect") or expected_aspect, render)
    checks.append("media")

    # Проверка языковой моделью.
    if services.llm is not None:
        try:
            review = await run_agent(
                services, agent="qa_review", schema=LLMReview, item_id=item_id, effort="medium", expected_output_tokens=1200,
                prompt="\n".join([
                    f"Формат: {item_format}. Тема: {item.topic}. Тезис: {item.thesis or '—'}",
                    "Утверждённые факты:", *([f"- {f.statement}" for f in facts] or ["- нет"]),
                    "Подтверждённые утверждения источников:", *([f"- {c['claim']}" for c in verified_claims] or ["- нет"]),
                    untrusted("draft", f"{version.title}\n\n{telegram_html.visible_text(version.body_html)}\n"
                                       f"{(version.poll or {})}\n{version.video_script or ''}"),
                ]),
            )
            for issue in review.issues:
                code = "llm_blocking" if issue.severity == "blocking" else f"llm_{issue.category}"[:40]
                findings.append(Finding(code=code, severity=issue.severity, message=f"{issue.category}: {issue.recommendation}",
                                        quote=issue.quote[:240]))
            checks.append("llm_review")
        except ProviderError as exc:
            findings.append(Finding(code="llm_unavailable", severity="manual_check", message=f"проверка моделью не выполнена: {exc}"))
    else:
        findings.append(Finding(code="llm_unavailable", severity="manual_check", message="проверка языковой моделью не настроена"))

    if services.speller is not None:
        try:
            issues = await services.speller.check(text)
            for issue in issues[:15]:
                if issue.code == 1 and issue.suggestions:
                    findings.append(Finding(code="spelling", severity="blocking",
                                            message=f"орфография: «{issue.word}» → {', '.join(issue.suggestions)}", quote=issue.word))
                elif issue.code == 2:
                    findings.append(Finding(code="spelling", severity="warning", message=f"повтор слова «{issue.word}»"))
            checks.append("spelling")
        except ProviderError as exc:
            findings.append(Finding(code="spelling", severity="warning", message=f"проверка орфографии недоступна: {exc}"))

    status = QAStatus.passed
    if any(f.severity == "blocking" for f in findings):
        status = QAStatus.failed
    elif any(f.severity == "manual_check" for f in findings):
        status = QAStatus.needs_review
    report = QAReport(status=status, findings=findings, checked_at=utcnow().isoformat(), checks_run=checks)
    async with session_scope() as session:
        version = await session.get(ContentVersion, version_id, with_for_update=True)
        assert version is not None
        if version.frozen_at is None:
            version.qa_status = status
            version.qa_report = report.model_dump(mode="json")
    return report
