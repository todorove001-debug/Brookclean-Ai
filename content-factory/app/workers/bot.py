"""Бот согласования в режиме long polling: python -m app.workers.bot
В режиме вебхука (TELEGRAM_MODE=webhook) обновления принимает API, этот процесс не нужен."""

from __future__ import annotations

import asyncio

from app.approval.bot import ApprovalBot, ensure_bootstrap_users
from app.monitoring.logging import get_logger
from app.orchestration.services import Services
from app.settings.config import get_settings
from app.workers.runtime import run

log = get_logger(__name__)


async def main(services: Services, stop: asyncio.Event) -> None:
    await ensure_bootstrap_users(services)
    if get_settings().telegram_mode != "polling":
        log.info("bot.webhook_mode", note="обновления принимает API /telegram/webhook")
        await stop.wait()
        return
    await ApprovalBot(services).poll_forever(stop)


if __name__ == "__main__":
    run("bot", main)
