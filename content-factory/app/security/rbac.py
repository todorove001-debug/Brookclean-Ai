"""Роли, права и API-токены."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from enum import StrEnum

from app.database.enums import UserRole


class Permission(StrEnum):
    content_read = "content.read"
    content_write = "content.write"
    content_approve = "content.approve"
    publishing_control = "publishing.control"
    media_write = "media.write"
    budget_read = "budget.read"
    budget_write = "budget.write"
    config_write = "config.write"
    users_manage = "users.manage"
    audit_read = "audit.read"
    monitoring_read = "monitoring.read"


ROLE_PERMISSIONS: dict[UserRole, frozenset[Permission]] = {
    UserRole.owner: frozenset(Permission),
    UserRole.admin: frozenset(
        {
            Permission.content_read,
            Permission.content_write,
            Permission.content_approve,
            Permission.publishing_control,
            Permission.media_write,
            Permission.budget_read,
            Permission.audit_read,
            Permission.monitoring_read,
        }
    ),
    UserRole.editor: frozenset(
        {
            Permission.content_read,
            Permission.content_write,
            Permission.media_write,
            Permission.monitoring_read,
        }
    ),
    UserRole.viewer: frozenset({Permission.content_read}),
}


def has_permission(role: UserRole | str, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS.get(UserRole(role), frozenset())


TOKEN_PREFIX = "cf_"  # noqa: S105 — префикс, не секрет


def new_api_token() -> tuple[str, str, str]:
    """Возвращает (токен, sha256, видимый префикс). В базе хранится только хеш."""
    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    return token, hash_token(token), token[:10]


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
