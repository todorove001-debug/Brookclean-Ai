"""Публичные служебные маршруты: здоровье, метрики, отслеживаемые ссылки, вебхук Telegram."""

from __future__ import annotations

import shutil
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text

from app.analytics.links import register_click
from app.api.deps import ServicesDep, SessionDep
from app.security.rbac import constant_time_equals

router = APIRouter()


@router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
async def ready(session: SessionDep, services: ServicesDep, response: Response) -> dict[str, Any]:
    checks: dict[str, str] = {}
    try:
        await session.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["database"] = f"error: {type(exc).__name__}"
    try:
        await services.storage.check()
        checks["storage"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["storage"] = f"error: {type(exc).__name__}"
    checks["ffmpeg"] = "ok" if shutil.which(services.settings.ffmpeg_bin) else "missing"
    checks["llm"] = "configured" if services.llm else "not configured"
    checks["telegram"] = "configured" if services.telegram else "not configured"
    checks["video_generator"] = services.video.name if services.video else "not configured"
    ok = all(v == "ok" for k, v in checks.items() if k in {"database", "storage", "ffmpeg"})
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ok" if ok else "degraded", "checks": checks}


@router.get("/metrics")
async def metrics(services: ServicesDep, authorization: Annotated[str | None, Header()] = None) -> Response:
    token = services.settings.secret("metrics_token")
    if token and not (
        authorization and constant_time_equals(authorization.removeprefix("Bearer ").strip(), token)
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "нужен токен метрик")
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@router.get("/r/{code}", include_in_schema=False)
async def tracked_redirect(code: str, session: SessionDep) -> RedirectResponse:
    if not code.isalnum() or len(code) > 16:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    target = await register_click(session, code)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    return RedirectResponse(
        target,
        status_code=status.HTTP_302_FOUND,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )


@router.post("/telegram/webhook", include_in_schema=False)
async def telegram_webhook(
    request: Request,
    services: ServicesDep,
    background: BackgroundTasks,
    x_telegram_bot_api_secret_token: Annotated[str | None, Header()] = None,
) -> dict[str, bool]:
    secret = services.settings.secret("telegram_webhook_secret")
    if (
        not secret
        or not x_telegram_bot_api_secret_token
        or not constant_time_equals(x_telegram_bot_api_secret_token, secret)
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN)
    update = await request.json()
    bot = request.app.state.bot
    if bot is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "бот не настроен")
    # Ответ Telegram даётся сразу, обработка — после: вебхук не ждёт рендера и модели.
    background.add_task(bot.handle_update, update)
    return {"ok": True}
