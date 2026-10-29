from decimal import Decimal
from pathlib import Path

from app.budget.pricing import PricingTable
from app.video import subtitles as subs
from app.video.edl import EDL, CardSegment, SubtitleSegment

ROOT = Path(__file__).resolve().parents[2]


def test_normalize_splits_long_and_removes_overlap():
    segs = [SubtitleSegment(start=0, end=6, text="Машину закатывают на платформу автовоза и фиксируют каждое колесо отдельным ремнём, затем проверяют натяжение"),
            SubtitleSegment(start=5.5, end=8, text="Готово")]
    out = subs.normalize(segs, 10)
    assert len(out) >= 3
    assert all(a.end <= b.start for a, b in zip(out, out[1:]))
    assert all(len(line) <= subs.MAX_LINE for s in out for line in subs._wrap(s.text))


def test_check_reports_problems():
    issues = subs.check([SubtitleSegment(start=0, end=0.3, text="Очень длинный текст для такого короткого показа")], 5)
    problems = " ".join(i.problem for i in issues)
    assert "короткий" in problems and "скорость" in problems


def test_ass_has_events():
    ass = subs.build_ass([SubtitleSegment(start=1, end=2.5, text="Привет {мир}")], width=1080, height=1920, font_name="DejaVu Sans")
    assert "Dialogue: 0,0:00:01.00,0:00:02.50,Default" in ass and "{мир}" not in ass
    assert "PlayResY: 1920" in ass


def test_edl_requires_segments_and_computes_offsets():
    edl = EDL(segments=[CardSegment(headline="a", duration_s=2), CardSegment(headline="b", duration_s=3)])
    assert edl.duration == 5 and edl.segment_offsets() == [0, 2]
    restored = EDL.model_validate(edl.model_dump(mode="json"))
    assert restored == edl


def test_pricing():
    p = PricingTable.load(ROOT / "config" / "pricing.yaml")
    assert p.llm_cost("claude-opus-5-5", 1_000_000, 100_000) == Decimal("6.0000")
    assert p.video_cost("openai_sora", "sora-2", 8) == Decimal("0.8000")
    assert p.runway_credits_to_usd(120) == Decimal("1.2000")
    assert p.transcription_cost("whisper-1", 120) == Decimal("0.0120")
