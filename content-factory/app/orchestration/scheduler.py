"""Scheduler: периодические задачи. Несколько экземпляров не создают дублей: ключ периода уникален (once_key)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

from app.content.channel import get_channel
from app.database.session import session_scope, utcnow
from app.monitoring.logging import get_logger
from app.orchestration.queue import enqueue

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class Periodic:
    name: str
    task: str
    every_s: int | None = None
    daily_at: time | None = None  # местное время канала
    weekday: int | None = None  # 0 — понедельник; только вместе с daily_at
    priority: int = 0


SCHEDULE = [
    Periodic("publish-dispatch", "publish.dispatch", every_s=60, priority=10),
    Periodic("production-kick", "production.kick", every_s=1800),
    Periodic("video-watchdog", "video.watchdog", every_s=600),
    Periodic("maintenance", "maintenance", every_s=900),
    Periodic("plan-rolling", "plan.rolling", daily_at=time(6, 0)),
    Periodic("analytics-collect", "analytics.collect", daily_at=time(23, 30)),
    Periodic("analytics-weekly", "analytics.weekly", daily_at=time(10, 0), weekday=0),
]


def period_key(job: Periodic, now: datetime, tz: str) -> str | None:
    if job.every_s:
        return str(int(now.timestamp()) // job.every_s)
    assert job.daily_at is not None
    local = now.astimezone(ZoneInfo(tz))
    if job.weekday is not None and local.weekday() != job.weekday:
        return None
    if local.time() < job.daily_at:
        return None
    return local.date().isoformat()


async def tick(now: datetime | None = None) -> list[str]:
    now = now or utcnow()
    created: list[str] = []
    async with session_scope() as session:
        tz = (await get_channel(session)).settings.schedule.timezone
        for job in SCHEDULE:
            key = period_key(job, now, tz)
            if key is None:
                continue
            task_id = await enqueue(session, job.task, {}, once_key=f"periodic:{job.name}:{key}", dedup_key=f"periodic:{job.name}",
                                    priority=job.priority, max_attempts=3)
            if task_id:
                created.append(job.name)
    return created


async def run_forever(stop: asyncio.Event, interval_s: float = 20.0) -> None:
    log.info("scheduler.started", jobs=[j.name for j in SCHEDULE])
    while not stop.is_set():
        try:
            created = await tick()
            if created:
                log.info("scheduler.enqueued", jobs=created)
        except Exception as exc:  # noqa: BLE001
            log.error("scheduler.tick_failed", error=str(exc))
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval_s)
        except TimeoutError:
            pass
