from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.settings.channel import ContentFormat


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UserOut(ORM):
    id: uuid.UUID
    display_name: str
    role: str
    telegram_user_id: int | None
    telegram_username: str | None
    api_token_prefix: str | None
    is_active: bool


class UserCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)
    role: Literal["owner", "admin", "editor", "viewer"]
    telegram_user_id: int | None = Field(default=None, gt=0)


class UserUpdate(BaseModel):
    display_name: str | None = None
    role: Literal["owner", "admin", "editor", "viewer"] | None = None
    telegram_user_id: int | None = Field(default=None, gt=0)
    is_active: bool | None = None


class TokenOut(BaseModel):
    token: str
    note: str = "Токен показывается один раз. В базе хранится только его хеш."


class FactIn(BaseModel):
    category: Literal["contact", "service", "route", "price", "terms", "case", "other"]
    key: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9_.-]+$")
    statement: str = Field(min_length=3, max_length=2000)
    valid_until: date | None = None
    approve: bool = False


class FactOut(ORM):
    id: uuid.UUID
    category: str
    key: str
    statement: str
    valid_until: date | None
    is_active: bool
    approved_at: datetime | None


class ItemCreate(BaseModel):
    format: ContentFormat
    topic: str = Field(min_length=5, max_length=500)
    rubric: str | None = None
    goal: str | None = None
    audience: str | None = None
    thesis: str | None = None
    cta: str | None = None
    cta_target: str | None = None
    success_criterion: str | None = None
    needs_sources: bool = False
    owner_brief: str | None = Field(default=None, max_length=8000)
    planned_at: datetime | None = None
    source_asset_ids: list[uuid.UUID] = Field(default_factory=list)
    start: bool = True


class ItemOut(ORM):
    id: uuid.UUID
    plan_id: uuid.UUID | None
    status: str
    format: str
    rubric: str | None
    topic: str
    goal: str | None
    audience: str | None
    thesis: str | None
    cta: str | None
    success_criterion: str | None
    planned_at: datetime | None
    scheduled_at: datetime | None
    current_version_id: uuid.UUID | None
    approved_version_id: uuid.UUID | None
    last_error: str | None
    published_at: datetime | None
    created_at: datetime


class VersionOut(ORM):
    id: uuid.UUID
    version_no: int
    title: str
    body_html: str
    poll: dict[str, Any] | None
    video_script: dict[str, Any] | None
    hashtags: list[Any]
    cta_text: str | None
    origin: str
    change_request: str | None
    content_hash: str | None
    frozen_at: datetime | None
    qa_status: str
    qa_report: dict[str, Any] | None
    created_at: datetime


class ApproveIn(BaseModel):
    version_id: uuid.UUID


class ChangesIn(BaseModel):
    version_id: uuid.UUID
    comment: str = Field(min_length=3, max_length=4000)


class VideoRegenIn(BaseModel):
    version_id: uuid.UUID
    aspect: Literal["9:16", "16:9", "1:1"] | None = None
    duration_s: int | None = Field(default=None, ge=5, le=180)
    no_ai: bool = False
    subtitles: bool = True
    logo: bool = True
    reframe: Literal["blur_pad", "crop", "fit"] = "blur_pad"
    quality: Literal["standard", "high"] = "standard"
    music_asset_id: uuid.UUID | None = None
    style: str | None = Field(default=None, max_length=500)


class RescheduleIn(BaseModel):
    version_id: uuid.UUID
    scheduled_at: datetime


class RejectIn(BaseModel):
    version_id: uuid.UUID
    comment: str | None = None


class PlanRequest(BaseModel):
    horizon_days: Literal[7, 30] = 7


class MediaOut(ORM):
    id: uuid.UUID
    item_id: uuid.UUID | None
    kind: str
    origin: str
    title: str | None
    mime_type: str
    size_bytes: int
    sha256: str
    width: int | None
    height: int | None
    duration_s: float | None
    is_synthetic: bool
    rights: dict[str, Any]
    rights_confirmed: bool
    created_at: datetime


class RightsIn(BaseModel):
    license: Literal["own", "licensed", "stock", "music_library", "generated"]
    author: str | None = None
    source_url: str | None = None
    notes: str | None = None
    confirmed: bool


class VideoJobOut(ORM):
    id: uuid.UUID
    item_id: uuid.UUID
    kind: str
    status: str
    provider: str
    model: str | None
    scene_index: int | None
    provider_job_id: str | None
    attempts: int
    max_attempts: int
    estimated_cost_usd: float | None
    actual_cost_usd: float | None
    error: str | None
    created_at: datetime
    completed_at: datetime | None
