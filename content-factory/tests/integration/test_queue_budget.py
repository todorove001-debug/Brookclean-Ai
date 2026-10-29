import asyncio
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select, text, update

from app.budget.service import BudgetExceeded, current_spend, paid_call, reserve, settle_stale_reservations
from app.database.enums import TaskStatus, UsageStatus
from app.database.models import Notification, ProviderUsage, Task
from app.database.session import session_scope, utcnow
from app.orchestration.queue import PermanentError, Reschedule, Worker, enqueue

pytestmark = pytest.mark.usefixtures("db")


async def _tasks():
    async with session_scope() as s:
        return list((await s.execute(select(Task).order_by(Task.created_at))).scalars())


class TestQueue:
    async def test_dedup_and_once_keys(self):
        async with session_scope() as s:
            assert await enqueue(s, "x", {"a": 1}, dedup_key="k")
            assert await enqueue(s, "x", {"a": 2}, dedup_key="k") is None
            assert await enqueue(s, "y", once_key="day1")
            assert await enqueue(s, "y", once_key="day1") is None
        assert len(await _tasks()) == 2

    async def test_success_retry_and_failure(self, services):
        calls = []

        async def ok(ctx, payload):
            calls.append(("ok", ctx.attempt))

        async def flaky(ctx, payload):
            calls.append(("flaky", ctx.attempt))
            raise RuntimeError("временная ошибка")

        async def permanent(ctx, payload):
            raise PermanentError("так нельзя")

        async def noop(ctx, payload):
            return None

        worker = Worker({"ok": ok, "flaky": flaky, "perm": permanent, "notify.send": noop}, services)
        async with session_scope() as s:
            await enqueue(s, "ok")
            await enqueue(s, "flaky", max_attempts=2)
            await enqueue(s, "perm")
        while await worker.run_once():
            pass
        tasks = {t.name: t for t in await _tasks() if t.name != "notify.send"}
        assert tasks["ok"].status == TaskStatus.succeeded
        assert tasks["flaky"].status == TaskStatus.queued and tasks["flaky"].attempts == 1
        assert tasks["flaky"].run_at > utcnow() + timedelta(seconds=20)  # экспоненциальная пауза
        assert tasks["perm"].status == TaskStatus.failed
        # Повтор flaky «сейчас»: вторая попытка последняя.
        async with session_scope() as s:
            await s.execute(update(Task).where(Task.name == "flaky").values(run_at=utcnow()))
        while await worker.run_once():
            pass
        tasks = {t.name: t for t in await _tasks()}
        assert tasks["flaky"].status == TaskStatus.failed
        async with session_scope() as s:
            notes = (await s.execute(select(Notification))).scalars().all()
        assert len(notes) == 2 and all("остановлена" in n.text for n in notes)

    async def test_reschedule_does_not_consume_attempts(self, services):
        async def waiting(ctx, payload):
            raise Reschedule(60, "ждём")

        worker = Worker({"w": waiting}, services)
        async with session_scope() as s:
            await enqueue(s, "w", max_attempts=1)
        await worker.run_once()
        task = (await _tasks())[0]
        assert task.status == TaskStatus.queued and task.attempts == 0 and task.last_error == "ждём"

    async def test_expired_lease_is_reclaimed(self, services):
        seen = []

        async def handler(ctx, payload):
            seen.append(ctx.attempt)

        async with session_scope() as s:
            await enqueue(s, "h", max_attempts=3)
            # Имитация упавшего процесса: задача «выполняется», аренда истекла.
            await s.execute(text("UPDATE tasks SET status='running', attempts=1, locked_by='dead', locked_until=now() - interval '1 minute'"))
        await Worker({"h": handler}, services).run_once()
        assert seen == [2]
        assert (await _tasks())[0].status == TaskStatus.succeeded

    async def test_parallel_workers_do_not_double_process(self, services):
        processed = []

        async def handler(ctx, payload):
            processed.append(payload["n"])
            await asyncio.sleep(0.05)

        async with session_scope() as s:
            for n in range(10):
                await enqueue(s, "h", {"n": n})
        workers = [Worker({"h": handler}, services) for _ in range(4)]

        async def drain(w):
            while await w.run_once():
                pass

        await asyncio.gather(*(drain(w) for w in workers))
        assert sorted(processed) == list(range(10))


class TestBudget:
    async def test_reserve_commit_release(self):
        async with paid_call(provider="p", operation="op", estimated_usd=Decimal("1.5")) as call:
            call.set_actual(Decimal("1.2"), source="tokens")
        with pytest.raises(RuntimeError):
            async with paid_call(provider="p", operation="op", estimated_usd=Decimal("1")):
                raise RuntimeError("сбой поставщика")
        async with session_scope() as s:
            rows = (await s.execute(select(ProviderUsage).order_by(ProviderUsage.created_at))).scalars().all()
            spend = await current_spend(s, "Europe/Moscow")
        assert [r.status for r in rows] == [UsageStatus.committed, UsageStatus.released]
        assert rows[0].actual_cost_usd == Decimal("1.2") and spend.day_usd == Decimal("1.2")

    async def test_task_and_daily_limits_stop_and_notify(self):
        with pytest.raises(BudgetExceeded):
            async with paid_call(provider="p", operation="op", estimated_usd=Decimal("4")):  # max_task_cost_usd = 3
                pass
        for _ in range(3):
            async with paid_call(provider="p", operation="op", estimated_usd=Decimal("3")):
                pass
        with pytest.raises(BudgetExceeded) as exc:
            async with paid_call(provider="p", operation="op", estimated_usd=Decimal("2")):  # дневной лимит 10
                pass
        assert exc.value.period == "day"
        async with session_scope() as s:
            keys = [n.key for n in (await s.execute(select(Notification))).scalars()]
        assert any(k.startswith("budget-stop:day") for k in keys)
        assert any(k.startswith("budget-warn:day") for k in keys)

    async def test_concurrent_reservations_respect_limit(self):
        async def one():
            try:
                async with session_scope() as s:
                    await reserve(s, provider="p", operation="op", estimated_usd=Decimal("3"))
                return True
            except BudgetExceeded:
                return False

        results = await asyncio.gather(*(one() for _ in range(8)))
        assert sum(results) == 3  # 3 × $3 ≤ $10; четвёртая превысила бы лимит

    async def test_video_generation_limit(self):
        from app.content.channel import get_channel
        from app.database.enums import VideoJobKind
        from app.database.models import ContentItem, VideoJob

        async with session_scope() as s:
            channel = await get_channel(s)
            item = ContentItem(channel_id=channel.id, format="video", topic="t")
            s.add(item)
            await s.flush()
            for i in range(10):
                s.add(VideoJob(item_id=item.id, kind=VideoJobKind.ai_scene, provider="p", provider_job_id=f"j{i}"))
        with pytest.raises(BudgetExceeded) as exc:
            async with session_scope() as s:
                await reserve(s, provider="p", operation="video", estimated_usd=Decimal("0.1"), is_video_generation=True)
        assert exc.value.period == "video"

    async def test_stale_reservations_are_charged(self):
        async with session_scope() as s:
            usage = await reserve(s, provider="p", operation="op", estimated_usd=Decimal("2"))
            await s.flush()
            await s.execute(update(ProviderUsage).where(ProviderUsage.id == usage.id).values(created_at=utcnow() - timedelta(hours=7)))
        async with session_scope() as s:
            assert await settle_stale_reservations(s) == 1
            row = (await s.execute(select(ProviderUsage))).scalar_one()
        assert row.status == UsageStatus.committed and row.cost_source == "estimate"
