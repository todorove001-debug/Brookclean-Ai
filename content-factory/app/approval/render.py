"""Тексты и клавиатуры бота согласования."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.database.enums import QAStatus, SourceVerification
from app.database.models import ContentItem, ContentVersion, ResearchSource
from app.providers.telegram.client import inline_keyboard
from app.security.telegram_html import escape

STATUS_RU = {
    "idea": "идея",
    "researching": "исследование",
    "drafting": "написание",
    "media_generation": "медиа",
    "quality_check": "проверка",
    "awaiting_approval": "ждёт согласования",
    "changes_requested": "правки",
    "approved": "одобрено",
    "scheduled": "запланировано",
    "publishing": "публикуется",
    "published": "опубликовано",
    "failed": "ошибка",
    "rejected": "отклонено",
    "cancelled": "отменено",
}
FORMAT_RU = {
    "short_post": "пост",
    "article": "статья",
    "story": "история",
    "ad": "реклама",
    "poll": "опрос",
    "image_post": "пост с обложкой",
    "infographic": "инфографика",
    "video": "видео",
}
QA_RU = {
    QAStatus.passed: "✅ проверки пройдены",
    QAStatus.needs_review: "🟡 есть пункты для вашей проверки",
    QAStatus.failed: "⛔ обязательные проверки не пройдены",
    QAStatus.pending: "⏳ проверка не завершена",
}


def short(uid: uuid.UUID | str) -> str:
    return str(uid).replace("-", "")[:8]


def local(dt: datetime | None, tz: str) -> str:
    if dt is None:
        return "—"
    return dt.astimezone(ZoneInfo(tz)).strftime("%d.%m %H:%M")


def draft_card(item: ContentItem, version: ContentVersion, sources: list[ResearchSource], tz: str) -> str:
    report: dict[str, Any] = version.qa_report or {}
    qa_status = QAStatus(version.qa_status)
    lines = [
        f"📝 <b>Черновик {short(item.id)}</b> · {FORMAT_RU.get(item.format, item.format)} · версия {version.version_no}",
        f"Тема: {escape(item.topic[:200])}",
        f"Время: {local(item.scheduled_at or item.planned_at, tz)} ({tz})",
        f"Цель: {escape((item.goal or '—')[:200])}",
        f"Критерий успеха: {escape((item.success_criterion or '—')[:200])}",
        "",
        QA_RU.get(qa_status, str(qa_status)),
    ]
    findings = report.get("findings") or []
    for severity, icon in (("blocking", "⛔"), ("manual_check", "🔎"), ("warning", "⚠️")):
        group = [f for f in findings if f.get("severity") == severity]
        for f in group[:6]:
            quote = f" — «{escape(f['quote'][:100])}»" if f.get("quote") else ""
            lines.append(f"{icon} {escape(f['message'][:220])}{quote}")
        if len(group) > 6:
            lines.append(f"{icon} … и ещё {len(group) - 6}")
    verified = [s for s in sources if s.verification == SourceVerification.verified and s.url]
    if verified:
        lines += ["", "Источники:"]
        for s in verified[:5]:
            date = s.published_at.strftime("%d.%m.%Y") if s.published_at else "дата не указана"
            lines.append(
                f'• <a href="{escape(s.url or "")}">{escape((s.publisher or s.title or s.url or "")[:60])}</a>, {date}'
            )
    if version.change_request:
        lines += ["", f"Учтены правки: {escape(version.change_request[:300])}"]
    if qa_status == QAStatus.needs_review:
        lines += ["", "Нажимая «Одобрить», вы подтверждаете, что проверили отмеченные пункты."]
    text = "\n".join(lines)
    return text[:4000]


def draft_keyboard(item: ContentItem, version: ContentVersion) -> dict:
    v = version.id.hex
    rows: list[list[tuple[str, str]]] = []
    if QAStatus(version.qa_status) in {QAStatus.passed, QAStatus.needs_review}:
        rows.append([("✅ Одобрить", f"ap:{v}")])
    rows.append([("✏️ Правки", f"ed:{v}"), ("🔁 Переписать текст", f"rt:{v}")])
    second = [("🕒 Перенести", f"rs:{v}"), ("❌ Отклонить", f"rj:{v}")]
    if item.format == "video":
        rows.append([("🎬 Пересобрать видео", f"rv:{v}")])
    rows.append(second)
    return inline_keyboard(rows)


def slots_keyboard(version_id: uuid.UUID, slots: list[datetime], tz: str) -> dict:
    rows = [[(local(s, tz), f"sl:{version_id.hex}:{int(s.timestamp() // 60):x}")] for s in slots[:6]]
    rows.append([("Ввести время вручную", f"ct:{version_id.hex}")])
    return inline_keyboard(rows)


HELP = (
    "<b>Бот согласования публикаций</b>\n\n"
    "/drafts — черновики, ждущие согласования\n"
    "/item &lt;id&gt; — открыть материал\n"
    "/plan [7|30] — контент-план\n"
    "/newplan 7|30 — составить план\n"
    "/queue — очередь публикаций\n"
    "/status &lt;id&gt; — статус и задания материала\n"
    "/costs — расходы и лимиты\n"
    "/errors — сводка ошибок\n"
    "/pause [причина], /resume — пауза очереди публикаций\n"
    "/idea &lt;тема&gt; — добавить идею\n"
    "/story &lt;факты&gt; — история перевозки по вашим материалам\n\n"
    "Параметры пересборки видео: <code>формат 1:1</code>, <code>длительность 30</code>, <code>без ии</code>, "
    "<code>без субтитров</code>, <code>обрезать</code>, <code>высокое качество</code>, остальное — пожелания к стилю."
)


def parse_video_params(text: str) -> dict[str, Any]:
    params: dict[str, Any] = {}
    low = text.lower()
    rest = low
    if m := re.search(r"\b(9:16|16:9|1:1)\b", low):
        params["aspect"] = m.group(1)
        rest = rest.replace(m.group(0), " ")
    if m := re.search(r"(?:длительност\w*|длина)\s*(\d{1,3})|(\d{1,3})\s*(?:с|сек\w*)\b", low):
        seconds = int(m.group(1) or m.group(2))
        if 5 <= seconds <= 180:
            params["duration_s"] = seconds
        rest = rest.replace(m.group(0), " ")
    flags = {
        "без ии": ("no_ai", True),
        "без субтитров": ("subtitles", False),
        "без логотипа": ("logo", False),
        "обрезать": ("reframe", "crop"),
        "высокое качество": ("quality", "high"),
        "без концовки": ("outro", False),
    }
    for phrase, (key, value) in flags.items():
        if phrase in low:
            params[key] = value
            rest = rest.replace(phrase, " ")
    rest = re.sub(r"\b(формат|длительност\w*)\b", " ", rest)
    style = re.sub(r"\s+", " ", rest).strip(" ,.;")
    if style:
        params["style"] = style[:500]
    return params


def parse_local_time(text: str, tz: str, now: datetime) -> datetime | None:
    """«25.11 14:30», «25.11.2026 14:30», «завтра 10:00», «14:30» — в часовом поясе канала."""
    from datetime import timedelta

    zone = ZoneInfo(tz)
    base = now.astimezone(zone)
    low = text.strip().lower()
    if m := re.fullmatch(r"(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})", low):
        day, month, year, hh, mm = m.groups()
        try:
            dt = datetime(int(year or base.year), int(month), int(day), int(hh), int(mm), tzinfo=zone)
        except ValueError:
            return None
        if not year and dt < base:
            dt = dt.replace(year=dt.year + 1)
        return dt
    if m := re.fullmatch(r"(?:(сегодня|завтра|послезавтра)\s+)?(\d{1,2}):(\d{2})", low):
        word, hh, mm = m.groups()
        shift = {"сегодня": 0, "завтра": 1, "послезавтра": 2}.get(word or "", 0)
        try:
            dt = (base + timedelta(days=shift)).replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
        except ValueError:
            return None
        if not word and dt < base:
            dt += timedelta(days=1)
        return dt
    return None
