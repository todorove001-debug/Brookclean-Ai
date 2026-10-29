"""Исполнитель фоновых задач: python -m app.workers.worker"""

from __future__ import annotations

import asyncio

from app.orchestration.handlers import HANDLERS
from app.orchestration.queue import Worker
from app.orchestration.services import Services
from app.settings.config import get_settings
from app.workers.runtime import run


async def main(services: Services, stop: asyncio.Event) -> None:
    settings = get_settings()
    workers = [
        Worker(HANDLERS, services, lease_s=settings.worker_lease_s)
        for _ in range(settings.worker_concurrency)
    ]
    await asyncio.gather(*(w.run_forever(stop) for w in workers))


if __name__ == "__main__":
    run("worker", main)
