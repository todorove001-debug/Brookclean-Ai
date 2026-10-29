"""Субтитры: нормализация сегментов, проверка качества, генерация ASS для libass."""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.video.edl import SubtitleSegment

MAX_LINE = 42
MAX_LINES = 2
MIN_DURATION = 0.8
MAX_DURATION = 6.0
MAX_CPS = 20.0


def _wrap(text: str, width: int = MAX_LINE) -> list[str]:
    words = text.split()
    lines: list[str] = []
    line = ""
    for word in words:
        if not line:
            line = word
        elif len(line) + 1 + len(word) <= width:
            line = f"{line} {word}"
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def split_text_by_time(text: str, start: float, end: float) -> list[SubtitleSegment]:
    """Длинную фразу делит на блоки по 2 строки, время — пропорционально длине."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    lines = _wrap(text)
    chunks = [" ".join(lines[i : i + MAX_LINES]) for i in range(0, len(lines), MAX_LINES)]
    total = sum(len(c) for c in chunks)
    segments, t = [], start
    for chunk in chunks:
        dur = (end - start) * len(chunk) / total
        segments.append(SubtitleSegment(start=round(t, 3), end=round(t + dur, 3), text=chunk))
        t += dur
    return segments


def normalize(segments: list[SubtitleSegment], timeline_end: float) -> list[SubtitleSegment]:
    out: list[SubtitleSegment] = []
    for seg in sorted(segments, key=lambda s: s.start):
        start, end = max(seg.start, 0), min(seg.end, timeline_end)
        if end - start <= 0.05 or not seg.text.strip():
            continue
        out.extend(split_text_by_time(seg.text, start, end))
    # Без наложений: конец предыдущего не позже начала следующего.
    for prev, cur in zip(out, out[1:], strict=False):
        if prev.end > cur.start:
            prev.end = round(cur.start - 0.02, 3)
    return [s for s in out if s.end - s.start > 0.05]


@dataclass(slots=True)
class SubtitleIssue:
    index: int
    problem: str


def check(segments: list[SubtitleSegment], timeline_end: float) -> list[SubtitleIssue]:
    issues: list[SubtitleIssue] = []
    for i, seg in enumerate(segments):
        dur = seg.end - seg.start
        lines = _wrap(seg.text)
        if not seg.text.strip():
            issues.append(SubtitleIssue(i, "пустой субтитр"))
        if dur < MIN_DURATION:
            issues.append(SubtitleIssue(i, f"слишком короткий показ {dur:.2f} с"))
        if dur > MAX_DURATION + 0.01:
            issues.append(SubtitleIssue(i, f"слишком долгий показ {dur:.1f} с"))
        if len(lines) > MAX_LINES:
            issues.append(SubtitleIssue(i, f"{len(lines)} строки — больше {MAX_LINES}"))
        if dur > 0 and len(seg.text) / dur > MAX_CPS:
            issues.append(
                SubtitleIssue(i, f"скорость чтения {len(seg.text) / dur:.0f} симв/с — больше {MAX_CPS:.0f}")
            )
        if seg.end > timeline_end + 0.05:
            issues.append(SubtitleIssue(i, "выходит за конец ролика"))
        if i and seg.start < segments[i - 1].end - 0.01:
            issues.append(SubtitleIssue(i, "наложение на предыдущий субтитр"))
    return issues


def _ass_time(t: float) -> str:
    cs = int(round(t * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    r, g, b = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def build_ass(
    segments: list[SubtitleSegment],
    *,
    width: int,
    height: int,
    font_name: str,
    primary: str = "#FFFFFF",
    outline: str = "#000000",
    box: str = "#0E1B2E",
) -> str:
    font_size = int(height * (0.034 if height > width else 0.05))
    margin_v = int(height * (0.16 if height > width else 0.08))
    header = (
        "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n"
        f"PlayResX: {width}\nPlayResY: {height}\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
        "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_name},{font_size},{_ass_color(primary)},{_ass_color(primary)},{_ass_color(outline)},"
        f"{_ass_color(box, 0x60)},1,0,0,0,100,100,0,0,1,{max(2, font_size // 14)},0,2,"
        f"{int(width * 0.07)},{int(width * 0.07)},{margin_v},204\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = [
        f"Dialogue: 0,{_ass_time(s.start)},{_ass_time(s.end)},Default,,0,0,0,,{_escape(chr(10).join(_wrap(s.text)))}"
        for s in segments
    ]
    return header + "\n".join(events) + "\n"


def to_srt(segments: list[SubtitleSegment]) -> str:
    def ts(t: float) -> str:
        ms = int(round(t * 1000))
        h, rem = divmod(ms, 3600000)
        m, rem = divmod(rem, 60000)
        s, ms = divmod(rem, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    return "\n".join(f"{i}\n{ts(s.start)} --> {ts(s.end)}\n{s.text}\n" for i, s in enumerate(segments, 1))
