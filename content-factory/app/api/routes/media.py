"""Загрузка исходников, права на материалы, доступ к файлам (только с авторизацией)."""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import select

from app.api.deps import ServicesDep, SessionDep, require
from app.api.schemas import MediaOut, RightsIn
from app.database.enums import MediaKind
from app.database.models import ContentItem, MediaAsset, User
from app.database.session import utcnow
from app.media.assets import fetch_verified
from app.media.intake import IntakeError, accept_file
from app.monitoring.audit import audit
from app.security.rbac import Permission

router = APIRouter(prefix="/api/v1/media")
CHUNK = 1024 * 1024


@router.post("", response_model=MediaOut, status_code=201)
async def upload(
    session: SessionDep,
    services: ServicesDep,
    file: Annotated[UploadFile, File()],
    purpose: Annotated[str, Form(pattern="^(source|music|logo|font)$")] = "source",
    item_id: Annotated[uuid.UUID | None, Form()] = None,
    title: Annotated[str | None, Form(max_length=300)] = None,
    rights_license: Annotated[str, Form(pattern="^(own|licensed|stock|music_library)$")] = "own",
    rights_author: Annotated[str | None, Form(max_length=300)] = None,
    rights_source_url: Annotated[str | None, Form(max_length=1000)] = None,
    rights_notes: Annotated[str | None, Form(max_length=2000)] = None,
    rights_confirmed: Annotated[bool, Form()] = False,
    user: User = Depends(require(Permission.media_write)),
) -> MediaAsset:
    settings = services.settings
    max_bytes = settings.max_upload_mb * 1024 * 1024
    if item_id is not None and await session.get(ContentItem, item_id) is None:
        raise HTTPException(404, "материал не найден")
    settings.work_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="upload-", dir=settings.work_dir) as tmp:
        dest = Path(tmp) / "upload.bin"
        size = 0
        with dest.open("wb") as fh:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, f"файл больше {settings.max_upload_mb} МБ")
                fh.write(chunk)
        try:
            return await accept_file(
                session,
                services.storage,
                settings,
                dest,
                user=user,
                purpose=purpose,
                title=title or file.filename,
                item_id=item_id,
                confirm_rights=rights_confirmed,
                channel="api",
                rights={
                    "license": rights_license,
                    "author": rights_author,
                    "source_url": rights_source_url,
                    "notes": rights_notes,
                },
            )
        except IntakeError as exc:
            raise HTTPException(exc.status, str(exc)) from exc


@router.get("", response_model=list[MediaOut], dependencies=[Depends(require(Permission.content_read))])
async def list_media(
    session: SessionDep,
    item_id: uuid.UUID | None = None,
    kind: MediaKind | None = None,
    limit: int = Query(50, le=200),
) -> list[MediaAsset]:
    stmt = select(MediaAsset).order_by(MediaAsset.created_at.desc())
    if item_id:
        stmt = stmt.where(MediaAsset.item_id == item_id)
    if kind:
        stmt = stmt.where(MediaAsset.kind == kind)
    return list((await session.execute(stmt.limit(limit))).scalars())


@router.put("/{asset_id}/rights", response_model=MediaOut)
async def set_rights(
    asset_id: uuid.UUID,
    body: RightsIn,
    session: SessionDep,
    user: User = Depends(require(Permission.content_approve)),
) -> MediaAsset:
    asset = await session.get(MediaAsset, asset_id, with_for_update=True)
    if asset is None:
        raise HTTPException(404, "файл не найден")
    asset.rights = {
        **(asset.rights or {}),
        **body.model_dump(exclude={"confirmed"}),
        "confirmed_at": utcnow().isoformat(),
    }
    asset.rights_confirmed = body.confirmed
    asset.rights_confirmed_by = user.id if body.confirmed else None
    await audit(
        session,
        "media.rights",
        actor_type="user",
        actor_id=str(user.id),
        entity_type="media_asset",
        entity_id=asset.id,
        confirmed=body.confirmed,
        license=body.license,
    )
    return asset


@router.get("/{asset_id}/content", dependencies=[Depends(require(Permission.content_read))])
async def download(asset_id: uuid.UUID, session: SessionDep, services: ServicesDep) -> Response:
    asset = await session.get(MediaAsset, asset_id)
    if asset is None:
        raise HTTPException(404, "файл не найден")
    url = await services.storage.presigned_url(asset.storage_key, expires_s=300)
    if url:
        return RedirectResponse(url, status_code=307, headers={"Cache-Control": "no-store"})
    data = await fetch_verified(services.storage, asset)
    return Response(
        data,
        media_type=asset.mime_type,
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f'inline; filename="{asset.id}"',
        },
    )
