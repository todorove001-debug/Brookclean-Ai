"""Рендер ролика по EDL средствами FFmpeg.

Этапы:
1. каждый фрагмент приводится к единому формату (размер, частота кадров, звук 48 кГц стерео);
2. титры рендерятся из шаблонов бренда и превращаются в видеофрагменты;
3. склейка concat без перекодирования;
4. логотип, текстовые вставки, субтитры, музыка с приглушением под речь;
5. нормализация громкости EBU R128 в два прохода;
6. превью и проверка результата.
Исходники не изменяются: всё создаётся во временной папке.
"""

from __future__ import annotations

import io
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image, ImageFont

from app.media.templates import TemplateRenderer
from app.video import subtitles as subs
from app.video.edl import EDL, CardSegment, ClipSegment, MediaRef
from app.video.ffmpeg import (
    FFmpegError,
    FrameAnalysis,
    ProbeInfo,
    analyze,
    extract_frame,
    ffmpeg,
    ffmpeg_version,
    loudness,
    probe,
)

Resolver = Callable[[MediaRef], Awaitable[Path]]
Heartbeat = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class RenderOutput:
    video: Path
    thumbnail_png: bytes
    probe: ProbeInfo
    analysis: FrameAnalysis
    loudness_in: dict[str, float] | None
    loudness_out: dict[str, float] | None
    ffmpeg_version: str
    settings: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _video_chain(reframe: str, w: int, h: int, fps: int) -> str:
    tail = f"fps={fps},setsar=1,format=yuv420p"
    if reframe == "crop":
        return f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},{tail}[v]"
    if reframe == "fit":
        return f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,{tail}[v]"
    # Размытый фон: горизонтальное видео в вертикальном кадре без чёрных полос.
    return (
        f"[0:v]split=2[bgsrc][fgsrc];"
        f"[bgsrc]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=24:2,eq=brightness=-0.08[bg];"
        f"[fgsrc]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];"
        f"[bg][fg]overlay=(W-w)/2:(H-h)/2,{tail}[v]"
    )


AUDIO_FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"


async def _clip(
    seg: ClipSegment, src: Path, src_info: ProbeInfo, out: Path, edl: EDL, enc: dict[str, str]
) -> None:
    w, h = edl.output.size
    dur = seg.duration
    use_audio = src_info.has_audio and not seg.mute
    graph = _video_chain(edl.output.reframe, w, h, edl.output.fps)
    graph += f";[0:a]{AUDIO_FMT},apad[a]" if use_audio else f";[1:a]{AUDIO_FMT}[a]"
    args = ["-ss", f"{seg.start:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    if not use_audio:
        args += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
    args += [
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        f"{dur:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        enc["preset"],
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(out),
    ]
    await ffmpeg(*args, timeout_s=float(enc["timeout"]))


async def _card(
    seg: CardSegment, renderer: TemplateRenderer, out: Path, edl: EDL, enc: dict[str, str]
) -> None:
    w, h = edl.output.size
    png = renderer.render(seg.template, {"headline": seg.headline, "subline": seg.subline}, size=(w, h)).png
    card = out.with_suffix(".png")
    card.write_bytes(png)
    d = seg.duration
    fade = min(0.4, d / 4)
    await ffmpeg(
        "-loop",
        "1",
        "-t",
        f"{d:.3f}",
        "-i",
        str(card),
        "-f",
        "lavfi",
        "-t",
        f"{d:.3f}",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-filter_complex",
        f"[0:v]fps={edl.output.fps},scale={w}:{h},setsar=1,format=yuv420p,fade=t=in:st=0:d={fade:.2f},"
        f"fade=t=out:st={d - fade:.2f}:d={fade:.2f}[v];[1:a]{AUDIO_FMT}[a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        f"{d:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        enc["preset"],
        "-crf",
        "18",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(out),
        timeout_s=float(enc["timeout"]),
    )


def _logo_png(logo: bytes, w: int, h: int, edl: EDL) -> tuple[bytes, int, int]:
    assert edl.logo is not None
    img = Image.open(io.BytesIO(logo)).convert("RGBA")
    target_w = int(w * edl.logo.width_ratio)
    img = img.resize((target_w, max(1, int(img.height * target_w / img.width))), Image.Resampling.LANCZOS)
    if edl.logo.opacity < 1:
        alpha = img.getchannel("A").point(lambda a: int(a * edl.logo.opacity))  # type: ignore[union-attr]
        img.putalpha(alpha)
    margin = int(min(w, h) * edl.logo.margin_ratio)
    x = margin if "left" in edl.logo.position else w - img.width - margin
    y = margin if "top" in edl.logo.position else h - img.height - margin
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), x, y


def _font_family(path: str) -> str:
    try:
        return ImageFont.truetype(path, 12).getname()[0]
    except OSError:
        return "DejaVu Sans"


async def render_edl(
    edl: EDL,
    *,
    workdir: Path,
    resolve: Resolver,
    renderer: TemplateRenderer,
    logo: bytes | None,
    attempt: int = 1,
    heartbeat: Heartbeat | None = None,
) -> RenderOutput:
    workdir.mkdir(parents=True, exist_ok=True)
    w, h = edl.output.size
    # Повторная попытка — более лёгкие настройки кодирования (меньше памяти и времени).
    enc = {
        "preset": "veryfast" if attempt == 1 else "ultrafast",
        "timeout": "1200",
        "final_preset": edl.output.preset if attempt == 1 else "faster",
    }
    warnings: list[str] = []
    sources: dict[str, tuple[Path, ProbeInfo]] = {}
    segment_files: list[Path] = []

    async def beat() -> None:
        if heartbeat:
            await heartbeat()

    for i, seg in enumerate(edl.segments):
        out = workdir / f"seg_{i:03d}.mp4"
        if isinstance(seg, ClipSegment):
            if seg.source.asset_id not in sources:
                path = await resolve(seg.source)
                sources[seg.source.asset_id] = (path, await probe(path))
            path, info = sources[seg.source.asset_id]
            if seg.end > info.duration_s + 0.05:
                raise FFmpegError(
                    f"фрагмент {i}: конец {seg.end} с за пределами исходника ({info.duration_s} с)"
                )
            await _clip(seg, path, info, out, edl, enc)
        else:
            await _card(seg, renderer, out, edl, enc)
        segment_files.append(out)
        await beat()

    concat_list = workdir / "concat.txt"
    concat_list.write_text("".join(f"file '{p.name}'\n" for p in segment_files), encoding="utf-8")
    joined = workdir / "joined.mp4"
    await ffmpeg("-f", "concat", "-safe", "0", "-i", concat_list.name, "-c", "copy", joined.name, cwd=workdir)
    await beat()

    # --- Итоговый проход: оформление и звук ---
    inputs: list[str] = ["-i", joined.name]
    graph: list[str] = []
    vlabel = "0:v"
    next_input = 1
    if edl.logo is not None and logo:
        png, x, y = _logo_png(logo, w, h, edl)
        (workdir / "logo.png").write_bytes(png)
        inputs += ["-i", "logo.png"]
        graph.append(f"[{vlabel}][{next_input}:v]overlay={x}:{y}[vlogo]")
        vlabel, next_input = "vlogo", next_input + 1
    for k, ov in enumerate(edl.overlays):
        png = renderer.render("text_overlay", {"headline": ov.text}, size=(w, h)).png
        name = f"overlay_{k}.png"
        (workdir / name).write_bytes(png)
        inputs += ["-i", name]
        graph.append(
            f"[{vlabel}][{next_input}:v]overlay=0:0:enable='between(t,{ov.start:.2f},{ov.end:.2f})'[vov{k}]"
        )
        vlabel, next_input = f"vov{k}", next_input + 1
    if edl.subtitles:
        segments = subs.normalize(edl.subtitles, edl.duration)
        font_path = renderer.fonts.get("bold") or renderer.fonts["regular"]
        fonts_dir = workdir / "fonts"
        fonts_dir.mkdir(exist_ok=True)
        (fonts_dir / Path(font_path).name).write_bytes(Path(font_path).read_bytes())
        ass = subs.build_ass(
            segments,
            width=w,
            height=h,
            font_name=_font_family(font_path),
            box=renderer.brand.colors.secondary,
        )
        (workdir / "subs.ass").write_text(ass, encoding="utf-8")
        (workdir / "subs.srt").write_text(subs.to_srt(segments), encoding="utf-8")
        graph.append(f"[{vlabel}]subtitles=subs.ass:fontsdir=fonts[vsub]")
        vlabel = "vsub"
    graph.append(f"[{vlabel}]format=yuv420p[vout]")

    alabel = "0:a"
    if edl.music is not None:
        music_path = await resolve(edl.music.source)
        inputs += ["-stream_loop", "-1", "-i", str(music_path)]
        m = next_input
        fade_start = max(edl.duration - edl.music.fade_out_s, 0)
        graph.append(
            f"[{m}:a]{AUDIO_FMT},atrim=0:{edl.duration:.3f},volume={edl.music.volume},"
            f"afade=t=out:st={fade_start:.2f}:d={edl.music.fade_out_s:.2f}[music]"
        )
        if edl.music.duck:
            graph.append("[0:a]asplit=2[voice][sc]")
            graph.append("[music][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]")
            graph.append("[voice][ducked]amix=inputs=2:duration=first:normalize=0[aout]")
        else:
            graph.append("[0:a][music]amix=inputs=2:duration=first:normalize=0[aout]")
        alabel = "aout"
    else:
        graph.append(f"[0:a]{AUDIO_FMT}[aout]")
        alabel = "aout"

    pre = workdir / "pre.mkv"
    await ffmpeg(
        *inputs,
        "-filter_complex",
        ";".join(graph),
        "-map",
        "[vout]",
        "-map",
        f"[{alabel}]",
        "-t",
        f"{edl.duration:.3f}",
        "-c:v",
        "libx264",
        "-preset",
        enc["final_preset"],
        "-crf",
        str(edl.output.crf),
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(edl.output.fps),
        "-c:a",
        "pcm_s16le",
        pre.name,
        cwd=workdir,
    )
    await beat()

    # --- Громкость: измерение и нормализация (EBU R128) ---
    measured = await loudness(pre)
    final = workdir / "final.mp4"
    ln = edl.loudness
    if measured and measured.get("input_i", -70) > -60:
        af = (
            f"loudnorm=I={ln.integrated}:TP={ln.true_peak}:LRA={ln.lra}:measured_I={measured['input_i']}:"
            f"measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}:"
            f"measured_thresh={measured['input_thresh']}:offset={measured.get('target_offset', 0)}:linear=true,{AUDIO_FMT}"
        )
    else:
        af = AUDIO_FMT
        warnings.append("в ролике нет звука или он почти беззвучный — нормализация громкости пропущена")
    await ffmpeg(
        "-i",
        pre.name,
        "-map",
        "0:v",
        "-map",
        "0:a",
        "-c:v",
        "copy",
        "-af",
        af,
        "-c:a",
        "aac",
        "-b:a",
        edl.output.audio_bitrate,
        "-movflags",
        "+faststart",
        final.name,
        cwd=workdir,
    )
    await beat()

    info = await probe(final)
    analysis = await analyze(final, info)
    measured_out = await loudness(final)
    if final.stat().st_size > edl.output.max_bytes:
        warnings.append(
            f"файл {final.stat().st_size / 1048576:.1f} МБ больше лимита {edl.output.max_bytes / 1048576:.0f} МБ"
        )

    # --- Превью: кадр вне чёрных и застывших участков ---
    candidates = [
        s.duration / 2 + off
        for s, off in zip(edl.segments, edl.segment_offsets(), strict=True)
        if isinstance(s, ClipSegment)
    ]
    candidates += [info.duration_s * 0.3, info.duration_s * 0.5, 0.5]
    at = next(
        (t for t in candidates if analysis.overlaps(analysis.black, t - 0.1, t + 0.1) == 0), candidates[0]
    )
    # Кадр берётся из склейки без субтитров, вставок и логотипа.
    frame = await extract_frame(joined, at, workdir / "thumb_frame.jpg")
    thumb_size = (720, 1280) if h > w else (1280, 720) if w > h else (1080, 1080)
    thumbnail = renderer.render(
        "video_thumbnail", {"headline": edl.title}, images={"photo": frame.read_bytes()}, size=thumb_size
    ).png

    return RenderOutput(
        video=final,
        thumbnail_png=thumbnail,
        probe=info,
        analysis=analysis,
        loudness_in=measured,
        loudness_out=measured_out,
        ffmpeg_version=await ffmpeg_version(),
        warnings=warnings,
        settings={"attempt": attempt, "encoder": enc, "filter_graph": graph, "loudnorm": af},
    )


def edl_fingerprint(edl: EDL) -> str:
    import hashlib

    return hashlib.sha256(json.dumps(edl.model_dump(mode="json"), sort_keys=True).encode()).hexdigest()
