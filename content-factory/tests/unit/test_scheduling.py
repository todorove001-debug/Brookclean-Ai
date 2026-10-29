from collections import Counter
from datetime import UTC, date, datetime, time, timedelta

from app.publishing.slots import allocate_formats, day_slots, is_allowed, next_free_slot
from app.settings.channel import ContentMix, PublishWindow, ScheduleConfig


def schedule(**kw):
    return ScheduleConfig(timezone="Europe/Moscow", windows=[PublishWindow(start=time(8), end=time(22))], **kw)


def test_day_slots_use_preferred_times_in_timezone():
    slots = day_slots(schedule(), date(2026, 11, 2), 5)
    local = [s.astimezone().astimezone(__import__("zoneinfo").ZoneInfo("Europe/Moscow")).strftime("%H:%M") for s in slots]
    assert local == ["09:00", "12:00", "15:00", "18:00", "20:30"]


def test_day_slots_extra_respect_gap_and_window():
    sched = schedule(min_gap_minutes=90)
    slots = day_slots(sched, date(2026, 11, 2), 7)
    assert len(slots) == 7
    assert all(is_allowed(sched, s) for s in slots)
    assert all(b - a >= timedelta(minutes=90) for a, b in zip(slots, slots[1:]))


def test_next_free_slot_skips_occupied_and_night():
    sched = schedule(min_gap_minutes=90)
    preferred = datetime(2026, 11, 2, 18, 0, tzinfo=UTC)  # 21:00 МСК
    occupied = [datetime(2026, 11, 2, 18, 30, tzinfo=UTC)]
    slot = next_free_slot(sched, occupied, preferred=preferred, not_before=preferred)
    assert slot is not None and is_allowed(sched, slot)
    assert all(abs(slot - o) >= timedelta(minutes=90) for o in occupied)
    assert slot.astimezone(__import__("zoneinfo").ZoneInfo("Europe/Moscow")).hour >= 8


def test_allocate_formats_shares_and_video_target():
    mix = ContentMix(shares={"short_post": 0.5, "video": 0.25, "poll": 0.25}, videos_per_month_min=30, videos_per_month_max=60)
    days = allocate_formats(mix, [5] * 30)
    counts = Counter(f for d in days for f in d)
    assert sum(counts.values()) == 150
    assert 30 <= counts["video"] <= 60
    for d in days:
        assert all(a != b for a, b in zip(d, d[1:])), d  # один формат не стоит подряд


def test_allocate_excludes_formats():
    mix = ContentMix(shares={"short_post": 0.5, "story": 0.5})
    days = allocate_formats(mix, [4], exclude={"story"})
    assert days == [["short_post"] * 4]
