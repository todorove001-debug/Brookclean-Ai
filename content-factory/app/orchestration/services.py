"""Сборка адаптеров из настроек. Одно место, где выбирается поставщик для каждой функции."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.budget.pricing import PricingTable, get_pricing
from app.providers.base import ProviderNotConfigured
from app.providers.image.base import ImageGenerator, OpenAIImageGenerator
from app.providers.llm.anthropic_provider import AnthropicProvider
from app.providers.llm.base import LLMProvider
from app.providers.search.base import AnthropicWebSearch, RssSearch, SearchProvider
from app.providers.speech.base import OpenAITranscriber, Transcriber
from app.providers.spelling.base import SpellChecker, YandexSpeller
from app.providers.storage.base import LocalStorage, Storage
from app.providers.storage.s3 import S3Storage
from app.providers.telegram.client import TelegramBotClient
from app.providers.video.base import OpenAISoraGenerator, RunwayGenerator, VideoGenerator
from app.security.ssrf import SafeFetcher
from app.settings.config import Settings


@dataclass
class Services:
    settings: Settings
    storage: Storage
    pricing: PricingTable
    fetcher: SafeFetcher
    llm: LLMProvider | None = None
    search: list[SearchProvider] = field(default_factory=list)
    images: ImageGenerator | None = None
    video: VideoGenerator | None = None
    transcriber: Transcriber | None = None
    speller: SpellChecker | None = None
    telegram: TelegramBotClient | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def require_llm(self) -> LLMProvider:
        if self.llm is None:
            raise ProviderNotConfigured(
                "языковая модель не настроена (LLM_PROVIDER / ANTHROPIC_API_KEY)", provider="llm"
            )
        return self.llm

    def require_telegram(self) -> TelegramBotClient:
        if self.telegram is None:
            raise ProviderNotConfigured("не задан TELEGRAM_BOT_TOKEN", provider="telegram")
        return self.telegram


def build_storage(settings: Settings) -> Storage:
    if settings.storage_backend == "s3":
        if not (settings.s3_bucket and settings.s3_access_key and settings.s3_secret_key):
            raise ProviderNotConfigured(
                "для STORAGE_BACKEND=s3 нужны S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY", provider="s3"
            )
        return S3Storage(
            endpoint=settings.s3_endpoint,
            region=settings.s3_region,
            bucket=settings.s3_bucket,
            access_key=settings.secret("s3_access_key") or "",
            secret_key=settings.secret("s3_secret_key") or "",
        )
    return LocalStorage(settings.storage_dir)


def build_services(settings: Settings, *, rss_feeds: list[str] | None = None) -> Services:
    proxy = settings.secret("outbound_proxy_url")
    fetcher = SafeFetcher(
        timeout_s=settings.fetch_timeout_s,
        max_bytes=settings.fetch_max_bytes,
        allow_private=settings.ssrf_allow_private,
    )
    services = Services(
        settings=settings, storage=build_storage(settings), pricing=get_pricing(), fetcher=fetcher
    )

    if settings.llm_provider == "anthropic" and settings.anthropic_api_key:
        services.llm = AnthropicProvider(
            api_key=settings.secret("anthropic_api_key"),
            model=settings.llm_model,
            effort=settings.llm_effort,
            server_fallbacks=settings.llm_server_fallbacks,
            timeout_s=settings.llm_timeout_s,
        )
    if services.llm is not None and "anthropic_web" in settings.search_providers:
        services.search.append(AnthropicWebSearch(services.llm))
    if "rss" in settings.search_providers:
        services.search.append(RssSearch(rss_feeds or [], fetcher))

    openai_key = settings.secret("openai_api_key")
    if settings.image_provider == "openai" and openai_key:
        services.images = OpenAIImageGenerator(
            api_key=openai_key, model=settings.image_model, base_url=settings.openai_base_url, proxy=proxy
        )
    if settings.video_provider == "openai_sora" and openai_key:
        services.video = OpenAISoraGenerator(
            api_key=openai_key, model=settings.video_model, base_url=settings.openai_base_url, proxy=proxy
        )
    elif settings.video_provider == "runway" and settings.runway_api_key:
        services.video = RunwayGenerator(
            api_key=settings.secret("runway_api_key") or "",
            model=settings.video_model,
            base_url=settings.runway_base_url,
            version=settings.runway_version,
            fetcher=fetcher,
            proxy=proxy,
        )
    if settings.transcription_provider == "openai" and openai_key:
        services.transcriber = OpenAITranscriber(
            api_key=openai_key,
            model=settings.transcription_model,
            base_url=settings.openai_base_url,
            proxy=proxy,
        )
    if settings.speller_enabled:
        services.speller = YandexSpeller(settings.speller_url)
    token = settings.secret("telegram_bot_token")
    if token:
        services.telegram = TelegramBotClient(token, base_url=settings.telegram_api_base, proxy=proxy)
    return services
