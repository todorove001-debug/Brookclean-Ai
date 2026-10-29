"""Пользователи, настройки канала, бренд, бюджет, утверждённые факты."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy import select

from app.api.deps import SessionDep, UserDep, require
from app.api.schemas import FactIn, FactOut, TokenOut, UserCreate, UserOut, UserUpdate
from app.budget.service import current_spend
from app.content.channel import get_channel, save_channel_settings
from app.database.enums import UserRole
from app.database.models import CompanyFact, User
from app.database.session import utcnow
from app.monitoring.audit import audit
from app.security.rbac import Permission, new_api_token
from app.settings.channel import BrandConfig, BudgetSettings, ChannelSettings

router = APIRouter(prefix="/api/v1")


@router.get("/me", response_model=UserOut)
async def me(user: UserDep) -> User:
    return user


@router.get("/users", response_model=list[UserOut], dependencies=[Depends(require(Permission.users_manage))])
async def list_users(session: SessionDep) -> list[User]:
    return list((await session.execute(select(User).order_by(User.created_at))).scalars())


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(
    body: UserCreate, session: SessionDep, actor: User = Depends(require(Permission.users_manage))
) -> User:
    user = User(
        display_name=body.display_name, role=UserRole(body.role), telegram_user_id=body.telegram_user_id
    )
    session.add(user)
    await session.flush()
    await audit(
        session,
        "user.create",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="user",
        entity_id=user.id,
        role=body.role,
    )
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    session: SessionDep,
    actor: User = Depends(require(Permission.users_manage)),
) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(404, "пользователь не найден")
    changes = body.model_dump(exclude_unset=True)
    if user.id == actor.id and (changes.get("is_active") is False or changes.get("role", "owner") != "owner"):
        raise HTTPException(400, "нельзя снять с себя роль владельца или отключить себя")
    for key, value in changes.items():
        setattr(user, key, UserRole(value) if key == "role" else value)
    await audit(
        session,
        "user.update",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="user",
        entity_id=user.id,
        changes=changes,
    )
    return user


@router.post("/users/{user_id}/token", response_model=TokenOut)
async def issue_token(
    user_id: uuid.UUID, session: SessionDep, actor: User = Depends(require(Permission.users_manage))
) -> TokenOut:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(404, "пользователь не найден")
    token, digest, prefix = new_api_token()
    user.api_token_hash, user.api_token_prefix = digest, prefix
    await audit(
        session,
        "user.token_issued",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="user",
        entity_id=user.id,
        prefix=prefix,
    )
    return TokenOut(token=token)


@router.get("/channel", dependencies=[Depends(require(Permission.content_read))])
async def channel_settings(session: SessionDep) -> dict[str, Any]:
    channel = await get_channel(session)
    return {
        "id": str(channel.id),
        "telegram_channel_id": channel.row.telegram_channel_id,
        "publishing_paused": channel.row.publishing_paused,
        "paused_reason": channel.row.paused_reason,
        "settings": channel.settings.model_dump(mode="json", exclude={"approved_facts"}),
    }


@router.put("/channel")
async def update_channel(
    body: dict[str, Any], session: SessionDep, actor: User = Depends(require(Permission.config_write))
) -> dict[str, Any]:
    channel = await get_channel(session, for_update=True)
    merged = {**channel.settings.model_dump(mode="json"), **body.get("settings", {})}
    try:
        new = ChannelSettings.model_validate(merged)
    except ValidationError as exc:
        raise HTTPException(422, exc.errors(include_url=False)) from exc
    await save_channel_settings(session, channel, new)
    if "telegram_channel_id" in body:
        channel.row.telegram_channel_id = body["telegram_channel_id"]
    await audit(
        session,
        "channel.update",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="channel",
        entity_id=channel.id,
        keys=sorted(body.get("settings", {})),
    )
    return await channel_settings(session)


@router.put("/brand")
async def update_brand(
    body: BrandConfig, session: SessionDep, actor: User = Depends(require(Permission.config_write))
) -> dict[str, Any]:
    channel = await get_channel(session, for_update=True)
    new = channel.settings.model_copy(update={"brand": body})
    await save_channel_settings(session, channel, new)
    await audit(
        session,
        "brand.update",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="channel",
        entity_id=channel.id,
    )
    return body.model_dump(mode="json")


@router.get("/budget", dependencies=[Depends(require(Permission.budget_read))])
async def get_budget(session: SessionDep) -> dict[str, Any]:
    channel = await get_channel(session)
    spend = await current_spend(session, channel.settings.schedule.timezone)
    return {
        "settings": channel.settings.budget.model_dump(mode="json"),
        "spend": {
            "day_usd": float(spend.day_usd),
            "month_usd": float(spend.month_usd),
            "video_generations_month": spend.video_generations_month,
        },
    }


@router.put("/budget")
async def update_budget(
    body: BudgetSettings, session: SessionDep, actor: User = Depends(require(Permission.budget_write))
) -> dict[str, Any]:
    channel = await get_channel(session, for_update=True)
    old = channel.settings.budget.model_dump(mode="json")
    await save_channel_settings(session, channel, channel.settings.model_copy(update={"budget": body}))
    await audit(
        session,
        "budget.update",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="channel",
        entity_id=channel.id,
        old=old,
        new=body.model_dump(mode="json"),
    )
    return await get_budget(session)


@router.get("/facts", response_model=list[FactOut], dependencies=[Depends(require(Permission.content_read))])
async def list_facts(session: SessionDep) -> list[CompanyFact]:
    channel = await get_channel(session)
    return list(
        (
            await session.execute(
                select(CompanyFact).where(CompanyFact.channel_id == channel.id).order_by(CompanyFact.key)
            )
        ).scalars()
    )


@router.put("/facts", response_model=FactOut)
async def upsert_fact(
    body: FactIn, session: SessionDep, actor: User = Depends(require(Permission.config_write))
) -> CompanyFact:
    channel = await get_channel(session)
    fact = (
        await session.execute(
            select(CompanyFact).where(CompanyFact.channel_id == channel.id, CompanyFact.key == body.key)
        )
    ).scalar_one_or_none()
    if fact is None:
        fact = CompanyFact(
            channel_id=channel.id, key=body.key, category=body.category, statement=body.statement
        )
        session.add(fact)
    fact.category, fact.statement, fact.valid_until, fact.is_active = (
        body.category,
        body.statement,
        body.valid_until,
        True,
    )
    # Любое изменение формулировки снимает утверждение: факт снова требует подтверждения владельца.
    fact.approved_at = utcnow() if body.approve else None
    fact.approved_by_user_id = actor.id if body.approve else None
    await session.flush()
    await audit(
        session,
        "fact.upsert",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="company_fact",
        entity_id=fact.id,
        key=body.key,
        approved=body.approve,
    )
    return fact


@router.delete("/facts/{fact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_fact(
    fact_id: uuid.UUID, session: SessionDep, actor: User = Depends(require(Permission.config_write))
) -> None:
    fact = await session.get(CompanyFact, fact_id)
    if fact is None:
        raise HTTPException(404, "факт не найден")
    fact.is_active = False
    await audit(
        session,
        "fact.deactivate",
        actor_type="user",
        actor_id=str(actor.id),
        entity_type="company_fact",
        entity_id=fact.id,
    )
