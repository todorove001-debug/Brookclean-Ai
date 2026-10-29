"""ORM-модели. Все идентификаторы — UUID, все отметки времени — UTC (timestamptz)."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.database.enums import (
    ApprovalAction,
    ContentStatus,
    MediaKind,
    MediaOrigin,
    PlanStatus,
    PublishingJobStatus,
    QAStatus,
    SourceType,
    SourceVerification,
    TaskStatus,
    UsageStatus,
    UserRole,
    VideoJobKind,
    VideoJobStatus,
)


def _enum(cls: type) -> Enum:
    # Строка с CHECK-ограничением вместо типа ENUM в PostgreSQL: новые значения добавляются без ALTER TYPE.
    return Enum(
        cls,
        native_enum=False,
        create_constraint=True,
        length=32,
        validate_strings=True,
        name=f"ck_{cls.__name__.lower()}",
        values_callable=lambda e: [m.value for m in e],
    )


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSONB, list[Any]: JSONB}


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _updated() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    display_name: Mapped[str] = mapped_column(String(200))
    role: Mapped[UserRole] = mapped_column(_enum(UserRole))
    # Основной способ авторизации в боте — числовой Telegram user ID. Username не используется для доступа.
    telegram_user_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    telegram_username: Mapped[str | None] = mapped_column(String(64))
    # SHA-256 от API-токена. Сам токен показывается один раз при выпуске.
    api_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    api_token_prefix: Mapped[str | None] = mapped_column(String(12))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class ChannelConfig(Base):
    __tablename__ = "channel_configs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    telegram_channel_id: Mapped[str | None] = mapped_column(String(64))
    # Сериализованный ChannelSettings (бренд, расписание, бюджет, правила QA).
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    publishing_paused: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    paused_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class CompanyFact(Base):
    """Утверждённое владельцем сведение о компании: контакты, услуги, условия, цены с датой действия."""

    __tablename__ = "company_facts"

    id: Mapped[uuid.UUID] = _uuid_pk()
    channel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("channel_configs.id", ondelete="CASCADE"), index=True
    )
    category: Mapped[str] = mapped_column(
        String(32)
    )  # contact | service | route | price | terms | case | other
    key: Mapped[str] = mapped_column(String(100))
    statement: Mapped[str] = mapped_column(Text)
    valid_until: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()

    __table_args__ = (UniqueConstraint("channel_id", "key", name="uq_company_facts_key"),)


class ContentPlan(Base):
    __tablename__ = "content_plans"

    id: Mapped[uuid.UUID] = _uuid_pk()
    channel_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("channel_configs.id", ondelete="CASCADE"), index=True
    )
    horizon_days: Mapped[int] = mapped_column(Integer)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    status: Mapped[PlanStatus] = mapped_column(_enum(PlanStatus), default=PlanStatus.draft)
    strategy_notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(64), default="strategist")
    created_at: Mapped[datetime] = _created()

    items: Mapped[list[ContentItem]] = relationship(back_populates="plan")


class ContentItem(Base):
    __tablename__ = "content_items"

    id: Mapped[uuid.UUID] = _uuid_pk()
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channel_configs.id", ondelete="CASCADE"))
    plan_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("content_plans.id", ondelete="SET NULL"))
    status: Mapped[ContentStatus] = mapped_column(_enum(ContentStatus), default=ContentStatus.idea)
    status_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    format: Mapped[str] = mapped_column(String(32))
    rubric: Mapped[str | None] = mapped_column(String(64))
    topic: Mapped[str] = mapped_column(Text)
    goal: Mapped[str | None] = mapped_column(Text)
    audience: Mapped[str | None] = mapped_column(Text)
    thesis: Mapped[str | None] = mapped_column(Text)
    cta: Mapped[str | None] = mapped_column(Text)
    cta_target: Mapped[str | None] = mapped_column(String(64))
    success_criterion: Mapped[str | None] = mapped_column(Text)
    needs_sources: Mapped[bool] = mapped_column(Boolean, default=False)
    media_requirements: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    # Материалы владельца для историй и кейсов: факты, которые нельзя придумывать.
    owner_brief: Mapped[str | None] = mapped_column(Text)
    planned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("content_versions.id", use_alter=True, name="fk_items_current_version")
    )
    approved_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("content_versions.id", use_alter=True, name="fk_items_approved_version")
    )
    approved_content_hash: Mapped[str | None] = mapped_column(String(64))
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pending_change_request: Mapped[str | None] = mapped_column(Text)
    pending_video_params: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    auto_fix_rounds: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(64), default="system")
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    plan: Mapped[ContentPlan | None] = relationship(back_populates="items")
    versions: Mapped[list[ContentVersion]] = relationship(
        back_populates="item", foreign_keys="ContentVersion.item_id", order_by="ContentVersion.version_no"
    )

    __table_args__ = (
        Index("ix_content_items_status", "status"),
        Index("ix_content_items_scheduled", "scheduled_at", postgresql_where=text("status = 'scheduled'")),
        Index("ix_content_items_planned", "planned_at"),
        Index("ix_content_items_channel", "channel_id", "created_at"),
    )


class ContentVersion(Base):
    """Версия материала. После заморозки (frozen_at) запись неизменяема — это проверяет триггер в БД."""

    __tablename__ = "content_versions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_items.id", ondelete="CASCADE"))
    version_no: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(Text, default="")
    body_html: Mapped[str] = mapped_column(Text, default="")
    poll: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    video_script: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    hashtags: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    cta_text: Mapped[str | None] = mapped_column(Text)
    publish_options: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    origin: Mapped[str] = mapped_column(String(64), default="copywriter")
    change_request: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str | None] = mapped_column(String(64))
    frozen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    qa_status: Mapped[QAStatus] = mapped_column(_enum(QAStatus), default=QAStatus.pending)
    qa_report: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _created()

    item: Mapped[ContentItem] = relationship(back_populates="versions", foreign_keys=[item_id])
    media_links: Mapped[list[VersionMedia]] = relationship(
        back_populates="version", order_by="VersionMedia.position", cascade="all, delete-orphan"
    )

    __table_args__ = (UniqueConstraint("item_id", "version_no", name="uq_content_versions_no"),)


class MediaAsset(Base):
    """Файл в хранилище. Ключ и контрольная сумма неизменяемы: оригиналы не перезаписываются."""

    __tablename__ = "media_assets"

    id: Mapped[uuid.UUID] = _uuid_pk()
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("channel_configs.id", ondelete="SET NULL")
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("content_items.id", ondelete="SET NULL"), index=True
    )
    kind: Mapped[MediaKind] = mapped_column(_enum(MediaKind))
    origin: Mapped[MediaOrigin] = mapped_column(_enum(MediaOrigin))
    title: Mapped[str | None] = mapped_column(Text)
    storage_key: Mapped[str] = mapped_column(String(512), unique=True)
    mime_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    duration_s: Mapped[float | None] = mapped_column(Float)
    has_audio: Mapped[bool | None] = mapped_column(Boolean)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    # Права на материал: лицензия, автор, источник. Без подтверждения материал не публикуется.
    rights: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    rights_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    rights_confirmed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    parent_asset_ids: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    # Параметры, по которым файл можно воспроизвести заново (EDL монтажа, шаблон, промпт).
    render_params: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    probe: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    provider: Mapped[str | None] = mapped_column(String(64))
    provider_job_id: Mapped[str | None] = mapped_column(String(200))
    created_by: Mapped[str] = mapped_column(String(64), default="system")
    created_at: Mapped[datetime] = _created()


class VersionMedia(Base):
    __tablename__ = "version_media"

    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("content_versions.id", ondelete="CASCADE"), primary_key=True
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("media_assets.id", ondelete="RESTRICT"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(32), primary_key=True)  # primary | cover | thumbnail
    position: Mapped[int] = mapped_column(Integer, default=0)

    version: Mapped[ContentVersion] = relationship(back_populates="media_links")
    asset: Mapped[MediaAsset] = relationship()


class ResearchSource(Base):
    __tablename__ = "research_sources"

    id: Mapped[uuid.UUID] = _uuid_pk()
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_items.id", ondelete="CASCADE"), index=True)
    source_type: Mapped[SourceType] = mapped_column(_enum(SourceType))
    url: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(Text)
    publisher: Mapped[str | None] = mapped_column(String(200))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content_sha256: Mapped[str | None] = mapped_column(String(64))
    # [{"claim": ..., "quote": ..., "verified": bool}] — только то, что источник действительно подтверждает.
    claims: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    verification: Mapped[SourceVerification] = mapped_column(_enum(SourceVerification))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class VideoJob(Base):
    __tablename__ = "video_jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_items.id", ondelete="CASCADE"), index=True)
    parent_job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("video_jobs.id", ondelete="CASCADE"))
    kind: Mapped[VideoJobKind] = mapped_column(_enum(VideoJobKind))
    status: Mapped[VideoJobStatus] = mapped_column(_enum(VideoJobStatus), default=VideoJobStatus.pending)
    provider: Mapped[str] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(100))
    scene_index: Mapped[int | None] = mapped_column(Integer)
    prompt: Mapped[str | None] = mapped_column(Text)
    # Полные параметры задания: EDL монтажа или параметры генерации. По ним результат воспроизводим.
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    provider_job_id: Mapped[str | None] = mapped_column(String(200))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=2)
    estimated_cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    actual_cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    usage_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("provider_usage.id", ondelete="SET NULL"))
    output_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("media_assets.id", ondelete="SET NULL")
    )
    error: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(String(100))
    next_poll_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("ix_video_jobs_status", "status", "next_poll_at"),)


class ApprovalEvent(Base):
    __tablename__ = "approval_events"

    id: Mapped[uuid.UUID] = _uuid_pk()
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_items.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("content_versions.id", ondelete="CASCADE")
    )
    content_hash: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[ApprovalAction] = mapped_column(_enum(ApprovalAction))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    telegram_user_id: Mapped[int | None] = mapped_column(BigInteger)
    comment: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = _created()


class PublishingJob(Base):
    __tablename__ = "publishing_jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_items.id", ondelete="CASCADE"))
    # Ключ идемпотентности: одна публикация на одобренную версию.
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("content_versions.id"), unique=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    approval_event_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("approval_events.id"))
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[PublishingJobStatus] = mapped_column(
        _enum(PublishingJobStatus), default=PublishingJobStatus.pending
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (
        # Один материал не может иметь двух активных или успешных публикаций.
        Index(
            "uq_publishing_jobs_item_active",
            "item_id",
            unique=True,
            postgresql_where=text("status IN ('pending', 'sending', 'succeeded', 'uncertain')"),
        ),
    )


class PublishingResult(Base):
    __tablename__ = "publishing_results"

    id: Mapped[uuid.UUID] = _uuid_pk()
    publishing_job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("publishing_jobs.id"), unique=True)
    item_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("content_items.id", ondelete="CASCADE"), unique=True
    )
    chat_id: Mapped[str] = mapped_column(String(64))
    primary_message_id: Mapped[int] = mapped_column(BigInteger)
    message_ids: Mapped[list[Any]] = mapped_column(JSONB, default=list)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    response: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)

    __table_args__ = (Index("ix_publishing_results_message", "chat_id", "primary_message_id"),)


class AnalyticsSnapshot(Base):
    __tablename__ = "analytics_snapshots"

    id: Mapped[uuid.UUID] = _uuid_pk()
    channel_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("channel_configs.id", ondelete="CASCADE"))
    item_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("content_items.id", ondelete="CASCADE"))
    message_id: Mapped[int | None] = mapped_column(BigInteger)
    source: Mapped[str] = mapped_column(String(32))  # bot_api | mtproto | tracked_links
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    subscribers: Mapped[int | None] = mapped_column(Integer)
    views: Mapped[int | None] = mapped_column(Integer)
    forwards: Mapped[int | None] = mapped_column(Integer)
    reactions_total: Mapped[int | None] = mapped_column(Integer)
    reactions: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    link_clicks: Mapped[int | None] = mapped_column(Integer)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    __table_args__ = (
        Index("ix_analytics_item_time", "item_id", "captured_at"),
        Index("ix_analytics_channel_time", "channel_id", "captured_at"),
    )


class ProviderUsage(Base):
    """Учёт расходов: резерв до вызова платного API и фиксация фактической стоимости после."""

    __tablename__ = "provider_usage"

    id: Mapped[uuid.UUID] = _uuid_pk()
    provider: Mapped[str] = mapped_column(String(64))
    operation: Mapped[str] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[UsageStatus] = mapped_column(_enum(UsageStatus), default=UsageStatus.reserved)
    estimated_cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 4))
    actual_cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    # provider — сумму сообщил поставщик; tokens — расчёт по фактическим токенам; estimate — оценка.
    cost_source: Mapped[str | None] = mapped_column(String(16))
    units: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    request_id: Mapped[str | None] = mapped_column(String(200))
    item_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("content_items.id", ondelete="SET NULL"))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_provider_usage_created", "created_at"),
        Index("ix_provider_usage_item", "item_id"),
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    actor_type: Mapped[str] = mapped_column(String(16))  # user | system | agent | telegram
    actor_id: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(100))
    entity_type: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (
        Index("ix_audit_logs_created", "created_at"),
        Index("ix_audit_logs_entity", "entity_type", "entity_id"),
    )


class Task(Base):
    """Очередь фоновых задач в PostgreSQL. Задача ставится в той же транзакции, что и изменение данных."""

    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(100))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    status: Mapped[TaskStatus] = mapped_column(_enum(TaskStatus), default=TaskStatus.queued)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    # Пока задача с этим ключом ждёт в очереди, вторая такая же не ставится; задачи с одним ключом
    # выполняются строго по очереди (см. queue._CLAIM_SQL).
    dedup_key: Mapped[str | None] = mapped_column(String(200))
    # Ключ разового запуска (например, «план на 2026-11-02»): уникален навсегда.
    once_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    locked_by: Mapped[str | None] = mapped_column(String(100))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_tasks_ready", "status", "run_at", "priority"),
        Index(
            "uq_tasks_dedup_active",
            "dedup_key",
            unique=True,
            postgresql_where=text("status = 'queued' AND dedup_key IS NOT NULL"),
        ),
    )


class TrackedLink(Base):
    __tablename__ = "tracked_links"

    id: Mapped[uuid.UUID] = _uuid_pk()
    code: Mapped[str] = mapped_column(String(16), unique=True)
    target_url: Mapped[str] = mapped_column(Text)
    label: Mapped[str | None] = mapped_column(String(100))
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("content_items.id", ondelete="SET NULL"), index=True
    )
    clicks: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"))
    created_at: Mapped[datetime] = _created()


class LinkClick(Base):
    """Переход по отслеживаемой ссылке. IP и User-Agent не сохраняются."""

    __tablename__ = "link_clicks"

    id: Mapped[uuid.UUID] = _uuid_pk()
    link_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tracked_links.id", ondelete="CASCADE"), index=True)
    clicked_at: Mapped[datetime] = _created()


class BotConversation(Base):
    """Ожидание текстового ответа в боте: правки, параметры видео, новое время."""

    __tablename__ = "bot_conversations"

    telegram_user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    item_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("content_items.id", ondelete="CASCADE"))
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("content_versions.id", ondelete="CASCADE")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()


class Notification(Base):
    """Уведомления владельцу. Ключ не даёт отправить одно и то же предупреждение дважды."""

    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = _uuid_pk()
    key: Mapped[str] = mapped_column(String(200), unique=True)
    kind: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(Text)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class BotState(Base):
    """Служебные значения бота (смещение getUpdates и т. п.)."""

    __tablename__ = "bot_state"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    updated_at: Mapped[datetime] = _updated()
