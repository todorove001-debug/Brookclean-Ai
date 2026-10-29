from __future__ import annotations

from enum import StrEnum


class ContentStatus(StrEnum):
    idea = "idea"
    researching = "researching"
    drafting = "drafting"
    media_generation = "media_generation"
    quality_check = "quality_check"
    awaiting_approval = "awaiting_approval"
    changes_requested = "changes_requested"
    approved = "approved"
    scheduled = "scheduled"
    publishing = "publishing"
    published = "published"
    failed = "failed"
    rejected = "rejected"
    cancelled = "cancelled"


TERMINAL_STATUSES = {ContentStatus.published, ContentStatus.rejected, ContentStatus.cancelled}

# Разрешённые переходы. Всё, что не перечислено, запрещено и отклоняется сервисом.
TRANSITIONS: dict[ContentStatus, set[ContentStatus]] = {
    ContentStatus.idea: {ContentStatus.researching, ContentStatus.drafting, ContentStatus.cancelled, ContentStatus.failed},
    ContentStatus.researching: {ContentStatus.drafting, ContentStatus.failed, ContentStatus.cancelled},
    ContentStatus.drafting: {
        ContentStatus.media_generation,
        ContentStatus.quality_check,
        ContentStatus.failed,
        ContentStatus.cancelled,
    },
    ContentStatus.media_generation: {ContentStatus.quality_check, ContentStatus.failed, ContentStatus.cancelled},
    ContentStatus.quality_check: {
        ContentStatus.awaiting_approval,
        ContentStatus.drafting,
        ContentStatus.failed,
        ContentStatus.cancelled,
    },
    ContentStatus.awaiting_approval: {
        ContentStatus.approved,
        ContentStatus.changes_requested,
        ContentStatus.rejected,
        ContentStatus.cancelled,
        ContentStatus.quality_check,
    },
    ContentStatus.changes_requested: {
        ContentStatus.drafting,
        ContentStatus.media_generation,
        ContentStatus.cancelled,
        ContentStatus.failed,
    },
    ContentStatus.approved: {
        ContentStatus.scheduled,
        ContentStatus.failed,
        ContentStatus.changes_requested,
        ContentStatus.quality_check,
        ContentStatus.cancelled,
    },
    ContentStatus.scheduled: {
        ContentStatus.publishing,
        ContentStatus.failed,
        ContentStatus.changes_requested,
        ContentStatus.quality_check,
        ContentStatus.cancelled,
        ContentStatus.approved,
    },
    ContentStatus.publishing: {ContentStatus.published, ContentStatus.failed, ContentStatus.scheduled},
    ContentStatus.failed: {
        ContentStatus.idea,
        ContentStatus.drafting,
        ContentStatus.media_generation,
        ContentStatus.quality_check,
        ContentStatus.scheduled,
        ContentStatus.cancelled,
    },
    ContentStatus.published: set(),
    ContentStatus.rejected: set(),
    ContentStatus.cancelled: set(),
}


class UserRole(StrEnum):
    owner = "owner"
    admin = "admin"
    editor = "editor"
    viewer = "viewer"


class QAStatus(StrEnum):
    pending = "pending"
    passed = "passed"
    # Пройдено, но есть пункты для ручной проверки владельцем (например, сомнительные факты).
    needs_review = "needs_review"
    failed = "failed"


class MediaKind(StrEnum):
    source_video = "source_video"
    source_image = "source_image"
    source_audio = "source_audio"
    music = "music"
    logo = "logo"
    font = "font"
    image = "image"
    cover = "cover"
    infographic = "infographic"
    ai_image = "ai_image"
    ai_video_scene = "ai_video_scene"
    render_video = "render_video"
    thumbnail = "thumbnail"
    subtitles = "subtitles"
    transcript = "transcript"
    frame = "frame"


class MediaOrigin(StrEnum):
    owner_upload = "owner_upload"
    ai_generated = "ai_generated"
    rendered = "rendered"
    template = "template"
    licensed = "licensed"


class VideoJobKind(StrEnum):
    edit = "edit"  # монтаж исходников FFmpeg
    ai_scene = "ai_scene"  # генерация сцены во внешнем сервисе
    assemble = "assemble"  # сборка итогового ролика из сцен и исходников


class VideoJobStatus(StrEnum):
    pending = "pending"
    submitted = "submitted"
    processing = "processing"
    waiting_provider = "waiting_provider"  # сервис недоступен, повтор позже
    waiting_budget = "waiting_budget"  # лимит бюджета, ждёт решения владельца или нового периода
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


ACTIVE_VIDEO_JOB_STATUSES = {
    VideoJobStatus.pending,
    VideoJobStatus.submitted,
    VideoJobStatus.processing,
    VideoJobStatus.waiting_provider,
    VideoJobStatus.waiting_budget,
}


class ApprovalAction(StrEnum):
    submitted = "submitted"
    approve = "approve"
    request_changes = "request_changes"
    regenerate_text = "regenerate_text"
    regenerate_video = "regenerate_video"
    reject = "reject"
    reschedule = "reschedule"
    cancel = "cancel"
    invalidated = "invalidated"  # одобрение снято из-за изменения материала


class PublishingJobStatus(StrEnum):
    pending = "pending"
    sending = "sending"
    succeeded = "succeeded"
    failed = "failed"
    # Запрос в Telegram ушёл, но ответ не получен: публикация могла состояться. Автоповтора нет.
    uncertain = "uncertain"
    cancelled = "cancelled"


class UsageStatus(StrEnum):
    reserved = "reserved"
    committed = "committed"
    released = "released"


class TaskStatus(StrEnum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"  # исчерпаны попытки


class PlanStatus(StrEnum):
    draft = "draft"
    active = "active"
    archived = "archived"


class SourceType(StrEnum):
    web = "web"
    rss = "rss"
    owner_material = "owner_material"


class SourceVerification(StrEnum):
    verified = "verified"  # цитата найдена в тексте страницы
    unverified = "unverified"  # подтверждение не найдено — нужна ручная проверка
    unavailable = "unavailable"  # страница недоступна
