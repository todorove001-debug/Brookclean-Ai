from __future__ import annotations

from typing import Any

from app.security.redaction import redact
from app.settings.config import Settings


def _before_send(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    return redact(event)


def init_sentry(settings: Settings, component: str) -> None:
    dsn = settings.secret("sentry_dsn")
    if not dsn:
        return
    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        environment=settings.environment,
        send_default_pii=False,
        traces_sample_rate=0.0,
        before_send=_before_send,
        server_name=component,
    )
