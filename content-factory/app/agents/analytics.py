"""Analytics Agent: рекомендации. Детерминированные правила + (по желанию) формулировки модели по тем же числам."""

from __future__ import annotations

import json
from typing import Any

from app.agents.base import run_agent
from app.analytics.reports import Recommendation, Recommendations, rule_based_recommendations
from app.orchestration.services import Services


async def recommendations(
    services: Services, report: dict[str, Any], *, use_llm: bool = True
) -> dict[str, Any]:
    rules = rule_based_recommendations(report)
    result: dict[str, Any] = {"rules": [r.model_dump() for r in rules], "llm": None}
    if use_llm and services.llm is not None:
        slim = {
            k: report[k]
            for k in (
                "period_days",
                "publications",
                "publishing_success_rate",
                "formats",
                "subscribers",
                "data_availability",
                "idea_to_publish_hours_median",
                "rejected",
            )
        }
        slim["costs_month_usd"] = report["costs"]["month_usd"]
        llm = await run_agent(
            services,
            agent="analytics",
            schema=Recommendations,
            effort="medium",
            expected_output_tokens=900,
            prompt="Сводка показателей (JSON):\n" + json.dumps(slim, ensure_ascii=False, default=str),
        )
        result["llm"] = [r.model_dump() for r in llm.items]
    return result


__all__ = ["Recommendation", "recommendations"]
