from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.models import User
from app.database.session import get_sessionmaker
from app.orchestration.services import Services
from app.security.rbac import Permission, has_permission, hash_token


async def get_session() -> AsyncIterator[AsyncSession]:
    session = get_sessionmaker()()
    try:
        yield session
        await session.commit()
    except BaseException:
        await session.rollback()
        raise
    finally:
        await session.close()


def get_services(request: Request) -> Services:
    return request.app.state.services


SessionDep = Annotated[AsyncSession, Depends(get_session)]
ServicesDep = Annotated[Services, Depends(get_services)]


async def current_user(session: SessionDep, authorization: Annotated[str | None, Header()] = None) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "нужен заголовок Authorization: Bearer <токен>",
                            headers={"WWW-Authenticate": "Bearer"})
    token = authorization.split(" ", 1)[1].strip()
    user = (await session.execute(select(User).where(User.api_token_hash == hash_token(token)))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "токен недействителен", headers={"WWW-Authenticate": "Bearer"})
    return user


UserDep = Annotated[User, Depends(current_user)]


def require(permission: Permission) -> Callable[[User], User]:
    def checker(user: UserDep) -> User:
        if not has_permission(user.role, permission):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"нужно право {permission.value}")
        return user

    return checker
