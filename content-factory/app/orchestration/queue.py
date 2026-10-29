"""Очередь фоновых задач на PostgreSQL (SELECT … FOR UPDATE SKIP LOCKED).

Почему не Redis/Celery: нагрузка — десятки задач в час, а главное требование — согласованность.
Задача ставится в той же транзакции, что и изменение данных, поэтому не бывает «статус сменился,
а задача потерялась» или наоборот. Повторная доставка безопасна: обработчики идемпотентны,
публикация дополнительно защищена уникальными ключами в publishing_jobs.
"""

from __future__ import annotations

import asyncio
import os
import socket
import time
import traceback
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.enums import TaskStatus
from app.database.models import Task
from app.database.session import session_scope, utcnow
from app.monitoring.logging import get_logger
from app.monitoring.metrics import TASK_SECONDS, TASKS_TOTAL
from app.providers.base import ProviderNotConfigured
from app.security.redaction import redact_text

log = get_logger(__name__)


class Reschedule(Exception):  # noqa: N818 — это сигнал, а не ошибка
    """Повторить задачу позже без расхода попытки (ожидание внешнего сервиса, бюджета и т. п.)."""

    def __init__(self, delay_s: float, reason: str = "") -> None:
        super().__init__(reason)
        self.delay_s = delay_s
        self.reason = reason


class PermanentError(Exception):
    """Ошибка, которую бессмысленно повторять."""


@dataclass
class TaskContext:
    task_id: uuid.UUID
    name: str
    attempt: int
    max_attempts: int
    services: Any
    _heartbeat: Callable[[], Awaitable[None]] = field(repr=False, default=None)  # type: ignore[assignment]

    async def heartbeat(self) -> None:
        if self._heartbeat:
            await self._heartbeat()


Handler = Callable[[TaskContext, dict[str, Any]], Awaitable[None]]


async def enqueue(
    session: AsyncSession,
    name: str,
    payload: dict[str, Any] | None = None,
    *,
    run_at: datetime | None = None,
    delay_s: float | None = None,
    dedup_key: str | None = None,
    once_key: str | None = None,
    priority: int = 0,
    max_attempts: int = 5,
) -> uuid.UUID | None:
    """Ставит задачу. Возвращает None, если такая задача уже стоит (dedup_key) или уже была (once_key)."""
    when = run_at or utcnow()
    if delay_s:
        when = when + timedelta(seconds=delay_s)
    stmt = (
        insert(Task)
        .values(
            name=name,
            payload=payload or {},
            run_at=when,
            dedup_key=dedup_key,
            once_key=once_key,
            priority=priority,
            max_attempts=max_attempts,
            status=TaskStatus.queued,
            attempts=0,
        )
        .on_conflict_do_nothing()
        .returning(Task.id)
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


_REAP_SQL = text(
    """
    UPDATE tasks SET status = 'failed', finished_at = now(), locked_by = NULL,
           last_error = coalesce(last_error, '') || ' | lease expired after last attempt'
    WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts
    RETURNING id, name
    """
)

_CLAIM_SQL = text(
    """
    UPDATE tasks SET status = 'running', attempts = attempts + 1, locked_by = :worker,
           locked_until = now() + make_interval(secs => :lease), updated_at = now()
    WHERE id = (
        SELECT t.id FROM tasks t
        WHERE ((t.status = 'queued' AND t.run_at <= now())
               OR (t.status = 'running' AND t.locked_until < now()))
          -- задачи с одним dedup_key не выполняются параллельно
          AND (t.dedup_key IS NULL OR NOT EXISTS (
                SELECT 1 FROM tasks r
                WHERE r.dedup_key = t.dedup_key AND r.status = 'running' AND r.id <> t.id AND r.locked_until >= now()))
        ORDER BY t.priority DESC, t.run_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id, name, payload, attempts, max_attempts
    """
)


def backoff_seconds(attempt: int) -> float:
    return float(min(30 * 2 ** max(attempt - 1, 0), 3600))


class Worker:
    def __init__(
        self, handlers: dict[str, Handler], services: Any, *, lease_s: int = 300, worker_id: str | None = None
    ):
        self.handlers = handlers
        self.services = services
        self.lease_s = lease_s
        self.worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"

    async def run_once(self) -> bool:
        """Берёт и выполняет одну задачу. Возвращает False, если очередь пуста."""
        async with session_scope() as session:
            reaped = (await session.execute(_REAP_SQL)).all()
            for row in reaped:
                log.error("task.lease_expired", task_id=str(row.id), name=row.name)
                await self._on_dead(session, row.id, row.name, "задача зависла и исчерпала попытки")
            row = (
                await session.execute(_CLAIM_SQL, {"worker": self.worker_id, "lease": self.lease_s})
            ).first()
        if row is None:
            return False

        task_id: uuid.UUID = row.id
        handler = self.handlers.get(row.name)
        started = time.monotonic()

        async def heartbeat() -> None:
            async with session_scope() as s:
                await s.execute(
                    text(
                        "UPDATE tasks SET locked_until = now() + make_interval(secs => :lease) WHERE id = :id AND locked_by = :w"
                    ),
                    {"lease": self.lease_s, "id": task_id, "w": self.worker_id},
                )

        ctx = TaskContext(task_id, row.name, row.attempts, row.max_attempts, self.services, heartbeat)
        bound = log.bind(task_id=str(task_id), task=row.name, attempt=row.attempts)
        try:
            if handler is None:
                raise PermanentError(f"нет обработчика для задачи {row.name}")
            await self._run_with_heartbeat(handler, ctx, row.payload or {})
        except Reschedule as exc:
            await self._finish(
                task_id,
                status=TaskStatus.queued,
                delay_s=exc.delay_s,
                error=exc.reason or None,
                refund_attempt=True,
            )
            TASKS_TOTAL.labels(row.name, "rescheduled").inc()
            bound.info("task.rescheduled", delay_s=exc.delay_s, reason=exc.reason)
        except Exception as exc:  # noqa: BLE001 — любая ошибка обработчика фиксируется в задаче
            error = redact_text(f"{type(exc).__name__}: {exc}\n{traceback.format_exc(limit=8)}")[-4000:]
            # Ненастроенный сервис повтор не исправит — нужна правка конфигурации.
            permanent = (
                isinstance(exc, PermanentError | ProviderNotConfigured) or row.attempts >= row.max_attempts
            )
            if permanent:
                await self._finish(task_id, status=TaskStatus.failed, error=error)
                async with session_scope() as session:
                    await self._on_dead(session, task_id, row.name, f"{type(exc).__name__}: {exc}")
                TASKS_TOTAL.labels(row.name, "failed").inc()
                bound.error("task.failed", error=str(exc))
            else:
                delay = backoff_seconds(row.attempts)
                await self._finish(task_id, status=TaskStatus.queued, delay_s=delay, error=error)
                TASKS_TOTAL.labels(row.name, "retry").inc()
                bound.warning("task.retry", error=str(exc), delay_s=delay)
        else:
            await self._finish(task_id, status=TaskStatus.succeeded)
            TASKS_TOTAL.labels(row.name, "ok").inc()
            bound.info("task.done", seconds=round(time.monotonic() - started, 2))
        finally:
            TASK_SECONDS.labels(row.name).observe(time.monotonic() - started)
        return True

    async def _run_with_heartbeat(self, handler: Handler, ctx: TaskContext, payload: dict[str, Any]) -> None:
        async def beat() -> None:
            while True:
                await asyncio.sleep(max(self.lease_s / 3, 5))
                try:
                    await ctx.heartbeat()
                except Exception as exc:  # noqa: BLE001
                    log.warning("task.heartbeat_failed", error=str(exc))

        beater = asyncio.create_task(beat())
        try:
            await handler(ctx, payload)
        finally:
            beater.cancel()

    async def _finish(
        self,
        task_id: uuid.UUID,
        *,
        status: TaskStatus,
        delay_s: float | None = None,
        error: str | None = None,
        refund_attempt: bool = False,
    ) -> None:
        async with session_scope() as session:
            task = await session.get(Task, task_id, with_for_update=True)
            if task is None or task.locked_by != self.worker_id:
                # Аренду перехватил другой процесс — его результат главнее.
                return
            task.status = status
            task.locked_by = None
            task.locked_until = None
            if error is not None:
                task.last_error = error
            if refund_attempt:
                task.attempts = max(task.attempts - 1, 0)
            if status == TaskStatus.queued:
                task.run_at = utcnow() + timedelta(seconds=delay_s or 0)
            else:
                task.finished_at = utcnow()

    async def _on_dead(self, session: AsyncSession, task_id: uuid.UUID, name: str, reason: str) -> None:
        from app.monitoring.alerts import notify_owner

        await notify_owner(
            session,
            key=f"task-dead:{task_id}",
            kind="error",
            text=f"Фоновая задача «{name}» остановлена после всех попыток: {redact_text(reason)[:500]}",
        )

    async def run_forever(self, stop: asyncio.Event, *, idle_sleep_s: float = 2.0) -> None:
        log.info("worker.started", worker_id=self.worker_id, handlers=sorted(self.handlers))
        while not stop.is_set():
            try:
                worked = await self.run_once()
            except Exception as exc:  # noqa: BLE001 — база недоступна и т. п.; процесс не падает
                log.error("worker.loop_error", error=str(exc))
                worked = False
                await asyncio.sleep(5)
            if not worked:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=idle_sleep_s)
                except TimeoutError:
                    pass
        log.info("worker.stopped", worker_id=self.worker_id)
