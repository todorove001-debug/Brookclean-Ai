"""Запуск FFmpeg/ffprobe, разбор метаданных и анализ кадров."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.settings.config import get_settings


class FFmpegError(RuntimeError):
    def __init__(self, message: str, stderr: str = ""):
        super().__init__(message)
        self.stderr = stderr[-3000:]


async def run(args: list[str], *, timeout_s: float | None = None) -> tuple[int, str, str]:
    """Запуск без оболочки: аргументы передаются списком, внедрение команд невозможно."""
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise FFmpegError(f"превышено время выполнения {timeout_s} с: {Path(args[0]).name}") from None
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


async def ffmpeg(*args: str, timeout_s: float | None = None) -> str:
    settings = get_settings()
    cmd = [settings.ffmpeg_bin, "-hide_banner", "-nostdin", "-y", *args]
    code, _, err = await run(cmd, timeout_s=timeout_s or settings.render_timeout_s)
    if code != 0:
        raise FFmpegError(f"ffmpeg завершился с кодом {code}", err)
    return err


@dataclass(slots=True)
class ProbeInfo:
    duration_s: float
    width: int | None
    height: int | None
    fps: float | None
    video_codec: str | None
    audio_codec: str | None
    has_video: bool
    has_audio: bool
    rotation: int
    pix_fmt: str | None
    format_name: str
    bit_rate: int | None
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    @property
    def display_size(self) -> tuple[int, int] | None:
        if not self.width or not self.height:
            return None
        if abs(self.rotation) % 180 == 90:
            return self.height, self.width
        return self.width, self.height

    @property
    def orientation(self) -> str:
        size = self.display_size
        if not size:
            return "unknown"
        w, h = size
        if abs(w - h) <= max(w, h) * 0.02:
            return "square"
        return "vertical" if h > w else "horizontal"

    def summary(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("raw", None)
        data["display_size"] = self.display_size
        data["orientation"] = self.orientation
        return data


def _fps(value: str | None) -> float | None:
    if not value or value in {"0/0", "0"}:
        return None
    if "/" in value:
        num, den = value.split("/", 1)
        return round(float(num) / float(den), 3) if float(den) else None
    return float(value)


async def probe(path: Path) -> ProbeInfo:
    settings = get_settings()
    code, out, err = await run(
        [settings.ffprobe_bin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], timeout_s=120
    )
    if code != 0:
        raise FFmpegError("ffprobe не смог прочитать файл — он повреждён или формат не поддерживается", err)
    data = json.loads(out or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    rotation = 0
    if video:
        rotation = int(float((video.get("tags") or {}).get("rotate", 0) or 0))
        for side in video.get("side_data_list") or []:
            if "rotation" in side:
                rotation = int(float(side["rotation"]))
    fmt = data.get("format") or {}
    duration = float(fmt.get("duration") or (video or {}).get("duration") or (audio or {}).get("duration") or 0)
    return ProbeInfo(
        duration_s=round(duration, 3),
        width=int(video["width"]) if video and video.get("width") else None,
        height=int(video["height"]) if video and video.get("height") else None,
        fps=_fps(video.get("avg_frame_rate") or video.get("r_frame_rate")) if video else None,
        video_codec=video.get("codec_name") if video else None,
        audio_codec=audio.get("codec_name") if audio else None,
        has_video=video is not None,
        has_audio=audio is not None,
        rotation=rotation,
        pix_fmt=video.get("pix_fmt") if video else None,
        format_name=fmt.get("format_name", ""),
        bit_rate=int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        raw=data,
    )


async def decode_errors(path: Path, *, max_seconds: float | None = None) -> list[str]:
    """Полное декодирование файла. Пустой список — файл читается без ошибок."""
    args = ["-v", "error", "-i", str(path)]
    if max_seconds:
        args += ["-t", str(max_seconds)]
    args += ["-f", "null", "-"]
    settings = get_settings()
    code, _, err = await run([settings.ffmpeg_bin, "-hide_banner", "-nostdin", *args], timeout_s=settings.render_timeout_s)
    lines = [ln.strip() for ln in err.splitlines() if ln.strip()]
    if code != 0 and not lines:
        lines = [f"ffmpeg завершился с кодом {code}"]
    return lines[:50]


@dataclass(slots=True)
class Interval:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(self.end - self.start, 0.0)


@dataclass(slots=True)
class FrameAnalysis:
    duration_s: float
    black: list[Interval] = field(default_factory=list)
    frozen: list[Interval] = field(default_factory=list)
    silence: list[Interval] = field(default_factory=list)
    scene_changes: list[float] = field(default_factory=list)

    def ratio(self, intervals: list[Interval]) -> float:
        if self.duration_s <= 0:
            return 0.0
        return min(sum(i.duration for i in intervals) / self.duration_s, 1.0)

    def overlaps(self, intervals: list[Interval], start: float, end: float) -> float:
        return sum(max(0.0, min(end, i.end) - max(start, i.start)) for i in intervals)

    def to_dict(self) -> dict[str, Any]:
        return {
            "duration_s": self.duration_s,
            "black": [[i.start, i.end] for i in self.black],
            "frozen": [[i.start, i.end] for i in self.frozen],
            "silence": [[i.start, i.end] for i in self.silence],
            "scene_changes": self.scene_changes,
            "black_ratio": round(self.ratio(self.black), 4),
            "frozen_ratio": round(self.ratio(self.frozen), 4),
            "silence_ratio": round(self.ratio(self.silence), 4),
        }


_BLACK = re.compile(r"black_start:([\d.]+)\s+black_end:([\d.]+)")
_FREEZE_START = re.compile(r"freezedetect\.freeze_start:\s*([\d.]+)")
_FREEZE_END = re.compile(r"freezedetect\.freeze_end:\s*([\d.]+)")
_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*([\d.]+)")
_PTS = re.compile(r"pts_time:([\d.]+)")


def _pair(starts: list[float], ends: list[float], duration: float) -> list[Interval]:
    out = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else duration
        out.append(Interval(round(max(s, 0), 3), round(e, 3)))
    return out


async def analyze(path: Path, info: ProbeInfo, *, scene_threshold: float = 0.35) -> FrameAnalysis:
    """Один проход FFmpeg: чёрные кадры, застывшие кадры, смены сцен, тишина."""
    vf = (
        "blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-60dB:d=1.5,"
        f"select='gt(scene\\,{scene_threshold})',showinfo"
    )
    args = ["-v", "info", "-i", str(path)]
    if info.has_video:
        args += ["-map", "0:v:0", "-vf", vf]
    if info.has_audio:
        args += ["-map", "0:a:0", "-af", "silencedetect=n=-35dB:d=1.0"]
    args += ["-f", "null", "-"]
    settings = get_settings()
    code, _, err = await run([settings.ffmpeg_bin, "-hide_banner", "-nostdin", *args], timeout_s=settings.render_timeout_s)
    if code != 0:
        raise FFmpegError("анализ кадров не выполнен", err)
    duration = info.duration_s
    black = [Interval(float(a), float(b)) for a, b in _BLACK.findall(err)]
    frozen = _pair([float(x) for x in _FREEZE_START.findall(err)], [float(x) for x in _FREEZE_END.findall(err)], duration)
    silence = _pair([float(x) for x in _SIL_START.findall(err)], [float(x) for x in _SIL_END.findall(err)], duration)
    scenes = sorted({round(float(x), 3) for x in _PTS.findall(err) if 0 < float(x) < duration})
    return FrameAnalysis(duration_s=duration, black=black, frozen=frozen, silence=silence, scene_changes=scenes)


async def loudness(path: Path) -> dict[str, float] | None:
    """Интегральная громкость (EBU R128) через loudnorm. None — в файле нет звука."""
    try:
        err = await ffmpeg("-i", str(path), "-map", "0:a:0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
                           "-f", "null", "-", timeout_s=600)
    except FFmpegError:
        return None
    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.DOTALL)
    if not match:
        return None
    data = json.loads(match.group(0))
    try:
        return {k: float(v) for k, v in data.items() if k.startswith("input_") or k == "target_offset"}
    except ValueError:
        return None


async def extract_frame(path: Path, at_s: float, dest: Path, *, width: int | None = None) -> Path:
    args = ["-ss", f"{max(at_s, 0):.3f}", "-i", str(path), "-frames:v", "1"]
    if width:
        args += ["-vf", f"scale={width}:-2"]
    args += ["-q:v", "2", str(dest)]
    await ffmpeg(*args, timeout_s=120)
    if not dest.exists() or dest.stat().st_size == 0:
        raise FFmpegError(f"кадр на {at_s:.1f} с не извлечён")
    return dest


async def extract_audio_for_asr(path: Path, dest: Path) -> Path:
    await ffmpeg("-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", str(dest), timeout_s=900)
    return dest
