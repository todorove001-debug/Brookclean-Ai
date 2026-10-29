"""Удаление секретов из логов, ошибок и отчётов."""

from __future__ import annotations

import re
from typing import Any

SENSITIVE_KEYS = re.compile(
    r"(token|secret|password|passwd|api[_-]?key|authorization|cookie|dsn|access[_-]?key|private)", re.IGNORECASE
)
PATTERNS = [
    # Токен Telegram-бота: 123456789:AA...
    (re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b"), "[telegram-token]"),
    (re.compile(r"/bot\d{6,12}:[A-Za-z0-9_-]{30,}"), "/bot[telegram-token]"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}"), "[anthropic-key]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"), "[api-key]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer [redacted]"),
    (re.compile(r"(?i)(X-Amz-Signature|X-Amz-Credential|Signature|AWSAccessKeyId)=[^&\s]+"), r"\1=[redacted]"),
    (re.compile(r"(?i)(postgres(?:ql)?(?:\+\w+)?://[^:\s/]+:)[^@\s]+@"), r"\1[redacted]@"),
]


def redact_text(text: str) -> str:
    for pattern, replacement in PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def redact(value: Any, *, _depth: int = 0) -> Any:
    if _depth > 8:
        return "[...]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {
            k: ("[redacted]" if isinstance(k, str) and SENSITIVE_KEYS.search(k) else redact(v, _depth=_depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, list | tuple):
        return [redact(v, _depth=_depth + 1) for v in value]
    return value
