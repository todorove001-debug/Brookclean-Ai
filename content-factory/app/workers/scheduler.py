"""Планировщик периодических задач: python -m app.workers.scheduler"""

from __future__ import annotations

import asyncio

from app.orchestration import scheduler
from app.orchestration.services import Services
from app.workers.runtime import run


async def main(services: Services, stop: asyncio.Event) -> None:
    await scheduler.run_forever(stop)


if __name__ == "__main__":
    run("scheduler", main)
