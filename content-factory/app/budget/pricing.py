"""Таблица цен для оценки стоимости. Источник — config/pricing.yaml."""

from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from app.settings.config import get_settings

MILLION = Decimal(1_000_000)


def _d(value: Any) -> Decimal:
    return Decimal(str(value))


def money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


class PricingTable:
    def __init__(self, data: dict[str, Any]):
        self.data = data

    @classmethod
    def load(cls, path: Path) -> PricingTable:
        with path.open(encoding="utf-8") as fh:
            return cls(yaml.safe_load(fh) or {})

    def _llm(self, model: str) -> dict[str, Any]:
        table = self.data.get("llm", {})
        return table.get(model) or table.get("default") or {"input": 0, "output": 0}

    def llm_cost(
        self, model: str, input_tokens: int, output_tokens: int, cache_read: int = 0, cache_write: int = 0
    ) -> Decimal:
        p = self._llm(model)
        total = (
            _d(input_tokens) * _d(p.get("input", 0))
            + _d(output_tokens) * _d(p.get("output", 0))
            + _d(cache_read) * _d(p.get("cache_read", p.get("input", 0)))
            + _d(cache_write) * _d(p.get("cache_write", p.get("input", 0)))
        ) / MILLION
        return money(total)

    def web_search_cost(self, requests: int) -> Decimal:
        return money(_d(requests) * _d(self.data.get("web_search", {}).get("per_request", 0)))

    def image_cost(self, model: str, quality: str, count: int = 1) -> Decimal:
        table = self.data.get("images", {})
        p = table.get(model) or table.get("default") or {}
        return money(_d(p.get(quality, p.get("high", 0))) * count)

    def video_cost(self, provider: str, model: str, seconds: float) -> Decimal:
        table = self.data.get("video", {}).get(provider, {})
        if provider == "runway":
            credits = self.runway_credits_estimate(model, seconds)
            return self.runway_credits_to_usd(credits)
        p = table.get(model) or table.get("default")
        if not p:
            raise KeyError(f"нет цены для {provider}/{model} в pricing.yaml")
        return money(_d(seconds) * _d(p["per_second"]))

    def runway_credits_estimate(self, model: str, seconds: float) -> float:
        table = self.data.get("video", {}).get("runway", {})
        p = table.get(model) or table.get("default") or {"credits_per_second": 0}
        return float(math.ceil(seconds * float(p["credits_per_second"])))

    def runway_credits_to_usd(self, credits: float) -> Decimal:
        rate = self.data.get("video", {}).get("runway", {}).get("credit_usd", 0)
        return money(_d(credits) * _d(rate))

    def transcription_cost(self, model: str, seconds: float) -> Decimal:
        table = self.data.get("transcription", {})
        p = table.get(model) or table.get("default") or {"per_minute": 0}
        return money(_d(seconds) / Decimal(60) * _d(p["per_minute"]))


def estimate_tokens(text: str) -> int:
    # Грубая оценка для русского текста: ~3 символа на токен. Нужна только для резерва бюджета.
    return max(1, len(text) // 3)


@lru_cache
def get_pricing() -> PricingTable:
    return PricingTable.load(get_settings().pricing_path)
