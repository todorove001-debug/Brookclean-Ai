"""Командная строка: factory <команда>. Подробности — factory --help."""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from sqlalchemy import select

from app.database.enums import UserRole
from app.database.models import User
from app.database.session import dispose_engine, session_scope, utcnow
from app.monitoring.audit import audit
from app.security.rbac import new_api_token
from app.settings.config import ROOT_DIR, get_settings


def _run(coro):  # noqa: ANN001, ANN202
    async def wrapper():  # noqa: ANN202
        try:
            return await coro
        finally:
            await dispose_engine()

    return asyncio.run(wrapper())


def cmd_migrate(args: argparse.Namespace) -> None:
    subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ROOT_DIR / "alembic.ini"), "upgrade", "head"],
        check=True,
        cwd=ROOT_DIR,
    )


async def _create_user(args: argparse.Namespace) -> None:
    async with session_scope() as session:
        if args.telegram_id:
            exists = (
                await session.execute(select(User).where(User.telegram_user_id == args.telegram_id))
            ).scalar_one_or_none()
            if exists:
                print(f"Пользователь с Telegram ID {args.telegram_id} уже есть: {exists.id} ({exists.role})")
                return
        user = User(display_name=args.name, role=UserRole(args.role), telegram_user_id=args.telegram_id)
        session.add(user)
        await session.flush()
        token = None
        if args.token:
            token, digest, prefix = new_api_token()
            user.api_token_hash, user.api_token_prefix = digest, prefix
        await audit(
            session,
            "user.create",
            actor_type="system",
            actor_id="cli",
            entity_type="user",
            entity_id=user.id,
            role=args.role,
        )
        print(
            f"Создан пользователь {user.id}: {args.name}, роль {args.role}, Telegram ID {args.telegram_id or '—'}"
        )
        if token:
            print(f"API-токен (показывается один раз): {token}")


async def _issue_token(args: argparse.Namespace) -> None:
    async with session_scope() as session:
        stmt = (
            select(User).where(User.telegram_user_id == args.telegram_id)
            if args.telegram_id
            else select(User).where(User.id == args.user_id)
        )
        user = (await session.execute(stmt)).scalar_one_or_none()
        if user is None:
            print("Пользователь не найден", file=sys.stderr)
            sys.exit(1)
        token, digest, prefix = new_api_token()
        user.api_token_hash, user.api_token_prefix = digest, prefix
        await audit(
            session,
            "user.token_issued",
            actor_type="system",
            actor_id="cli",
            entity_type="user",
            entity_id=user.id,
        )
        print(f"API-токен для {user.display_name} (показывается один раз): {token}")


async def _users(args: argparse.Namespace) -> None:
    async with session_scope() as session:
        for u in (await session.execute(select(User).order_by(User.created_at))).scalars():
            print(
                f"{u.id}  {u.role:7}  tg={u.telegram_user_id or '—':<12}  token={u.api_token_prefix or '—':<10}  "
                f"{'активен' if u.is_active else 'отключён'}  {u.display_name}"
            )


async def _check(args: argparse.Namespace) -> None:
    from app.orchestration.services import build_services

    settings = get_settings()
    services = build_services(settings)
    print(f"Окружение: {settings.environment}")
    async with session_scope() as session:
        from app.content.channel import get_channel

        channel = await get_channel(session)
        print(f"База: OK, канал «{channel.settings.name}», пауза: {channel.row.publishing_paused}")
    await services.storage.check()
    print(f"Хранилище ({services.storage.name}): OK")
    print(f"Модель: {services.llm.model if services.llm else 'не настроена'}")
    print(f"Поиск: {[p.name for p in services.search] or 'нет'}")
    print(f"Изображения: {services.images.model if services.images else 'не подключены'}")
    print(
        f"Видео: {services.video.name + ' / ' + services.video.model if services.video else 'не подключено'}"
    )
    print(f"Распознавание речи: {services.transcriber.model if services.transcriber else 'не подключено'}")
    if services.telegram:
        me = await services.telegram.get_me()
        print(f"Telegram-бот: @{me.get('username')}")
        chat = settings.telegram_channel_id or channel.row.telegram_channel_id
        if chat:
            info = await services.telegram.get_chat(chat)
            print(f"Канал: {info.get('title')} ({info.get('id')})")
        await services.telegram.aclose()
    else:
        print("Telegram-бот: не настроен")


async def _plan(args: argparse.Namespace) -> None:
    from app.orchestration.queue import enqueue

    async with session_scope() as session:
        await enqueue(
            session,
            "plan.generate",
            {"horizon_days": args.days},
            dedup_key=f"plan.generate:{args.days}",
            max_attempts=2,
        )
    print(f"Генерация плана на {args.days} дней поставлена в очередь (выполнит worker).")


def _pg_url() -> str:
    url = get_settings().database_url.replace("+asyncpg", "").replace("+psycopg", "")
    return url


def _pg_env(url: str) -> dict[str, str]:
    parts = urlsplit(url)
    env = dict(os.environ)
    if parts.password:
        env["PGPASSWORD"] = parts.password
    return env


def _pg_args(url: str) -> list[str]:
    parts = urlsplit(url)
    return [
        "-h",
        parts.hostname or "localhost",
        "-p",
        str(parts.port or 5432),
        "-U",
        parts.username or "postgres",
        (parts.path or "/").lstrip("/"),
    ]


async def _backup_create(args: argparse.Namespace) -> None:
    from app.orchestration.services import build_storage

    settings = get_settings()
    storage = build_storage(settings)
    url = _pg_url()
    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    with tempfile.TemporaryDirectory() as tmp:
        dump = Path(tmp) / f"factory-{stamp}.dump"
        cmd = ["pg_dump", "--format=custom", "--no-owner", "--no-privileges", "-f", str(dump), *_pg_args(url)]
        subprocess.run(cmd, check=True, env=_pg_env(url))
        key = f"{settings.s3_backup_prefix.rstrip('/')}/db/{dump.name}"
        stored = await storage.put_file(key, dump, "application/octet-stream")
    print(f"Копия базы сохранена: {stored.key} ({stored.size} байт, sha256 {stored.sha256})")


async def _backup_list(args: argparse.Namespace) -> None:
    from app.orchestration.services import build_storage

    settings = get_settings()
    for key, size in await build_storage(settings).list_keys(f"{settings.s3_backup_prefix.rstrip('/')}/db/"):
        print(f"{key}\t{size}")


async def _backup_restore(args: argparse.Namespace) -> None:
    from app.orchestration.services import build_storage

    if not args.yes:
        print("Восстановление перезапишет текущие данные. Добавьте --yes, если уверены.", file=sys.stderr)
        sys.exit(2)
    settings = get_settings()
    storage = build_storage(settings)
    url = _pg_url()
    with tempfile.TemporaryDirectory() as tmp:
        dump = await storage.download(args.key, Path(tmp) / "restore.dump")
        cmd = [
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--single-transaction",
            "-d",
            *_pg_args(url)[-1:],
            *_pg_args(url)[:-1],
            str(dump),
        ]
        subprocess.run(cmd, check=True, env=_pg_env(url))
    print(f"База восстановлена из {args.key}. Перезапустите worker, scheduler и bot.")


async def _facts(args: argparse.Namespace) -> None:
    from app.content.channel import get_channel
    from app.database.models import CompanyFact

    async with session_scope() as session:
        channel = await get_channel(session)
        facts = (
            (
                await session.execute(
                    select(CompanyFact).where(CompanyFact.channel_id == channel.id).order_by(CompanyFact.key)
                )
            )
            .scalars()
            .all()
        )
        if args.facts_command == "list":
            for f in facts:
                mark = "✔" if f.approved_at else "✗"
                print(
                    f"{mark} {f.key:24} [{f.category}] {f.statement}" + ("" if f.is_active else " (отключён)")
                )
            return
        if args.facts_command == "sync":
            from app.content.channel import sync_facts
            from app.settings.channel import load_channel_settings

            seeds = load_channel_settings(get_settings().channel_config_path).approved_facts
            added = await sync_facts(session, channel.id, seeds)
            print("Добавлено: " + (", ".join(added) if added else "новых сведений нет"))
            return
        keys = set(args.keys)
        for f in facts:
            if f.key in keys or args.all:
                f.approved_at = utcnow()
                await audit(
                    session,
                    "fact.approve",
                    actor_type="system",
                    actor_id="cli",
                    entity_type="company_fact",
                    entity_id=f.id,
                )
                print(f"Утверждён: {f.key} — {f.statement}")


async def _stories(args: argparse.Namespace) -> None:
    """Истории владельца из config/stories.yaml → материалы рубрики «Истории перевозок»."""
    from datetime import timedelta

    import yaml

    from app.content.channel import get_channel
    from app.database.enums import ContentStatus
    from app.database.models import ContentItem

    settings = get_settings()
    stories = (yaml.safe_load(settings.stories_path.read_text(encoding="utf-8")) or {}).get("stories", [])
    async with session_scope() as session:
        channel = await get_channel(session)
        start = utcnow() + timedelta(days=channel.settings.schedule.production_lead_days)
        created = 0
        for story in stories:
            marker = f"owner_story:{story['key']}"
            exists = (
                await session.execute(select(ContentItem.id).where(ContentItem.created_by == marker))
            ).first()
            if exists:
                print(f"уже есть: {story['key']}")
                continue
            session.add(
                ContentItem(
                    channel_id=channel.id,
                    status=ContentStatus.idea,
                    format="story",
                    rubric="cases",
                    topic=story["title"],
                    owner_brief=story["text"].strip(),
                    goal="Показать реальную работу компании на живом примере",
                    audience="Покупатели автомобилей во Владивостоке и других городах",
                    cta="Написать менеджеру",
                    cta_target="manager" if "manager" in channel.settings.cta_targets else None,
                    planned_at=start + timedelta(days=args.every_days * created),
                    created_by=marker,
                )
            )
            created += 1
            print(f"добавлено: {story['title']}")
        await audit(session, "stories.load", actor_type="system", actor_id="cli", count=created)
    print(f"Историй добавлено: {created}. Их подготовка начнётся автоматически ближе к дате публикации.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="factory", description="Управление контент-фабрикой")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="применить миграции базы").set_defaults(func=cmd_migrate)

    p = sub.add_parser("create-user", help="создать пользователя")
    p.add_argument("--name", required=True)
    p.add_argument("--role", choices=[r.value for r in UserRole], required=True)
    p.add_argument("--telegram-id", type=int)
    p.add_argument("--token", action="store_true", help="сразу выпустить API-токен")
    p.set_defaults(func=lambda a: _run(_create_user(a)))

    p = sub.add_parser("issue-token", help="выпустить новый API-токен (старый перестаёт работать)")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--telegram-id", type=int)
    g.add_argument("--user-id")
    p.set_defaults(func=lambda a: _run(_issue_token(a)))

    sub.add_parser("users", help="список пользователей").set_defaults(func=lambda a: _run(_users(a)))
    sub.add_parser("check", help="проверить настройки и доступность сервисов").set_defaults(
        func=lambda a: _run(_check(a))
    )

    p = sub.add_parser("plan", help="поставить генерацию плана в очередь")
    p.add_argument("--days", type=int, choices=[7, 30], default=7)
    p.set_defaults(func=lambda a: _run(_plan(a)))

    b = sub.add_parser("backup", help="резервные копии базы").add_subparsers(
        dest="backup_command", required=True
    )
    b.add_parser("create", help="сделать копию и сохранить в хранилище").set_defaults(
        func=lambda a: _run(_backup_create(a))
    )
    b.add_parser("list", help="список копий").set_defaults(func=lambda a: _run(_backup_list(a)))
    r = b.add_parser("restore", help="восстановить базу из копии")
    r.add_argument("key")
    r.add_argument("--yes", action="store_true")
    r.set_defaults(func=lambda a: _run(_backup_restore(a)))

    f = sub.add_parser("facts", help="сведения о компании").add_subparsers(
        dest="facts_command", required=True
    )
    f.add_parser("list", help="список фактов").set_defaults(func=lambda a: _run(_facts(a)))
    fa = f.add_parser("approve", help="утвердить факты по ключам")
    fa.add_argument("keys", nargs="*")
    fa.add_argument("--all", action="store_true", help="утвердить все (только после прочтения списка)")
    fa.set_defaults(func=lambda a: _run(_facts(a)))

    f.add_parser("sync", help="добавить новые сведения из config/channel.yaml").set_defaults(
        func=lambda a: _run(_facts(a))
    )

    st = sub.add_parser("stories", help="истории перевозок владельца").add_subparsers(
        dest="stories_command", required=True
    )
    sl = st.add_parser("load", help="загрузить истории из config/stories.yaml")
    sl.add_argument("--every-days", type=int, default=3, help="интервал между публикациями историй, дней")
    sl.set_defaults(func=lambda a: _run(_stories(a)))

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
