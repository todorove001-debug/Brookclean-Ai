"""Помощники интеграционных тестов."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select, update

from app.content.channel import get_channel
from app.database.enums import ContentStatus, UserRole
from app.database.models import CompanyFact, ContentItem, Task, User
from app.database.session import session_scope, utcnow
from app.orchestration.handlers import HANDLERS
from app.orchestration.queue import Worker, enqueue

OWNER_TG = 111
ADMIN_TG = 222


async def make_users() -> dict[str, User]:
    async with session_scope() as s:
        owner = User(display_name="Владелец", role=UserRole.owner, telegram_user_id=OWNER_TG)
        admin = User(display_name="Админ", role=UserRole.admin, telegram_user_id=ADMIN_TG)
        editor = User(display_name="Редактор", role=UserRole.editor, telegram_user_id=333)
        s.add_all([owner, admin, editor])
    return {"owner": owner, "admin": admin, "editor": editor}


async def approve_all_facts() -> None:
    async with session_scope() as s:
        await get_channel(s)
        await s.execute(update(CompanyFact).values(approved_at=utcnow()))


async def make_item(fmt: str = "short_post", **kw: Any) -> uuid.UUID:
    async with session_scope() as s:
        channel = await get_channel(s)
        item = ContentItem(channel_id=channel.id, status=ContentStatus.idea, format=fmt,
                           topic=kw.pop("topic", "Как подготовить автомобиль к перевозке автовозом"), rubric=kw.pop("rubric", "preparation"),
                           goal="Полезный совет", audience="Покупатели авто из Владивостока", thesis="Подготовка экономит время на приёмке",
                           cta="Задайте вопрос менеджеру", cta_target=kw.pop("cta_target", "manager"),
                           planned_at=utcnow() + timedelta(days=1), **kw)
        s.add(item)
        await s.flush()
        await enqueue(s, "pipeline.advance", {"item_id": str(item.id)}, dedup_key=f"advance:{item.id}")
        return item.id


async def run_worker(services, *, max_steps: int = 300) -> int:  # noqa: ANN001
    worker = Worker(HANDLERS, services)
    steps = 0
    while steps < max_steps and await worker.run_once():
        steps += 1
    return steps


async def item(item_id: uuid.UUID) -> ContentItem:
    async with session_scope() as s:
        return await s.get(ContentItem, item_id)


async def user(tg: int) -> User:
    async with session_scope() as s:
        return (await s.execute(select(User).where(User.telegram_user_id == tg))).scalar_one()


async def failed_tasks() -> list[Task]:
    async with session_scope() as s:
        return list((await s.execute(select(Task).where(Task.status == "failed"))).scalars())


def copy_handler(title: str = "Пять шагов подготовки машины к автовозу", body: str | None = None, **extra: Any):  # noqa: ANN201
    def handler(prompt: str) -> dict[str, Any]:
        return {
            "title": title,
            "body_html": body if body is not None else (
                "Перед погрузкой на автовоз сфотографируйте кузов со всех сторон и при дневном свете. "
                "Снимки пригодятся при приёмке автомобиля.\n\nОставьте немного топлива, снимите видеорегистратор "
                "и уберите личные вещи из салона. Проверьте давление в шинах: так машину проще закатить на платформу."
            ),
            "cta_text": "Задать вопрос менеджеру",
            "hashtags": ["автовоз"],
            **extra,
        }

    return handler


def clean_review(prompt: str) -> dict[str, Any]:
    return {"issues": []}
