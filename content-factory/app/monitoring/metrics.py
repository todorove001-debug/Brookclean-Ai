"""Метрики Prometheus."""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

TASKS_TOTAL = Counter("cf_tasks_total", "Выполненные фоновые задачи", ["name", "result"])
TASK_SECONDS = Histogram("cf_task_seconds", "Длительность фоновых задач", ["name"], buckets=(0.1, 0.5, 1, 5, 15, 60, 300, 900, 1800))
PROVIDER_CALLS = Counter("cf_provider_calls_total", "Вызовы внешних API", ["provider", "operation", "result"])
PROVIDER_COST = Counter("cf_provider_cost_usd_total", "Фактические расходы на внешние API, USD", ["provider"])
PUBLICATIONS = Counter("cf_publications_total", "Публикации в канал", ["result"])
QUEUE_DEPTH = Gauge("cf_queue_depth", "Задач в очереди", ["status"])
CONTENT_ITEMS = Gauge("cf_content_items", "Материалы по статусам", ["status"])
