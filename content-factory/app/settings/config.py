"""Настройки процесса из переменных окружения.

Секреты хранятся как SecretStr: при печати объекта настроек и в логах они не раскрываются.
Настройки канала (бренд, расписание, рубрики) живут в базе и в YAML (см. channel.py),
чтобы владелец менял их без изменения кода.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    log_json: bool = True

    database_url: str = "postgresql+asyncpg://factory:factory@localhost:5432/factory_dev"
    db_pool_size: int = 10

    # Публичный адрес API: нужен для отслеживаемых ссылок /r/<код> и вебхука Telegram.
    public_base_url: str = "http://localhost:8000"

    # --- Хранилище медиа ---
    storage_backend: Literal["local", "s3"] = "local"
    storage_dir: Path = ROOT_DIR / "var" / "media"
    s3_endpoint: str | None = None
    s3_region: str = "ru-1"
    s3_bucket: str | None = None
    s3_access_key: SecretStr | None = None
    s3_secret_key: SecretStr | None = None
    s3_backup_prefix: str = "backups/"

    max_upload_mb: int = 1024
    allowed_upload_mime: list[str] = Field(
        default_factory=lambda: [
            "video/mp4",
            "video/quicktime",
            "video/x-matroska",
            "video/webm",
            "image/jpeg",
            "image/png",
            "image/webp",
            "audio/mpeg",
            "audio/wav",
            "audio/x-wav",
            "audio/mp4",
            "audio/aac",
            "font/ttf",
            "font/otf",
        ]
    )

    # --- Языковая модель (общая для всех агентов) ---
    llm_provider: Literal["anthropic", "none"] = "anthropic"
    anthropic_api_key: SecretStr | None = None
    llm_model: str = "claude-opus-5-5"
    llm_effort: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    # Серверный повтор запроса на запасной модели при отказе классификатора безопасности.
    llm_server_fallbacks: bool = True
    llm_timeout_s: float = 300.0

    # --- Поиск источников ---
    search_providers: list[Literal["anthropic_web", "rss"]] = Field(default_factory=lambda: ["anthropic_web", "rss"])
    research_max_sources: int = 6

    # --- Изображения ---
    image_provider: Literal["openai", "none"] = "none"
    openai_api_key: SecretStr | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    image_model: str = "gpt-image-2"

    # --- ИИ-видео ---
    video_provider: Literal["openai_sora", "runway", "none"] = "none"
    video_model: str = "sora-2"
    runway_api_key: SecretStr | None = None
    runway_base_url: str = "https://api.dev.runwayml.com"
    runway_version: str = "2024-11-06"
    video_poll_interval_s: int = 20
    video_max_wait_minutes: int = 90

    # --- Распознавание речи ---
    transcription_provider: Literal["openai", "none"] = "none"
    transcription_model: str = "whisper-1"

    # --- Орфография ---
    speller_enabled: bool = True
    speller_url: str = "https://speller.yandex.net/services/spellservice.json/checkText"

    # --- Telegram ---
    telegram_bot_token: SecretStr | None = None
    telegram_api_base: str = "https://api.telegram.org"
    telegram_channel_id: str | None = None
    telegram_mode: Literal["polling", "webhook"] = "polling"
    telegram_webhook_secret: SecretStr | None = None
    # Лимит Bot API на отправку файлов. С локальным Bot API сервером — до 2000 МБ.
    telegram_max_upload_mb: int = 50
    # Telegram user ID владельца и администраторов при первом запуске (дальше управляются в БД).
    bootstrap_owner_telegram_ids: list[int] = Field(default_factory=list)
    bootstrap_admin_telegram_ids: list[int] = Field(default_factory=list)

    # --- Статистика через MTProto (необязательно) ---
    mtproto_api_id: int | None = None
    mtproto_api_hash: SecretStr | None = None
    mtproto_session_path: Path | None = None

    # --- Исходящие запросы ---
    outbound_proxy_url: SecretStr | None = None
    fetch_timeout_s: float = 20.0
    fetch_max_bytes: int = 5 * 1024 * 1024
    # Только для тестов и закрытых сетей: разрешить внутренние адреса (по умолчанию запрещены — защита от SSRF).
    ssrf_allow_private: bool = False

    # --- Мониторинг ---
    sentry_dsn: SecretStr | None = None
    metrics_token: SecretStr | None = None

    # --- Конфигурация канала и цен ---
    channel_config_path: Path = ROOT_DIR / "config" / "channel.yaml"
    pricing_path: Path = ROOT_DIR / "config" / "pricing.yaml"
    templates_path: Path = ROOT_DIR / "config" / "templates.yaml"

    # --- Рабочие процессы ---
    worker_concurrency: int = 2
    worker_lease_s: int = 300
    work_dir: Path = ROOT_DIR / "var" / "work"
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    render_timeout_s: int = 1800

    @field_validator("bootstrap_owner_telegram_ids", "bootstrap_admin_telegram_ids", mode="before")
    @classmethod
    def _split_ids(cls, value: object) -> object:
        if isinstance(value, str):
            return [int(v) for v in value.replace(";", ",").split(",") if v.strip()]
        if isinstance(value, int):
            return [value]
        return value

    @field_validator("search_providers", "allowed_upload_mime", mode="before")
    @classmethod
    def _split_list(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip().startswith("["):
            return [v.strip() for v in value.split(",") if v.strip()]
        return value

    @property
    def sync_database_url(self) -> str:
        return self.database_url.replace("+asyncpg", "+psycopg") if "+asyncpg" in self.database_url else self.database_url

    def secret(self, name: str) -> str | None:
        value = getattr(self, name)
        return value.get_secret_value() if value is not None else None


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
