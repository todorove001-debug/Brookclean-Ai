"""Расписание: слоты публикаций, разрешённые окна, распределение форматов по дням."""

from __future__ import annotations

import math
from collections import Counter
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.settings.channel import ContentMix, ScheduleConfig

UTC = ZoneInfo("UTC")


def target_posts_per_day(schedule: ScheduleConfig) -> int:
    return math.ceil((schedule.posts_per_day_min + schedule.posts_per_day_max) / 2)


def is_allowed(schedule: ScheduleConfig, when: datetime) -> bool:
    local = when.astimezone(ZoneInfo(schedule.timezone)).time()
    return any(w.start <= local <= w.end for w in schedule.windows)


def _local(day: date, t: time, tz: ZoneInfo) -> datetime:
    return datetime.combine(day, t, tzinfo=tz)


def day_slots(schedule: ScheduleConfig, day: date, count: int) -> list[datetime]:
    """Время публикаций на день (UTC). Сначала предпочтительные слоты, затем равномерно по окнам."""
    tz = ZoneInfo(schedule.timezone)
    gap = timedelta(minutes=schedule.min_gap_minutes)
    chosen: list[datetime] = []
    for t in sorted(schedule.slots):
        dt = _local(day, t, tz)
        if len(chosen) >= count:
            break
        if is_allowed(schedule, dt) and all(abs(dt - c) >= gap for c in chosen):
            chosen.append(dt)
    if len(chosen) < count:
        for window in schedule.windows:
            cursor = _local(day, window.start, tz)
            end = _local(day, window.end, tz)
            while cursor <= end and len(chosen) < count:
                if all(abs(cursor - c) >= gap for c in chosen):
                    chosen.append(cursor)
                cursor += timedelta(minutes=15)
    return sorted(c.astimezone(UTC) for c in chosen)


def next_free_slot(
    schedule: ScheduleConfig, occupied: list[datetime], *, preferred: datetime, not_before: datetime, horizon_days: int = 21
) -> datetime | None:
    """Ближайшее разрешённое время не раньше preferred/not_before с интервалом от занятых слотов."""
    gap = timedelta(minutes=schedule.min_gap_minutes)
    start = max(preferred, not_before)
    # Округление вверх до 5 минут.
    start = start.replace(second=0, microsecond=0) + timedelta(minutes=(-start.minute) % 5)
    cursor = start
    limit = start + timedelta(days=horizon_days)
    while cursor <= limit:
        if is_allowed(schedule, cursor) and all(abs(cursor - o) >= gap for o in occupied):
            return cursor
        cursor += timedelta(minutes=5)
    return None


def allocate_formats(mix: ContentMix, slots_per_day: list[int], *, days_in_month: int = 30,
                     exclude: set[str] | None = None, start_counts: Counter[str] | None = None) -> list[list[str]]:
    """Детерминированное распределение форматов по слотам: доли из настроек, видео — в пределах месячной цели.

    Возвращает форматы для каждого дня. Форматы одного типа не стоят подряд, если есть выбор.
    """
    shares = {k: v for k, v in mix.shares.items() if k not in (exclude or set())}
    total_slots = sum(slots_per_day)
    if not shares or total_slots == 0:
        return [[] for _ in slots_per_day]
    norm = sum(shares.values())
    shares = {k: v / norm for k, v in shares.items()}

    # Видео: пересчёт месячной цели на горизонт плана.
    days = len(slots_per_day)
    if "video" in shares:
        vmin = mix.videos_per_month_min * days / days_in_month
        vmax = mix.videos_per_month_max * days / days_in_month
        want = shares["video"] * total_slots
        clamped = min(max(want, vmin), vmax, total_slots)
        if want > 0:
            rest = 1 - shares["video"]
            new_video = clamped / total_slots
            shares = {k: (new_video if k == "video" else (v / rest * (1 - new_video) if rest > 0 else 0)) for k, v in shares.items()}

    # Метод наибольших остатков.
    raw = {k: v * total_slots for k, v in shares.items()}
    counts = {k: int(math.floor(v)) for k, v in raw.items()}
    remainder = total_slots - sum(counts.values())
    for k in sorted(raw, key=lambda k: (raw[k] - counts[k], k), reverse=True)[:remainder]:
        counts[k] += 1

    pool = Counter(counts)
    used = Counter(start_counts or {})
    result: list[list[str]] = []
    previous: str | None = None
    for n in slots_per_day:
        day: list[str] = []
        for _ in range(n):
            candidates = [f for f, c in pool.items() if c > 0]
            if not candidates:
                break
            # Больше всего оставшихся, не повторять предыдущий формат.
            candidates.sort(key=lambda f: (f == previous, f in day, -pool[f], used[f], f))
            pick = candidates[0]
            pool[pick] -= 1
            used[pick] += 1
            day.append(pick)
            previous = pick
        result.append(day)
    return result
