"""Общий запуск фоновых процессов: логирование, Sentry, сервисы, корректная остановка по SIGTERM."""

from __future__ import annotations

import asyncio
import signal
from collections.abc import Awaitable, Callable

from app.content.channel import get_channel
from app.database.session import dispose_engine, session_scope
from app.monitoring.logging import configure_logging
from app.monitoring.sentry import init_sentry
from app.orchestration.services import Services, build_services
from app.settings.config import get_settings


async def load_services() -> Services:
    settings = get_settings()
    async with session_scope() as session:
        channel = await get_channel(session)
        feeds = channel.settings.rss_feeds
    return build_services(settings, rss_feeds=feeds)


def run(component: str, main: Callable[[Services, asyncio.Event], Awaitable[None]]) -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    init_sentry(settings, component)

    async def runner() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
        services = await load_services()
        try:
            await main(services, stop)
        finally:
            if services.telegram is not None:
                await services.telegram.aclose()
            await dispose_engine()

    asyncio.run(runner())
