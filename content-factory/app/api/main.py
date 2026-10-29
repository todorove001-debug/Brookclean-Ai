"""Admin API и веб-панель."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import admin, content, media, ops, system
from app.monitoring.logging import configure_logging, get_logger
from app.monitoring.sentry import init_sentry
from app.orchestration.services import Services
from app.settings.config import get_settings

log = get_logger(__name__)
STATIC = Path(__file__).parent / "static"


def create_app(services: Services | None = None) -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        from app.approval.bot import ApprovalBot, ensure_bootstrap_users
        from app.workers.runtime import load_services

        configure_logging(settings.log_level, settings.log_json)
        init_sentry(settings, "api")
        app.state.services = services or await load_services()
        await ensure_bootstrap_users(app.state.services)
        app.state.bot = ApprovalBot(app.state.services) if app.state.services.telegram else None
        if app.state.bot and settings.telegram_mode == "webhook":
            secret = settings.secret("telegram_webhook_secret")
            if secret:
                from app.approval.bot import ALLOWED_UPDATES

                await app.state.services.telegram.set_webhook(
                    f"{settings.public_base_url.rstrip('/')}/telegram/webhook", secret, ALLOWED_UPDATES
                )
            else:
                log.error("telegram.webhook_secret_missing")
        yield

    app = FastAPI(
        title="Brookclean Content Factory",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):  # noqa: ANN001, ANN202
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith("/admin"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'"
            )
        return response

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("api.unhandled", path=request.url.path, error=str(exc))
        return JSONResponse({"detail": "внутренняя ошибка; подробности в журнале"}, status_code=500)

    for module in (system, admin, content, media, ops):
        app.include_router(module.router)
    app.mount("/admin", StaticFiles(directory=STATIC, html=True), name="admin")

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse("/admin/")

    return app


app = create_app()
