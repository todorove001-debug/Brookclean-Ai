"""Очистка HTML под режим parse_mode=HTML Telegram Bot API.

Telegram принимает ограниченный набор тегов. Всё остальное экранируется как текст, атрибуты
кроме href удаляются, ссылки допускаются только http/https/tg. Результат всегда корректен
для Bot API, даже если языковая модель вернула лишнюю разметку.
"""

from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "blockquote", "tg-spoiler"}
ALLOWED_LINK_SCHEMES = {"http", "https", "tg"}
SKIP_CONTENT = {"script", "style", "head", "title"}
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)


class _Sanitizer(HTMLParser):
    def __init__(self, allowed_links: set[str] | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self.allowed_links = allowed_links
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip = 0  # внутри <script>/<style> текст отбрасывается

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in SKIP_CONTENT:
            self.skip += 1
            return
        if tag == "br":
            self.out.append("\n")
            return
        if tag == "p":
            if self.out and not "".join(self.out).endswith("\n\n"):
                self.out.append("\n\n")
            return
        if tag == "li":
            self.out.append("\n• ")
            return
        if tag not in ALLOWED_TAGS:
            return
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if urlsplit(href).scheme.lower() not in ALLOWED_LINK_SCHEMES:
                return
            if self.allowed_links is not None and href not in self.allowed_links:
                return
            self.out.append(f'<a href="{html.escape(href, quote=True)}">')
        else:
            self.out.append(f"<{tag}>")
        self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in SKIP_CONTENT:
            self.skip = max(self.skip - 1, 0)
            return
        if tag == "p":
            self.out.append("\n\n")
            return
        if tag not in ALLOWED_TAGS or tag not in self.stack:
            return
        # Закрываем вложенные теги в правильном порядке, чтобы разметка оставалась валидной.
        while self.stack:
            top = self.stack.pop()
            self.out.append(f"</{top}>")
            if top == tag:
                break

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.out.append(html.escape(data, quote=False))

    def close(self) -> None:
        super().close()
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")


def sanitize(markup: str, allowed_links: set[str] | None = None) -> str:
    """allowed_links=None — любые http/https/tg-ссылки; множество — только перечисленные, остальные становятся текстом."""
    parser = _Sanitizer(allowed_links)
    parser.feed(markup or "")
    parser.close()
    text = "".join(parser.out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def visible_text(markup: str) -> str:
    """Текст, который увидит читатель (для подсчёта длины и проверок)."""
    no_tags = re.sub(r"<[^>]+>", "", markup or "")
    return html.unescape(no_tags)


def extract_links(markup: str) -> list[str]:
    hrefs = re.findall(r'<a\s+href="([^"]+)"', markup or "")
    bare = URL_RE.findall(visible_text(markup))
    seen: list[str] = []
    for link in [html.unescape(h) for h in hrefs] + bare:
        link = link.rstrip(".,;:!?)»")
        if link not in seen:
            seen.append(link)
    return seen


def escape(text: str) -> str:
    return html.escape(text or "", quote=False)
