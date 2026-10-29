"""Хранилище S3, планировщик, уведомления, аналитика, резервное копирование."""

import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from app.analytics.collector import collect_link_clicks, collect_subscribers
from app.analytics.reports import build_report, rule_based_recommendations
from app.database.enums import TaskStatus
from app.database.models import AnalyticsSnapshot, Notification, Task
from app.database.session import session_scope
from app.monitoring.alerts import notify_owner
from app.orchestration.scheduler import Periodic, period_key, tick
from app.providers.storage.base import ObjectExists, StorageError
from tests.helpers import make_users, run_worker

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def s3_server():
    moto = pytest.importorskip("moto.server")
    server = moto.ThreadedMotoServer(ip_address="127.0.0.1", port=0)
    server.start()
    host, port = server.get_host_and_port()
    yield f"http://{host}:{port}"
    server.stop()


async def test_s3_storage_roundtrip(s3_server, tmp_path):
    import boto3

    from app.providers.storage.s3 import S3Storage

    boto3.client("s3", endpoint_url=s3_server, region_name="us-east-1", aws_access_key_id="k", aws_secret_access_key="s").create_bucket(Bucket="media")
    storage = S3Storage(endpoint=s3_server, region="us-east-1", bucket="media", access_key="k", secret_key="s")
    await storage.check()
    stored = await storage.put_bytes("a/b.txt", b"hello", "text/plain")
    assert stored.size == 5 and len(stored.sha256) == 64
    with pytest.raises(ObjectExists):
        await storage.put_bytes("a/b.txt", b"other", "text/plain")
    big = tmp_path / "big.bin"
    big.write_bytes(b"x" * (40 * 1024 * 1024))  # больше порога multipart
    await storage.put_file("a/big.bin", big, "application/octet-stream")
    assert await storage.size("a/big.bin") == 40 * 1024 * 1024
    assert await storage.get_bytes("a/b.txt") == b"hello"
    assert [k for k, _ in await storage.list_keys("a/")] == ["a/b.txt", "a/big.bin"]
    assert (await storage.presigned_url("a/b.txt")).startswith(s3_server)
    with pytest.raises(StorageError):
        await storage.get_bytes("missing")


def test_period_keys():
    every = Periodic("x", "t", every_s=60)
    daily = Periodic("d", "t", daily_at=datetime.strptime("06:00", "%H:%M").time())
    weekly = Periodic("w", "t", daily_at=datetime.strptime("10:00", "%H:%M").time(), weekday=0)
    monday_7_msk = datetime(2026, 11, 2, 4, 0, tzinfo=UTC)
    assert period_key(every, monday_7_msk, "Europe/Moscow") == str(int(monday_7_msk.timestamp()) // 60)
    assert period_key(daily, monday_7_msk, "Europe/Moscow") == "2026-11-02"
    assert period_key(weekly, monday_7_msk, "Europe/Moscow") is None  # 07:00 < 10:00
    assert period_key(weekly, monday_7_msk + timedelta(days=1, hours=5), "Europe/Moscow") is None  # вторник


@pytest.mark.usefixtures("db")
async def test_scheduler_tick_is_idempotent():
    now = datetime(2026, 11, 2, 9, 0, tzinfo=UTC)  # 12:00 МСК, понедельник
    first = await tick(now)
    second = await tick(now)
    assert "publish-dispatch" in first and "plan-rolling" in first and "analytics-weekly" in first
    assert second == []
    async with session_scope() as s:
        names = (await s.execute(select(Task.name))).scalars().all()
    assert names.count("plan.rolling") == 1


@pytest.mark.usefixtures("db")
async def test_notifications_deduplicated_and_delivered(services, fake_tg):
    await make_users()
    async with session_scope() as s:
        assert await notify_owner(s, key="k1", text="Проверка token=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        assert not await notify_owner(s, key="k1", text="дубль")
    await run_worker(services)
    delivered = [m for m in fake_tg.sent if m["method"] == "sendMessage"]
    assert {m["chat_id"] for m in delivered} == {111, 222}  # владелец и администратор, не редактор
    assert all("AAAAAAAA" not in m["text"] for m in delivered)
    async with session_scope() as s:
        note = (await s.execute(select(Notification))).scalar_one()
    assert note.sent_at is not None


@pytest.mark.usefixtures("db")
async def test_analytics_collect_and_report(services):
    assert await collect_subscribers(services) == 1234
    await collect_link_clicks(services)
    async with session_scope() as s:
        snaps = (await s.execute(select(AnalyticsSnapshot))).scalars().all()
        report = await build_report(s, days=30)
    assert snaps[0].subscribers == 1234
    assert report["publications"] == 0 and report["subscribers"]["last"] == 1234
    recs = rule_based_recommendations(report)
    assert recs[0].title.startswith("Недостаточно данных")


@pytest.mark.usefixtures("db")
def test_backup_create_and_list(tmp_path):
    import os

    env = {**os.environ, "STORAGE_DIR": str(tmp_path / "store")}
    create = subprocess.run([sys.executable, "-m", "app.cli", "backup", "create"], cwd=ROOT, env=env, capture_output=True, text=True)
    if create.returncode != 0 and "pg_dump" in create.stderr and "not found" in create.stderr.lower():
        pytest.skip("pg_dump не установлен")
    assert create.returncode == 0, create.stderr
    listing = subprocess.run([sys.executable, "-m", "app.cli", "backup", "list"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert "backups/db/factory-" in listing.stdout
    refused = subprocess.run([sys.executable, "-m", "app.cli", "backup", "restore", "x"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert refused.returncode == 2 and "--yes" in refused.stderr


__all__ = ["TaskStatus"]
