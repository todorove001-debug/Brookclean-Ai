"""Схемы настроек канала: бренд, расписание, форматы, бюджет, правила проверки.

Источник при первом запуске — YAML (config/channel.yaml). Дальше значения хранятся в таблице
channel_configs и меняются через Admin API без изменения кода.
"""

from __future__ import annotations

import re
from datetime import time
from decimal import Decimal
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

ContentFormat = Literal[
    "short_post",  # короткий информационный пост
    "article",  # экспертная статья
    "story",  # история перевозки (только по материалам владельца)
    "ad",  # рекламная публикация
    "poll",  # опрос
    "image_post",  # пост с обложкой или иллюстрацией
    "infographic",  # инфографика
    "video",  # видео: монтаж исходников и/или ИИ-сцены
]

FORMATS_WITH_IMAGE = {"image_post", "infographic"}
FORMATS_WITH_VIDEO = {"video"}


class BrandColors(BaseModel):
    primary: str = "#1F4FA3"
    secondary: str = "#0E1B2E"
    accent: str = "#F2B705"
    text: str = "#FFFFFF"
    text_dark: str = "#0E1B2E"
    background: str = "#0E1B2E"

    @field_validator("*")
    @classmethod
    def _hex(cls, v: str) -> str:
        if not HEX_COLOR.match(v):
            raise ValueError(f"цвет должен быть в формате #RRGGBB: {v}")
        return v


class BrandFonts(BaseModel):
    # Путь к файлу шрифта на диске или ключ в медиахранилище (storage:<ключ>).
    regular: str = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    bold: str = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


class BrandConfig(BaseModel):
    company_name: str = "Brookclean Trucks"
    # Логотип: путь к файлу или storage:<ключ>. Пусто — логотип не накладывается.
    logo: str | None = None
    colors: BrandColors = Field(default_factory=BrandColors)
    fonts: BrandFonts = Field(default_factory=BrandFonts)
    # Контакты, которые можно печатать на обложках. Только утверждённые владельцем.
    contacts: list[str] = Field(default_factory=list)
    voice: str = (
        "Спокойный экспертный тон. Конкретика вместо восклицаний. Без канцелярита и рекламного пафоса. "
        "Обращение на «вы»."
    )
    hashtags: list[str] = Field(default_factory=list)
    # Подпись к синтетическим изображениям и видео, чтобы их не принимали за документальные кадры.
    synthetic_disclosure: str = "Иллюстрация создана с помощью ИИ"


class PublishWindow(BaseModel):
    start: time
    end: time

    @model_validator(mode="after")
    def _order(self) -> PublishWindow:
        if self.end <= self.start:
            raise ValueError("окно публикации: конец должен быть позже начала")
        return self


class ScheduleConfig(BaseModel):
    timezone: str = "Europe/Moscow"
    posts_per_day_min: int = Field(4, ge=1, le=20)
    posts_per_day_max: int = Field(7, ge=1, le=20)
    # Предпочтительные слоты; планировщик ставит публикации в них, а при занятости — в разрешённые окна.
    slots: list[time] = Field(default_factory=lambda: [time(9, 0), time(12, 0), time(15, 0), time(18, 0), time(20, 30)])
    windows: list[PublishWindow] = Field(default_factory=lambda: [PublishWindow(start=time(8, 0), end=time(22, 0))])
    min_gap_minutes: int = Field(90, ge=10)
    # За сколько дней до даты публикации запускать подготовку, чтобы владелец успел согласовать.
    production_lead_days: int = Field(2, ge=0, le=14)

    @model_validator(mode="after")
    def _check(self) -> ScheduleConfig:
        if self.posts_per_day_min > self.posts_per_day_max:
            raise ValueError("posts_per_day_min больше posts_per_day_max")
        return self


class ContentMix(BaseModel):
    """Целевая доля форматов в плане. Нормализуется до суммы 1."""

    shares: dict[str, float] = Field(
        default_factory=lambda: {
            "short_post": 0.25,
            "article": 0.12,
            "image_post": 0.12,
            "infographic": 0.08,
            "video": 0.25,
            "poll": 0.06,
            "ad": 0.08,
            "story": 0.04,
        }
    )
    videos_per_month_min: int = 30
    videos_per_month_max: int = 60

    @field_validator("shares")
    @classmethod
    def _normalize(cls, v: dict[str, float]) -> dict[str, float]:
        allowed = set(ContentFormat.__args__)  # type: ignore[attr-defined]
        unknown = set(v) - allowed
        if unknown:
            raise ValueError(f"неизвестные форматы: {sorted(unknown)}")
        total = sum(x for x in v.values() if x > 0)
        if total <= 0:
            raise ValueError("доли форматов должны быть положительными")
        return {k: round(x / total, 4) for k, x in v.items() if x > 0}


class Rubric(BaseModel):
    key: str
    title: str
    description: str
    needs_sources: bool = False
    # Рубрика требует фактов от владельца (кейсы, отзывы); без них материал не готовится.
    requires_owner_material: bool = False


class Route(BaseModel):
    origin: str
    destination: str


class BudgetSettings(BaseModel):
    """Лимиты расходов на платные API. Суммы — в долларах США, как выставляют счета поставщики."""

    daily_limit_usd: Decimal = Decimal("15")
    monthly_limit_usd: Decimal = Decimal("300")
    max_task_cost_usd: Decimal = Decimal("5")
    video_generations_per_month: int = 120
    max_retries_paid: int = 2
    warn_thresholds: list[float] = Field(default_factory=lambda: [0.5, 0.8, 0.95])
    # Если True, при исчерпании лимита платные задачи останавливаются, бесплатные продолжаются.
    hard_stop: bool = True

    @field_validator("warn_thresholds")
    @classmethod
    def _thresholds(cls, v: list[float]) -> list[float]:
        if any(not 0 < x < 1 for x in v):
            raise ValueError("пороги предупреждений — доли от 0 до 1")
        return sorted(set(v))


class QAConfig(BaseModel):
    max_auto_fix_rounds: int = 1
    max_title_similarity: float = 0.72
    max_body_similarity: float = 0.6
    max_same_cta_per_week: int = 3
    # Маркировка рекламы (erid). Обязательность определяет владелец или юрист компании.
    ad_marking_required: bool = False
    forbidden_phrases: list[str] = Field(
        default_factory=lambda: [
            "лучший в России",
            "номер один",
            "№1",
            "самые низкие цены",
            "дешевле всех",
            "100% гарантия",
            "гарантируем доставку в срок",
            "без рисков",
            "абсолютно безопасно",
        ]
    )
    topic_keywords: list[str] = Field(
        default_factory=lambda: [
            "автовоз",
            "перевоз",
            "доставк",
            "логист",
            "автомобил",
            "машин",
            "маршрут",
            "погрузк",
            "транспорт",
            "трал",
            "владивосток",
            "растаможк",
            "дорог",
        ]
    )


class ChannelSettings(BaseModel):
    name: str = "Brookclean Trucks"
    description: str = "Перевозка автомобилей автовозами из Владивостока по России"
    brand: BrandConfig = Field(default_factory=BrandConfig)
    schedule: ScheduleConfig = Field(default_factory=ScheduleConfig)
    mix: ContentMix = Field(default_factory=ContentMix)
    rubrics: list[Rubric] = Field(default_factory=list)
    routes: list[Route] = Field(default_factory=list)
    budget: BudgetSettings = Field(default_factory=BudgetSettings)
    qa: QAConfig = Field(default_factory=QAConfig)
    # Куда ведут призывы к действию. Ссылки оборачиваются в отслеживаемые /r/<код>.
    cta_targets: dict[str, str] = Field(default_factory=dict)
    rss_feeds: list[str] = Field(default_factory=list)
    # Утверждённые владельцем сведения о компании: только они попадают в рекламные тексты.
    approved_facts: list[dict[str, str]] = Field(default_factory=list)


def load_channel_settings(path: Path) -> ChannelSettings:
    if not path.exists():
        return ChannelSettings()
    with path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return ChannelSettings.model_validate(data)
