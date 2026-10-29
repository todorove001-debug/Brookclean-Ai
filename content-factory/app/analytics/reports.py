"""Отчёты и рекомендации. Числа — только из базы; если данных мало, отчёт так и говорит."""

from __future__ import annotations

import statistics
from datetime import timedelta
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.enums import ContentStatus, PublishingJobStatus
from app.database.models import AnalyticsSnapshot, ContentItem, PublishingJob, PublishingResult
from app.database.session import utcnow
from app.monitoring.summary import costs_summary, errors_summary

MIN_SAMPLE = 5


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


async def _latest_metric(session: AsyncSession, item_ids: list[Any], column: Any) -> dict[Any, float]:
    if not item_ids:
        return {}
    sub = (select(AnalyticsSnapshot.item_id, column.label("v"),
                  func.row_number().over(partition_by=AnalyticsSnapshot.item_id, order_by=AnalyticsSnapshot.captured_at.desc()).label("rn"))
           .where(AnalyticsSnapshot.item_id.in_(item_ids), column.is_not(None)).subquery())
    rows = (await session.execute(select(sub.c.item_id, sub.c.v).where(sub.c.rn == 1))).all()
    return {r[0]: float(r[1]) for r in rows}


async def build_report(session: AsyncSession, days: int = 30) -> dict[str, Any]:
    since = utcnow() - timedelta(days=days)
    published = (await session.execute(
        select(ContentItem).join(PublishingResult, PublishingResult.item_id == ContentItem.id)
        .where(PublishingResult.published_at >= since)
    )).scalars().all()
    ids = [i.id for i in published]
    views = await _latest_metric(session, ids, AnalyticsSnapshot.views)
    reactions = await _latest_metric(session, ids, AnalyticsSnapshot.reactions_total)
    clicks = await _latest_metric(session, ids, AnalyticsSnapshot.link_clicks)

    jobs = dict((await session.execute(
        select(PublishingJob.status, func.count()).where(PublishingJob.created_at >= since).group_by(PublishingJob.status)
    )).all())
    finished = sum(jobs.get(s, 0) for s in (PublishingJobStatus.succeeded, PublishingJobStatus.failed, PublishingJobStatus.uncertain))
    success_rate = round(jobs.get(PublishingJobStatus.succeeded, 0) / finished, 3) if finished else None

    by_format: dict[str, dict[str, Any]] = {}
    for item in published:
        f = by_format.setdefault(item.format, {"published": 0, "views": [], "reactions": [], "clicks": [], "lead_hours": []})
        f["published"] += 1
        if item.id in views:
            f["views"].append(views[item.id])
        if item.id in reactions:
            f["reactions"].append(reactions[item.id])
        if item.id in clicks:
            f["clicks"].append(clicks[item.id])
        if item.published_at:
            f["lead_hours"].append((item.published_at - item.created_at).total_seconds() / 3600)
    formats = {
        k: {"published": v["published"], "views_median": _median(v["views"]), "views_n": len(v["views"]),
            "reactions_median": _median(v["reactions"]), "reactions_n": len(v["reactions"]),
            "clicks_total": int(sum(v["clicks"])), "clicks_n": len(v["clicks"]), "idea_to_publish_hours_median": _median(v["lead_hours"])}
        for k, v in sorted(by_format.items())
    }
    subscribers = (await session.execute(
        select(AnalyticsSnapshot.captured_at, AnalyticsSnapshot.subscribers).where(AnalyticsSnapshot.subscribers.is_not(None),
                                                                                    AnalyticsSnapshot.captured_at >= since)
        .order_by(AnalyticsSnapshot.captured_at)
    )).all()
    status_counts = dict((await session.execute(
        select(ContentItem.status, func.count()).where(ContentItem.created_at >= since).group_by(ContentItem.status)
    )).all())
    all_leads = [h for v in by_format.values() for h in v["lead_hours"]]
    return {
        "period_days": days,
        "publications": len(published),
        "publishing_success_rate": success_rate,
        "publishing_jobs": {str(k): v for k, v in jobs.items()},
        "items_by_status": {str(k): v for k, v in status_counts.items()},
        "formats": formats,
        "subscribers": {"first": subscribers[0][1] if subscribers else None, "last": subscribers[-1][1] if subscribers else None,
                        "snapshots": len(subscribers)},
        "data_availability": {
            "views": sum(1 for _ in views), "reactions": sum(1 for _ in reactions), "link_clicks": sum(1 for _ in clicks),
            "note": "Просмотры доступны только при подключённом MTProto; Bot API их не отдаёт.",
        },
        "idea_to_publish_hours_median": _median(all_leads),
        "costs": await costs_summary(session),
        "errors": await errors_summary(session, days=min(days, 30)),
        "rejected": status_counts.get(ContentStatus.rejected, 0),
    }


class Recommendation(BaseModel):
    title: str
    evidence: str
    action: str


class Recommendations(BaseModel):
    items: list[Recommendation] = Field(default_factory=list)


def rule_based_recommendations(report: dict[str, Any]) -> list[Recommendation]:
    recs: list[Recommendation] = []
    formats = report["formats"]
    for metric, label in (("views", "просмотрам"), ("reactions", "реакциям")):
        comparable = {k: v for k, v in formats.items() if v[f"{metric}_n"] >= MIN_SAMPLE and v[f"{metric}_median"] is not None}
        if len(comparable) >= 2:
            best = max(comparable, key=lambda k: comparable[k][f"{metric}_median"])
            worst = min(comparable, key=lambda k: comparable[k][f"{metric}_median"])
            if best != worst:
                recs.append(Recommendation(
                    title=f"Формат «{best}» лучше по {label}",
                    evidence=f"медиана {comparable[best][f'{metric}_median']} (n={comparable[best][f'{metric}_n']}) против "
                             f"{comparable[worst][f'{metric}_median']} у «{worst}» (n={comparable[worst][f'{metric}_n']})",
                    action=f"Увеличить долю «{best}» в плане на 5–10 п. п. и через месяц сравнить снова.",
                ))
            break
    else:
        recs.append(Recommendation(
            title="Недостаточно данных для сравнения форматов",
            evidence=f"нужно минимум {MIN_SAMPLE} публикаций каждого формата с метриками; сейчас: "
                     + ", ".join(f"{k}: просмотры {v['views_n']}, реакции {v['reactions_n']}" for k, v in formats.items()) if formats else "публикаций нет",
            action="Подключить сбор просмотров через MTProto и включить реакции в канале; держать план без перекосов форматов.",
        ))
    rate = report["publishing_success_rate"]
    if rate is not None and rate < 0.95:
        recs.append(Recommendation(title="Есть сбои публикации", evidence=f"успешно {rate:.0%} заданий публикации",
                                   action="Разобрать ошибки в /errors: права бота в канале, размер файлов, сеть."))
    lead = report["idea_to_publish_hours_median"]
    if lead is not None and lead > 72:
        recs.append(Recommendation(title="Долгий путь от идеи до публикации", evidence=f"медиана {lead:.0f} ч",
                                   action="Проверить, где задерживаются материалы: согласование, генерация видео или очередь."))
    clicks = sum(v["clicks_total"] for v in formats.values())
    if report["publications"] >= 10 and clicks == 0:
        recs.append(Recommendation(title="Нет переходов по ссылкам", evidence=f"{report['publications']} публикаций, 0 переходов",
                                   action="Проверить, что в настройках заданы цели призывов (cta_targets), и делать призыв конкретнее."))
    if report["rejected"] >= 5:
        recs.append(Recommendation(title="Много отклонённых материалов", evidence=f"отклонено: {report['rejected']}",
                                   action="Уточнить рубрики и голос бренда в настройках канала; добавить утверждённые факты."))
    return recs
