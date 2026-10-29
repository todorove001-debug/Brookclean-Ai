"""AI Video Agent: короткие иллюстративные сцены во внешнем видеогенераторе.

Жизненный цикл задания video_jobs:
pending → (резерв бюджета) → submitted → processing → succeeded | failed
                     ↘ waiting_budget (ждёт решения владельца)   ↘ waiting_provider (сервис недоступен, повтор позже)
Успех никогда не имитируется: при недоступности сервиса задача ждёт или завершается ошибкой.
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.agents.base import run_agent
from app.agents.visual import review_image
from app.budget.service import BudgetExceeded, commit_usage, notify_budget_stop, release_usage, reserve
from app.content.channel import get_channel
from app.database.enums import ACTIVE_VIDEO_JOB_STATUSES, MediaKind, MediaOrigin, VideoJobKind, VideoJobStatus
from app.database.models import ContentItem, MediaAsset, VideoJob
from app.database.session import session_scope, utcnow
from app.media.assets import store_file, temp_dir
from app.monitoring.alerts import notify_owner
from app.monitoring.logging import get_logger
from app.orchestration.queue import Reschedule, enqueue
from app.orchestration.services import Services
from app.providers.base import ProviderNotConfigured, ProviderRejected, ProviderUnavailable
from app.providers.video.base import VideoRequest, VideoStatus
from app.video.ffmpeg import FFmpegError, analyze, decode_errors, extract_frame, probe

log = get_logger(__name__)


class ScenePrompt(BaseModel):
    scene_index: int
    prompt: str


class ScenePrompts(BaseModel):
    scenes: list[ScenePrompt] = Field(default_factory=list)


async def create_scene_jobs(
    services: Services, item_id: uuid.UUID, version_id: uuid.UUID, script: dict, params: dict
) -> list[uuid.UUID]:
    """Готовит промпты и создаёт задания для сцен типа ai. Задания ставятся в очередь сразу."""
    if services.video is None:
        raise ProviderNotConfigured("видеогенератор не подключён (VIDEO_PROVIDER)", provider="video")
    scenes = [(i, s) for i, s in enumerate(script.get("scenes") or []) if s.get("shot") == "ai"]
    if not scenes:
        return []
    async with session_scope() as session:
        item = await session.get(ContentItem, item_id)
        budget = (await get_channel(session)).settings.budget
        assert item is not None
        topic = item.topic
    extra = params.get("style") or ""
    prompts = await run_agent(
        services,
        agent="ai_video_prompt",
        schema=ScenePrompts,
        item_id=item_id,
        effort="medium",
        expected_output_tokens=300 * len(scenes),
        max_tokens=8000,
        prompt="\n".join(
            [
                f"Тема ролика: {topic}",
                f"Дополнительные пожелания владельца: {extra or '—'}",
                "Сцены:",
                *[f"- {i}: {s.get('duration_s')} с — {s.get('description')}" for i, s in scenes],
            ]
        ),
    )
    by_index = {p.scene_index: p.prompt for p in prompts.scenes}
    aspect = params.get("aspect") or script.get("aspect") or "9:16"
    quality = params.get("quality", "standard")
    created: list[uuid.UUID] = []
    async with session_scope() as session:
        for i, scene in scenes:
            prompt = by_index.get(i)
            if not prompt:
                continue
            request = services.video.normalize(
                VideoRequest(
                    prompt=prompt,
                    duration_s=float(params.get("scene_duration_s") or scene.get("duration_s") or 4),
                    aspect=aspect,
                    quality=quality,
                )
            )
            job = VideoJob(
                item_id=item_id,
                kind=VideoJobKind.ai_scene,
                status=VideoJobStatus.pending,
                provider=services.video.name,
                model=request.model,
                scene_index=i,
                prompt=request.prompt,
                params={
                    "version_id": str(version_id),
                    "duration_s": request.duration_s,
                    "size": request.size,
                    "aspect": aspect,
                    "quality": quality,
                    "notes": request.notes,
                    "description": scene.get("description", ""),
                },
                max_attempts=budget.max_retries_paid + 1,
            )
            session.add(job)
            await session.flush()
            await enqueue(
                session, "video.submit", {"job_id": str(job.id)}, dedup_key=f"video.submit:{job.id}"
            )
            created.append(job.id)
    return created


async def submit_job(services: Services, job_id: uuid.UUID) -> None:
    if services.video is None:
        raise ProviderNotConfigured("видеогенератор не подключён", provider="video")
    async with session_scope() as session:
        job = await session.get(VideoJob, job_id, with_for_update=True)
        if job is None or job.status not in {VideoJobStatus.pending, VideoJobStatus.waiting_provider}:
            return
        if job.attempts >= job.max_attempts:
            job.status = VideoJobStatus.failed
            job.error = job.error or "исчерпан лимит попыток"
            await enqueue(
                session, "pipeline.advance", {"item_id": str(job.item_id)}, dedup_key=f"advance:{job.item_id}"
            )
            return
        estimated = services.pricing.video_cost(
            services.video.name, job.model or services.video.model, float(job.params["duration_s"])
        )
        try:
            async with session.begin_nested():
                usage = await reserve(
                    session,
                    provider=services.video.name,
                    operation="video.generate",
                    estimated_usd=estimated,
                    model=job.model,
                    item_id=job.item_id,
                    is_video_generation=True,
                    units={"seconds": job.params["duration_s"], "size": job.params["size"]},
                )
        except BudgetExceeded as exc:
            job.status = VideoJobStatus.waiting_budget
            job.error = exc.reason
            await notify_budget_stop(session, exc)
            await enqueue(
                session, "pipeline.advance", {"item_id": str(job.item_id)}, dedup_key=f"advance:{job.item_id}"
            )
            return
        job.usage_id = usage.id
        job.estimated_cost_usd = estimated
        job.attempts += 1
        from app.providers.video.base import NormalizedVideoRequest

        request = NormalizedVideoRequest(
            prompt=job.prompt or "",
            duration_s=int(job.params["duration_s"]),
            size=job.params["size"],
            model=job.model or services.video.model,
        )
        usage_id = usage.id
    try:
        submission = await services.video.submit(request)
    except ProviderUnavailable as exc:
        async with session_scope() as session:
            await release_usage(session, usage_id, str(exc))
            job = await session.get(VideoJob, job_id, with_for_update=True)
            assert job is not None
            job.status = VideoJobStatus.waiting_provider
            job.error = f"сервис недоступен: {exc}"
            job.attempts = max(job.attempts - 1, 0)  # попытка не израсходована: запрос не принят
            job.usage_id = None
        raise Reschedule(exc.retry_after_s or 300, f"видеогенератор недоступен: {exc}") from exc
    except (ProviderRejected, ProviderNotConfigured) as exc:
        async with session_scope() as session:
            await release_usage(session, usage_id, str(exc))
            job = await session.get(VideoJob, job_id, with_for_update=True)
            assert job is not None
            job.status = VideoJobStatus.failed
            job.error = f"запрос отклонён: {exc}"
            job.error_code = exc.code
            job.usage_id = None
            await enqueue(
                session, "pipeline.advance", {"item_id": str(job.item_id)}, dedup_key=f"advance:{job.item_id}"
            )
        return
    async with session_scope() as session:
        job = await session.get(VideoJob, job_id, with_for_update=True)
        assert job is not None
        job.status = VideoJobStatus.submitted
        job.provider_job_id = submission.provider_job_id
        job.submitted_at = utcnow()
        job.error = None
        if submission.estimated_cost_credits is not None:
            job.params = {**job.params, "estimated_credits": submission.estimated_cost_credits}
        job.next_poll_at = utcnow() + timedelta(seconds=services.settings.video_poll_interval_s)
        await enqueue(
            session,
            "video.poll",
            {"job_id": str(job.id)},
            delay_s=services.settings.video_poll_interval_s,
            dedup_key=f"video.poll:{job.id}",
        )


def _actual_cost(services: Services, job: VideoJob, status: VideoStatus) -> tuple[Decimal, str]:
    if status.cost_credits is not None and job.provider == "runway":
        return services.pricing.runway_credits_to_usd(status.cost_credits), "provider"
    return job.estimated_cost_usd or Decimal(0), "estimate"


async def poll_job(services: Services, job_id: uuid.UUID) -> None:
    if services.video is None:
        raise ProviderNotConfigured("видеогенератор не подключён", provider="video")
    async with session_scope() as session:
        job = await session.get(VideoJob, job_id)
        if (
            job is None
            or job.status not in {VideoJobStatus.submitted, VideoJobStatus.processing}
            or not job.provider_job_id
        ):
            return
        provider_job_id, submitted_at = job.provider_job_id, job.submitted_at
    try:
        status = await services.video.status(provider_job_id)
    except ProviderUnavailable as exc:
        raise Reschedule(
            max(exc.retry_after_s or 0, services.settings.video_poll_interval_s * 3),
            f"опрос не удался: {exc}",
        ) from exc

    if status.state in {"pending", "processing"}:
        waited = utcnow() - (submitted_at or utcnow())
        if waited > timedelta(minutes=services.settings.video_max_wait_minutes):
            async with session_scope() as session:
                job = await session.get(VideoJob, job_id, with_for_update=True)
                assert job is not None
                # Задание у поставщика могло продолжиться и быть оплачено — списываем по оценке.
                if job.usage_id:
                    await commit_usage(
                        session, job.usage_id, job.estimated_cost_usd or Decimal(0), cost_source="estimate"
                    )
                await _retry_or_fail(
                    session,
                    job,
                    f"генерация не завершилась за {services.settings.video_max_wait_minutes} мин",
                )
            return
        async with session_scope() as session:
            job = await session.get(VideoJob, job_id, with_for_update=True)
            assert job is not None
            job.status = VideoJobStatus.processing
            job.next_poll_at = utcnow() + timedelta(seconds=services.settings.video_poll_interval_s)
        raise Reschedule(
            services.settings.video_poll_interval_s, f"генерация: {status.state} {status.progress or ''}"
        )

    if status.state in {"failed", "cancelled"}:
        async with session_scope() as session:
            job = await session.get(VideoJob, job_id, with_for_update=True)
            assert job is not None
            if job.usage_id:
                if status.cost_credits is not None:
                    actual, source = _actual_cost(services, job, status)
                    await commit_usage(
                        session,
                        job.usage_id,
                        actual,
                        cost_source=source,
                        units={"credits": status.cost_credits},
                    )
                    job.actual_cost_usd = actual
                else:
                    await release_usage(session, job.usage_id, status.error)
            job.error_code = status.error_code
            await _retry_or_fail(session, job, f"поставщик сообщил об ошибке: {status.error or status.state}")
        return

    # Успех: скачать, проверить, сохранить.
    async with session_scope() as session:
        job = await session.get(VideoJob, job_id)
        assert job is not None
    with temp_dir(services.settings.work_dir, "aiv-") as tmp:
        dest = Path(tmp) / "scene.mp4"
        try:
            await services.video.download(provider_job_id, status, dest, max_bytes=500 * 1024 * 1024)
        except ProviderUnavailable as exc:
            raise Reschedule(60, f"загрузка результата: {exc}") from exc
        problems: list[str] = []
        try:
            info = await probe(dest)
            errors = await decode_errors(dest)
            analysis = await analyze(dest, info)
        except FFmpegError as exc:
            problems.append(f"файл повреждён: {exc}")
            info = None
        if info is not None:
            if errors:
                problems.append("ошибки декодирования: " + "; ".join(errors[:3]))
            if not info.has_video or info.duration_s < 1:
                problems.append("в файле нет видео или он слишком короткий")
            if analysis.ratio(analysis.black) > 0.3:
                problems.append(f"чёрные кадры {analysis.ratio(analysis.black):.0%} длительности")
        review = None
        if info is not None and not problems:
            frames = []
            for k, at in enumerate((info.duration_s * 0.2, info.duration_s * 0.5, info.duration_s * 0.8)):
                frames.append(
                    (await extract_frame(dest, at, Path(tmp) / f"f{k}.jpg", width=768)).read_bytes()
                )
            review_issues = []
            for frame in frames:
                r = await review_image(
                    services, frame, "image/jpeg", job.params.get("description", ""), job.item_id
                )
                review_issues += [i.model_dump() for i in r.issues]
            review = review_issues
            if any(i["severity"] == "blocking" for i in review_issues):
                problems.append(
                    "брак в кадре: "
                    + "; ".join(i["description"] for i in review_issues if i["severity"] == "blocking")[:500]
                )
        async with session_scope() as session:
            job = await session.get(VideoJob, job_id, with_for_update=True)
            assert job is not None
            actual, source = _actual_cost(services, job, status)
            if job.usage_id:
                await commit_usage(
                    session,
                    job.usage_id,
                    actual,
                    cost_source=source,
                    units={"credits": status.cost_credits} if status.cost_credits is not None else None,
                )
            job.actual_cost_usd = actual
            if problems:
                await _retry_or_fail(session, job, "; ".join(problems))
                return
            asset = await store_file(
                session,
                services.storage,
                dest,
                kind=MediaKind.ai_video_scene,
                origin=MediaOrigin.ai_generated,
                mime="video/mp4",
                item_id=job.item_id,
                title=f"ИИ-сцена {job.scene_index}",
                is_synthetic=True,
                rights={
                    "license": "generated",
                    "provider": job.provider,
                    "model": job.model,
                    "note": "сгенерировано ИИ; использование по условиям поставщика",
                },
                rights_confirmed=True,
                render_params={"prompt": job.prompt, **job.params},
                provider=job.provider,
                provider_job_id=provider_job_id,
                probe_info=info,
                extra_probe={"analysis": analysis.to_dict(), "vision_review": review or []},
            )
            job.output_asset_id = asset.id
            job.status = VideoJobStatus.succeeded
            job.completed_at = utcnow()
            job.error = None
            await enqueue(
                session, "pipeline.advance", {"item_id": str(job.item_id)}, dedup_key=f"advance:{job.item_id}"
            )


async def _retry_or_fail(session, job: VideoJob, reason: str) -> None:  # noqa: ANN001
    job.usage_id = None
    job.provider_job_id = None
    if job.attempts < job.max_attempts:
        job.status = VideoJobStatus.pending
        job.error = f"попытка {job.attempts} не удалась: {reason}"
        await enqueue(
            session, "video.submit", {"job_id": str(job.id)}, delay_s=30, dedup_key=f"video.submit:{job.id}"
        )
        return
    job.status = VideoJobStatus.failed
    job.error = reason[:2000]
    job.completed_at = utcnow()
    await notify_owner(
        session,
        key=f"video-failed:{job.id}",
        kind="error",
        text=f"ИИ-сцена {job.scene_index} для материала {str(job.item_id)[:8]} не получена: {reason[:300]}",
    )
    await enqueue(
        session, "pipeline.advance", {"item_id": str(job.item_id)}, dedup_key=f"advance:{job.item_id}"
    )


async def jobs_for_version(session, item_id: uuid.UUID, version_id: uuid.UUID) -> list[VideoJob]:  # noqa: ANN001
    rows = (
        (
            await session.execute(
                select(VideoJob).where(VideoJob.item_id == item_id, VideoJob.kind == VideoJobKind.ai_scene)
            )
        )
        .scalars()
        .all()
    )
    return [j for j in rows if j.params.get("version_id") == str(version_id)]


def active(jobs: list[VideoJob]) -> list[VideoJob]:
    return [
        j for j in jobs if j.status in ACTIVE_VIDEO_JOB_STATUSES and j.status != VideoJobStatus.waiting_budget
    ]


async def succeeded_assets(session, jobs: list[VideoJob]) -> dict[int, MediaAsset]:  # noqa: ANN001
    out: dict[int, MediaAsset] = {}
    for job in jobs:
        if job.status == VideoJobStatus.succeeded and job.output_asset_id and job.scene_index is not None:
            asset = await session.get(MediaAsset, job.output_asset_id)
            if asset is not None:
                out[job.scene_index] = asset
    return out
