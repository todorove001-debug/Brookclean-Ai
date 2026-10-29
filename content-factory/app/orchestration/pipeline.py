"""Agent Orchestrator: конвейер производства материала.

idea → researching → drafting → media_generation → quality_check → awaiting_approval → approved → scheduled → publishing → published

Один обработчик pipeline.advance смотрит на статус и выполняет следующий шаг. Долгие операции
(модель, рендер) идут без блокировки строки; результат применяется, только если за это время
статус и текущая версия не изменились (например, владелец не отменил материал).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from sqlalchemy import select

from app.agents import ai_video, qa, video_editor
from app.agents.copywriter import write_copy
from app.agents.research import research_item
from app.agents.visual import load_brand_file, make_renderer, prepare_visuals
from app.approval.service import schedule
from app.budget.service import BudgetExceeded
from app.content.channel import get_channel
from app.content.service import Stale, attach_media, fail, freeze, load_version, new_version, transition
from app.database.enums import (
    ApprovalAction,
    ContentStatus,
    MediaKind,
    MediaOrigin,
    QAStatus,
    VideoJobKind,
    VideoJobStatus,
)
from app.database.models import ApprovalEvent, ContentItem, MediaAsset, VideoJob
from app.database.session import session_scope, utcnow
from app.media.assets import download_verified, store_bytes, store_file, temp_dir
from app.monitoring.alerts import notify_owner
from app.monitoring.logging import get_logger
from app.orchestration.queue import PermanentError, Reschedule, TaskContext, enqueue
from app.orchestration.services import Services
from app.providers.base import ProviderNotConfigured, ProviderRejected, ProviderUnavailable
from app.security import telegram_html
from app.settings.channel import FORMATS_WITH_IMAGE, FORMATS_WITH_VIDEO
from app.video.edl import EDL, ClipSegment, MediaRef
from app.video.ffmpeg import FFmpegError
from app.video.render import edl_fingerprint, render_edl

log = get_logger(__name__)


@asynccontextmanager
async def _apply(
    item_id: uuid.UUID, expected_status: ContentStatus, expected_version: uuid.UUID | None
) -> AsyncIterator[tuple[Any, ContentItem]]:
    """Заблокировать материал и убедиться, что статус и версия не изменились за время операции."""
    async with session_scope() as session:
        item = (
            await session.execute(select(ContentItem).where(ContentItem.id == item_id).with_for_update())
        ).scalar_one()
        if ContentStatus(item.status) != expected_status or item.current_version_id != expected_version:
            raise Stale(f"{item.status}/{item.current_version_id}")
        yield session, item


async def _next(session, item: ContentItem, status: ContentStatus, reason: str | None = None) -> None:  # noqa: ANN001
    await transition(session, item, status, reason=reason)
    await enqueue(session, "pipeline.advance", {"item_id": str(item.id)}, dedup_key=f"advance:{item.id}")


async def advance(ctx: TaskContext, payload: dict[str, Any]) -> None:
    services: Services = ctx.services
    item_id = uuid.UUID(payload["item_id"])
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        if item is None:
            return
        status = ContentStatus(item.status)
        version_id = item.current_version_id
    try:
        handler = STAGES.get(status)
        if handler is None:
            return
        await handler(services, item_id, version_id)
    except Stale as exc:
        log.info("pipeline.stale", item_id=str(item_id), state=str(exc))
    except BudgetExceeded as exc:
        await _pause_for_budget(item_id, exc.reason)
    except ProviderNotConfigured as exc:
        await _fail(item_id, status, version_id, f"не настроен сервис: {exc}")
    except ProviderRejected as exc:
        await _fail(item_id, status, version_id, f"запрос отклонён сервисом: {exc}")
    except ProviderUnavailable as exc:
        raise Reschedule(exc.retry_after_s or 300, f"сервис недоступен: {exc}") from exc
    except PermanentError as exc:
        await _fail(item_id, status, version_id, str(exc))


async def _fail(item_id: uuid.UUID, status: ContentStatus, version_id: uuid.UUID | None, reason: str) -> None:
    try:
        async with _apply(item_id, status, version_id) as (session, item):
            await fail(session, item, reason)
            await notify_owner(
                session,
                key=f"item-failed:{item_id}:{status}:{version_id}",
                kind="error",
                text=f"❗ Материал «{item.topic[:80]}» остановлен на этапе {status}: {reason[:400]}",
            )
    except Stale:
        pass


async def _pause_for_budget(item_id: uuid.UUID, reason: str) -> None:
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id, with_for_update=True)
        if item is not None:
            item.last_error = f"ожидает бюджета: {reason}"
    # Повтор через 6 часов: к этому времени может начаться новый день или лимит изменят.
    raise Reschedule(6 * 3600, f"бюджет: {reason}")


# --- Стадии ---


async def stage_idea(services: Services, item_id: uuid.UUID, version_id: uuid.UUID | None) -> None:
    async with _apply(item_id, ContentStatus.idea, version_id) as (session, item):
        if item.format == "story" and not item.owner_brief:
            await fail(session, item, "для истории перевозки нужны материалы владельца (owner_brief)")
            return
        await _next(
            session,
            item,
            ContentStatus.researching if (item.needs_sources or item.owner_brief) else ContentStatus.drafting,
        )


async def stage_research(services: Services, item_id: uuid.UUID, version_id: uuid.UUID | None) -> None:
    result = await research_item(services, item_id)
    async with _apply(item_id, ContentStatus.researching, version_id) as (session, item):
        if item.needs_sources and result.get("verified", 0) == 0:
            await notify_owner(
                session,
                key=f"no-sources:{item_id}",
                kind="warning",
                text=f"По теме «{item.topic[:100]}» не найдено подтверждённых источников. "
                "Материал будет написан без внешних фактов и помечен для ручной проверки.",
            )
        await _next(session, item, ContentStatus.drafting, reason=f"источников: {result.get('sources', 0)}")


async def stage_draft(
    services: Services,
    item_id: uuid.UUID,
    version_id: uuid.UUID | None,
    *,
    qa_feedback: list[str] | None = None,
) -> None:
    new_version_id = await write_copy(
        services, item_id, qa_feedback=qa_feedback, origin="qa_fix" if qa_feedback else "copywriter"
    )
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id, with_for_update=True)
        assert item is not None
        if (
            ContentStatus(item.status) not in {ContentStatus.drafting, ContentStatus.changes_requested}
            or item.current_version_id != new_version_id
        ):
            return
        if ContentStatus(item.status) == ContentStatus.changes_requested:
            await transition(session, item, ContentStatus.drafting)
        version = await load_version(session, new_version_id)
        assert version is not None
        has_media = bool(version.media_links)
        needs_media = item.format in FORMATS_WITH_IMAGE | FORMATS_WITH_VIDEO and (
            not has_media or bool(item.pending_video_params)
        )
        await _next(
            session, item, ContentStatus.media_generation if needs_media else ContentStatus.quality_check
        )


async def stage_changes(services: Services, item_id: uuid.UUID, version_id: uuid.UUID | None) -> None:
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        assert item is not None
        video_only = bool(item.pending_video_params) and not item.pending_change_request
    if not video_only:
        await stage_draft(services, item_id, version_id)
        return
    # Только пересборка видео: текст прежний, новая версия без медиа.
    async with _apply(item_id, ContentStatus.changes_requested, version_id) as (session, item):
        previous = await load_version(session, version_id)
        assert previous is not None
        disclosure = (await get_channel(session)).settings.brand.synthetic_disclosure
        await new_version(
            session,
            item,
            title=previous.title,
            body_html=_strip_disclosure(previous.body_html, disclosure),
            origin="video_regeneration",
            poll=previous.poll,
            video_script=previous.video_script,
            hashtags=previous.hashtags,
            cta_text=previous.cta_text,
            publish_options=previous.publish_options,
            change_request=json.dumps(item.pending_video_params, ensure_ascii=False),
        )
        await _next(session, item, ContentStatus.media_generation)


async def stage_media(services: Services, item_id: uuid.UUID, version_id: uuid.UUID | None) -> None:
    assert version_id is not None
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        assert item is not None
        fmt = item.format
    if fmt in FORMATS_WITH_VIDEO:
        done = await _video_stage(services, item_id, version_id)
        if not done:
            return
    elif fmt in FORMATS_WITH_IMAGE:
        warnings = await prepare_visuals(services, item_id, version_id)
        if warnings:
            async with session_scope() as session:
                v = await load_version(session, version_id)
                if v is not None and v.frozen_at is None:
                    v.publish_options = {**(v.publish_options or {}), "media_warnings": warnings}
    async with _apply(item_id, ContentStatus.media_generation, version_id) as (session, item):
        version = await load_version(session, version_id)
        assert version is not None
        await _ensure_disclosure(session, item, version)
        item.pending_video_params = None
        await _next(session, item, ContentStatus.quality_check)


def _strip_disclosure(body: str, disclosure: str | None) -> str:
    if disclosure:
        return body.replace(f"\n\n<i>{telegram_html.escape(disclosure)}</i>", "")
    return body


async def _ensure_disclosure(session, item: ContentItem, version) -> None:  # noqa: ANN001
    """Если в материале синтетические кадры, в подпись добавляется пометка."""
    channel = await get_channel(session)
    disclosure = channel.settings.brand.synthetic_disclosure
    synthetic = any(
        link.asset.is_synthetic or (link.asset.render_params or {}).get("synthetic_scenes")
        for link in version.media_links
    )
    if (
        synthetic
        and disclosure
        and disclosure.lower() not in telegram_html.visible_text(version.body_html).lower()
    ):
        version.body_html = f"{version.body_html}\n\n<i>{telegram_html.escape(disclosure)}</i>"


async def _video_stage(services: Services, item_id: uuid.UUID, version_id: uuid.UUID) -> bool:
    """True — ролик готов и прикреплён; False — ждём ИИ-сцен."""
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        version = await load_version(session, version_id)
        assert item is not None and version is not None
        script = version.video_script or {"aspect": "9:16", "scenes": []}
        params = dict(item.pending_video_params or {})
        jobs = await ai_video.jobs_for_version(session, item_id, version_id)
        source_ids = (item.media_requirements or {}).get("source_asset_ids") or []
        sources = await video_editor.item_sources(session, item_id, source_ids)
        channel = await get_channel(session)
    if params.get("aspect"):
        script = {**script, "aspect": params["aspect"]}
    if params.get("duration_s") and script.get("scenes"):
        k = float(params["duration_s"]) / max(sum(float(s.get("duration_s", 3)) for s in script["scenes"]), 1)
        script = {
            **script,
            "scenes": [
                {**s, "duration_s": round(float(s.get("duration_s", 3)) * k, 2)} for s in script["scenes"]
            ],
        }

    wants_ai = any(s.get("shot") == "ai" for s in script.get("scenes") or []) and not params.get("no_ai")
    if wants_ai and services.video is not None and not jobs:
        created = await ai_video.create_scene_jobs(services, item_id, version_id, script, params)
        if created:
            return False
    if ai_video.active(jobs):
        return False

    # Анализ исходников и сборка.
    candidates: list[video_editor.Candidate] = []
    transcripts: dict[str, list[dict[str, Any]]] = {}
    for asset in sources:
        probe_data = await video_editor.analyze_source(services, asset.id, item_id)
        transcripts[str(asset.id)] = probe_data.get("transcript") or []
        candidates += video_editor.build_candidates(asset, probe_data, order_base=len(candidates))
    scenes = script.get("scenes") or []
    selection: dict[int, list[str]] = {}
    if candidates:
        if services.llm is not None and any(c.speech for c in candidates):
            selection = await video_editor.llm_selection(services, item_id, scenes, candidates)
        if not selection:
            selection = video_editor.deterministic_selection(scenes, candidates)
    async with session_scope() as session:
        jobs = await ai_video.jobs_for_version(session, item_id, version_id)
        ai_assets = await ai_video.succeeded_assets(session, jobs)
        failed_jobs = [j for j in jobs if j.status in {VideoJobStatus.failed, VideoJobStatus.waiting_budget}]
        music = None
        if params.get("music_asset_id"):
            music = await session.get(MediaAsset, uuid.UUID(params["music_asset_id"]))
            if music is None or music.kind != MediaKind.music or not music.rights_confirmed:
                raise PermanentError("музыка не найдена или права на неё не подтверждены")
        version = await load_version(session, version_id)
        assert version is not None
        title = version.title
    brand = channel.settings.brand
    brand_digest = hashlib.sha256(
        json.dumps(brand.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()[:16]
    edl, warnings = video_editor.build_edl(
        script=script,
        title=title,
        candidates=candidates,
        selection=selection,
        ai_scenes=ai_assets,
        brand=brand,
        params=params,
        transcripts=transcripts,
        music=music,
        brand_digest=brand_digest,
    )
    warnings += [
        f"ИИ-сцена {j.scene_index + 1 if j.scene_index is not None else '?'}: {j.error}" for j in failed_jobs
    ]
    if not any(isinstance(s, ClipSegment) for s in edl.segments):
        raise PermanentError(
            "для ролика нет ни исходников с подтверждёнными правами, ни готовых ИИ-сцен — загрузите видео"
        )

    return await _render_and_attach(services, item_id, version_id, edl, warnings, ai_assets)


async def _render_and_attach(
    services: Services,
    item_id: uuid.UUID,
    version_id: uuid.UUID,
    edl: EDL,
    warnings: list[str],
    ai_assets: dict[int, MediaAsset],
) -> bool:
    async with session_scope() as session:
        channel = await get_channel(session)
        job = VideoJob(
            item_id=item_id,
            kind=VideoJobKind.assemble,
            status=VideoJobStatus.processing,
            provider="ffmpeg",
            params={
                "version_id": str(version_id),
                "edl": edl.model_dump(mode="json"),
                "edl_sha256": edl_fingerprint(edl),
            },
            max_attempts=2,
        )
        session.add(job)
        await session.flush()
        job_id = job.id
    brand = channel.settings.brand
    renderer = await make_renderer(services, brand)
    logo = await load_brand_file(services, brand.logo)
    asset_cache: dict[str, Path] = {}
    last_error = ""
    for attempt in (1, 2):
        with temp_dir(services.settings.work_dir, "render-") as tmp:
            workdir = Path(tmp)

            async def resolve(ref: MediaRef, workdir: Path = workdir) -> Path:
                if ref.asset_id not in asset_cache or not asset_cache[ref.asset_id].exists():
                    async with session_scope() as s:
                        asset = await s.get(MediaAsset, uuid.UUID(ref.asset_id))
                    if asset is None or asset.sha256 != ref.sha256:
                        raise PermanentError(f"исходник {ref.asset_id} отсутствует или изменён")
                    path = workdir / f"in_{ref.asset_id}.{asset.storage_key.rsplit('.', 1)[-1]}"
                    asset_cache[ref.asset_id] = await download_verified(services.storage, asset, path)
                return asset_cache[ref.asset_id]

            try:
                output = await render_edl(
                    edl, workdir=workdir, resolve=resolve, renderer=renderer, logo=logo, attempt=attempt
                )
            except FFmpegError as exc:
                last_error = f"{exc} {exc.stderr[-800:]}"
                log.warning("render.failed", item_id=str(item_id), attempt=attempt, error=str(exc))
                asset_cache.clear()
                continue
            synthetic_scenes = sorted(ai_assets)
            parent_ids = sorted(
                {uuid.UUID(s.source.asset_id) for s in edl.segments if isinstance(s, ClipSegment)}, key=str
            )
            async with session_scope() as session:
                video = await store_file(
                    session,
                    services.storage,
                    output.video,
                    kind=MediaKind.render_video,
                    origin=MediaOrigin.rendered,
                    mime="video/mp4",
                    item_id=item_id,
                    channel_id=channel.id,
                    title=edl.title[:200],
                    is_synthetic=False,
                    rights={"license": "own", "note": "монтаж из материалов с подтверждёнными правами"},
                    rights_confirmed=True,
                    parent_ids=parent_ids,
                    probe_info=output.probe,
                    render_params={
                        "edl": edl.model_dump(mode="json"),
                        "edl_sha256": edl_fingerprint(edl),
                        "ffmpeg": output.ffmpeg_version,
                        "settings": output.settings,
                        "loudness_in": output.loudness_in,
                        "loudness_out": output.loudness_out,
                        "analysis": output.analysis.to_dict(),
                        "edit_warnings": warnings + output.warnings,
                        "synthetic_scenes": synthetic_scenes,
                    },
                )
                thumb = await store_bytes(
                    session,
                    services.storage,
                    output.thumbnail_png,
                    kind=MediaKind.thumbnail,
                    origin=MediaOrigin.rendered,
                    mime="image/png",
                    item_id=item_id,
                    channel_id=channel.id,
                    title=f"Превью: {edl.title[:150]}",
                    rights={"license": "own"},
                    rights_confirmed=True,
                    parent_ids=[video.id],
                    render_params={"template": "video_thumbnail", "from_video": str(video.id)},
                )
                version = await load_version(session, version_id)
                assert version is not None
                if (
                    version.frozen_at is not None
                    or (await session.get(ContentItem, item_id)).current_version_id != version_id
                ):
                    raise Stale("версия сменилась во время рендера")
                await attach_media(session, version, video, role="primary")
                await attach_media(session, version, thumb, role="thumbnail")
                job = await session.get(VideoJob, job_id)
                assert job is not None
                job.status = VideoJobStatus.succeeded
                job.output_asset_id = video.id
                job.attempts = attempt
                job.completed_at = utcnow()
            return True
    async with session_scope() as session:
        job = await session.get(VideoJob, job_id)
        assert job is not None
        job.status = VideoJobStatus.failed
        job.attempts = 2
        job.error = last_error[-2000:]
    raise PermanentError(f"монтаж не удался после повторной попытки: {last_error[:400]}")


async def stage_qa(services: Services, item_id: uuid.UUID, version_id: uuid.UUID | None) -> None:
    assert version_id is not None
    report = await qa.run_qa(services, item_id, version_id)
    async with _apply(item_id, ContentStatus.quality_check, version_id) as (session, item):
        channel = await get_channel(session)
        if (
            report.status == QAStatus.failed
            and report.text_fixable_only()
            and item.auto_fix_rounds < channel.settings.qa.max_auto_fix_rounds
        ):
            item.auto_fix_rounds += 1
            await transition(
                session, item, ContentStatus.drafting, reason="автоисправление по замечаниям проверки"
            )
            await enqueue(
                session,
                "pipeline.fix",
                {
                    "item_id": str(item.id),
                    "feedback": [f"{f.message} {f.quote}".strip() for f in report.blocking],
                },
                dedup_key=f"fix:{item.id}",
            )
            return
        version = await load_version(session, version_id)
        assert version is not None
        digest = await freeze(session, item, version)
        session.add(
            ApprovalEvent(
                item_id=item.id,
                version_id=version_id,
                content_hash=digest,
                action=ApprovalAction.submitted,
                payload={
                    "qa_status": report.status.value,
                    "blocking": len(report.blocking),
                    "manual": len(report.manual),
                },
            )
        )
        await transition(session, item, ContentStatus.awaiting_approval, reason=f"QA: {report.status}")
        await enqueue(
            session,
            "approval.send",
            {"item_id": str(item.id), "version_id": str(version_id)},
            dedup_key=f"approval.send:{version_id}",
        )


async def fix(ctx: TaskContext, payload: dict[str, Any]) -> None:
    item_id = uuid.UUID(payload["item_id"])
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        if item is None or ContentStatus(item.status) != ContentStatus.drafting:
            return
        version_id = item.current_version_id
    await stage_draft(ctx.services, item_id, version_id, qa_feedback=payload.get("feedback") or [])


async def stage_approved(services: Services, item_id: uuid.UUID, version_id: uuid.UUID | None) -> None:
    async with _apply(item_id, ContentStatus.approved, version_id) as (session, item):
        when = await schedule(session, item)
        if when is None:
            await notify_owner(
                session,
                key=f"no-slot:{item_id}:{utcnow():%Y%m%d}",
                kind="warning",
                text=f"Для одобренного материала {str(item_id)[:8]} нет свободного времени — назначьте вручную.",
            )


STAGES = {
    ContentStatus.idea: stage_idea,
    ContentStatus.researching: stage_research,
    ContentStatus.drafting: stage_draft,
    ContentStatus.changes_requested: stage_changes,
    ContentStatus.media_generation: stage_media,
    ContentStatus.quality_check: stage_qa,
    ContentStatus.approved: stage_approved,
}
