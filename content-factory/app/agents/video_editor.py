"""Video Editor Agent: монтаж исходников владельца по сценарию.

Детерминированная часть: проверка файлов, анализ кадров, нарезка кандидатов по сменам сцен
без чёрных и застывших участков, сборка EDL, субтитры из расшифровки речи.
Языковая модель только сопоставляет фрагменты сценам (по расшифровке и описанию) — при её
недоступности работает детерминированный выбор по порядку съёмки.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.agents.base import run_agent
from app.budget.service import paid_call
from app.database.enums import MediaKind
from app.database.models import MediaAsset
from app.database.session import session_scope
from app.media.assets import download_verified, temp_dir
from app.monitoring.logging import get_logger
from app.orchestration.services import Services
from app.providers.base import ProviderError
from app.settings.channel import BrandConfig
from app.video import subtitles as subs
from app.video.edl import EDL, CardSegment, ClipSegment, LogoSpec, MediaRef, MusicSpec, OutputSpec, OverlaySpec, SubtitleSegment
from app.video.ffmpeg import FFmpegError, Interval, analyze, decode_errors, extract_audio_for_asr, probe

log = get_logger(__name__)
MIN_CHUNK = 1.5
MAX_CHUNK = 5.0


@dataclass(slots=True)
class Candidate:
    id: str
    asset_id: str
    storage_key: str
    sha256: str
    start: float
    end: float
    speech: str
    order: int

    @property
    def duration(self) -> float:
        return self.end - self.start

    def ref(self) -> MediaRef:
        return MediaRef(asset_id=self.asset_id, storage_key=self.storage_key, sha256=self.sha256)


class SceneChoice(BaseModel):
    scene_index: int
    candidate_ids: list[str] = Field(default_factory=list)


class SceneSelection(BaseModel):
    scenes: list[SceneChoice] = Field(default_factory=list)


def asset_ref(asset: MediaAsset) -> MediaRef:
    return MediaRef(asset_id=str(asset.id), storage_key=asset.storage_key, sha256=asset.sha256)


async def analyze_source(services: Services, asset_id: uuid.UUID, item_id: uuid.UUID | None) -> dict[str, Any]:
    """Проверка исходника и анализ кадров. Результат кешируется в media_assets.probe."""
    async with session_scope() as session:
        asset = await session.get(MediaAsset, asset_id)
        assert asset is not None
        cached = (asset.probe or {}).get("analysis")
        if cached and ("transcript" in (asset.probe or {}) or services.transcriber is None or not asset.has_audio):
            return asset.probe
    with temp_dir(services.settings.work_dir, "src-") as tmp:
        path = await download_verified(services.storage, asset, Path(tmp) / f"src.{asset.storage_key.rsplit('.', 1)[-1]}")
        info = await probe(path)
        if not info.has_video:
            raise FFmpegError("в файле нет видеодорожки")
        errors = await decode_errors(path)
        analysis = await analyze(path, info)
        transcript: list[dict[str, Any]] | None = None
        if services.transcriber is not None and info.has_audio and analysis.ratio(analysis.silence) < 0.9:
            audio = await extract_audio_for_asr(path, path.with_suffix(".mp3"))
            estimated = services.pricing.transcription_cost(services.transcriber.model, info.duration_s)
            try:
                async with paid_call(provider=services.transcriber.name, operation="speech.transcribe", estimated_usd=estimated,
                                     model=services.transcriber.model, item_id=item_id) as call:
                    result = await services.transcriber.transcribe(audio)
                    call.set_actual(services.pricing.transcription_cost(services.transcriber.model, result.duration_s or info.duration_s),
                                    source="tokens", units={"seconds": result.duration_s})
                transcript = [{"start": s.start, "end": s.end, "text": s.text} for s in result.segments]
            except ProviderError as exc:
                log.warning("video.transcription_failed", asset_id=str(asset_id), error=str(exc))
    probe_data = {**info.summary(), "decode_errors": errors[:10], "analysis": analysis.to_dict()}
    if transcript is not None:
        probe_data["transcript"] = transcript
    async with session_scope() as session:
        asset = await session.get(MediaAsset, asset_id, with_for_update=True)
        assert asset is not None
        asset.probe = {**(asset.probe or {}), **probe_data}
        return asset.probe


def build_candidates(asset: MediaAsset, probe_data: dict[str, Any], order_base: int = 0) -> list[Candidate]:
    analysis = probe_data.get("analysis") or {}
    duration = float(probe_data.get("duration_s") or asset.duration_s or 0)
    if duration < MIN_CHUNK or probe_data.get("decode_errors"):
        return []
    bad = [Interval(a, b) for a, b in (analysis.get("black") or []) + (analysis.get("frozen") or [])]
    cuts = [0.0, *[c for c in analysis.get("scene_changes") or [] if 0 < c < duration], duration]
    transcript = probe_data.get("transcript") or []
    out: list[Candidate] = []
    for a, b in zip(cuts, cuts[1:], strict=False):
        t = a + 0.1
        while b - t >= MIN_CHUNK:
            end = min(t + MAX_CHUNK, b - 0.05)
            overlap = sum(max(0.0, min(end, i.end) - max(t, i.start)) for i in bad)
            if overlap / (end - t) <= 0.2:
                speech = " ".join(s["text"] for s in transcript if s["start"] < end and s["end"] > t).strip()
                out.append(Candidate(id=f"c{order_base + len(out)}", asset_id=str(asset.id), storage_key=asset.storage_key,
                                     sha256=asset.sha256, start=round(t, 2), end=round(end, 2), speech=speech,
                                     order=order_base + len(out)))
            t = end
    return out


def deterministic_selection(scenes: list[dict[str, Any]], candidates: list[Candidate]) -> dict[int, list[str]]:
    pool = sorted(candidates, key=lambda c: c.order)
    chosen: dict[int, list[str]] = {}
    for i, scene in enumerate(scenes):
        if scene["shot"] != "source":
            continue
        need, ids = float(scene["duration_s"]), []
        while need > 0.3 and pool:
            c = pool.pop(0)
            ids.append(c.id)
            need -= c.duration
        chosen[i] = ids
    return chosen


async def llm_selection(services: Services, item_id: uuid.UUID, scenes: list[dict[str, Any]], candidates: list[Candidate]) -> dict[int, list[str]]:
    lines = ["Сцены:"]
    lines += [f"- {i}: {s['shot']}, {s['duration_s']} с — {s['description']}; текст: {s.get('voiceover', '')}"
              for i, s in enumerate(scenes) if s["shot"] == "source"]
    lines.append("Фрагменты:")
    lines += [f"- {c.id}: {c.duration:.1f} с, файл {c.asset_id[:8]}, речь: {c.speech[:160] or 'нет'}" for c in candidates[:120]]
    result = await run_agent(services, agent="video_editor", schema=SceneSelection, item_id=item_id, prompt="\n".join(lines),
                             effort="low", expected_output_tokens=600, max_tokens=6000)
    valid = {c.id for c in candidates}
    used: set[str] = set()
    chosen: dict[int, list[str]] = {}
    for choice in result.scenes:
        if not 0 <= choice.scene_index < len(scenes) or scenes[choice.scene_index]["shot"] != "source":
            continue
        ids = [cid for cid in choice.candidate_ids if cid in valid and cid not in used]
        used.update(ids)
        chosen[choice.scene_index] = ids
    return chosen


def build_edl(
    *, script: dict[str, Any], title: str, candidates: list[Candidate], selection: dict[int, list[str]],
    ai_scenes: dict[int, MediaAsset], brand: BrandConfig, params: dict[str, Any], transcripts: dict[str, list[dict[str, Any]]],
    music: MediaAsset | None = None, brand_digest: str = "",
) -> tuple[EDL, list[str]]:
    by_id = {c.id: c for c in candidates}
    used = {cid for ids in selection.values() for cid in ids}
    spare = [c for c in sorted(candidates, key=lambda c: c.order) if c.id not in used]
    warnings: list[str] = []
    segments: list[ClipSegment | CardSegment] = []
    overlays: list[OverlaySpec] = []
    subtitle_items: list[SubtitleSegment] = []
    t = 0.0

    def add_clip(c_ref: MediaRef, start: float, end: float, scene: int, speech_from: str | None) -> None:
        nonlocal t
        segments.append(ClipSegment(source=c_ref, start=start, end=end, scene_index=scene))
        if speech_from is not None:
            for s in transcripts.get(speech_from, []):
                if s["start"] < end and s["end"] > start:
                    subtitle_items.append(SubtitleSegment(start=round(t + max(s["start"], start) - start, 3),
                                                          end=round(t + min(s["end"], end) - start, 3), text=s["text"]))
        t += end - start

    for i, scene in enumerate(script.get("scenes") or []):
        scene_start = t
        want = float(scene.get("duration_s") or 3)
        shot = scene.get("shot")
        has_speech = False
        if shot == "source":
            ids = selection.get(i) or []
            if not ids and spare:
                ids = [spare.pop(0).id]
            for cid in ids:
                c = by_id[cid]
                remaining = want - (t - scene_start)
                if remaining < 0.5:
                    break
                end = round(min(c.end, c.start + max(remaining, 0.5)), 2)
                has_speech |= bool(c.speech)
                add_clip(c.ref(), c.start, end, i, c.asset_id)
            if t == scene_start and i in ai_scenes:
                shot = "ai"
            elif t == scene_start:
                warnings.append(f"сцена {i + 1}: не хватает исходников («{scene.get('description', '')[:80]}») — показан титр")
                shot = "title_card"
        if shot == "ai":
            asset = ai_scenes.get(i)
            if asset is not None and asset.duration_s:
                add_clip(asset_ref(asset), 0.0, round(min(want, asset.duration_s - 0.05), 2), i, None)
            else:
                fallback = spare.pop(0) if spare else None
                if fallback is not None:
                    warnings.append(f"сцена {i + 1}: ИИ-сцены нет — использован фрагмент исходников")
                    add_clip(fallback.ref(), fallback.start, min(fallback.end, fallback.start + want), i, fallback.asset_id)
                else:
                    warnings.append(f"сцена {i + 1}: ИИ-сцена не получена — показан титр")
                    shot = "title_card"
        if shot == "title_card":
            text = scene.get("on_screen_text") or scene.get("voiceover") or scene.get("description") or title
            segments.append(CardSegment(headline=text[:90], duration_s=max(min(want, 4.0), 1.5), scene_index=i))
            t += segments[-1].duration
            continue
        scene_end = t
        if scene.get("on_screen_text"):
            overlays.append(OverlaySpec(text=scene["on_screen_text"][:60], start=round(scene_start, 2),
                                        end=round(min(scene_start + 3.0, scene_end), 2)))
        if scene.get("voiceover") and not has_speech:
            subtitle_items += subs.split_text_by_time(scene["voiceover"], scene_start + 0.1, max(scene_end - 0.1, scene_start + 0.6))

    if params.get("outro", True):
        contacts = " · ".join(brand.contacts[:2])
        segments.append(CardSegment(headline=brand.company_name, subline=contacts, duration_s=2.5))
    if not segments:
        raise ValueError("сценарий пуст")
    edl = EDL(
        title=title,
        output=OutputSpec(aspect=params.get("aspect") or script.get("aspect") or "9:16", reframe=params.get("reframe", "blur_pad")),
        segments=segments, overlays=overlays, subtitles=subtitle_items if params.get("subtitles", True) else [],
        logo=LogoSpec() if brand.logo and params.get("logo", True) else None,
        music=MusicSpec(source=asset_ref(music), volume=float(params.get("music_volume", 0.18))) if music else None,
        brand_digest=brand_digest,
    )
    return edl, warnings


async def item_sources(session, item_id: uuid.UUID, extra_ids: list[str] | None = None) -> list[MediaAsset]:  # noqa: ANN001
    stmt = select(MediaAsset).where(MediaAsset.kind == MediaKind.source_video, MediaAsset.rights_confirmed.is_(True))
    ids = [uuid.UUID(x) for x in extra_ids or []]
    if ids:
        stmt = stmt.where((MediaAsset.item_id == item_id) | (MediaAsset.id.in_(ids)))
    else:
        stmt = stmt.where(MediaAsset.item_id == item_id)
    return list((await session.execute(stmt.order_by(MediaAsset.created_at))).scalars())
