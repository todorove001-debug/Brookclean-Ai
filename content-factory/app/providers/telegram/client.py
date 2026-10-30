"""Клиент Telegram Bot API (https://core.telegram.org/bots/api) на httpx.

Свой тонкий клиент вместо фреймворка: нужен точный контроль над тем, ушёл ли запрос публикации
в Telegram. Ошибка до отправки (нет соединения) безопасна для повтора; ошибка после отправки
(обрыв при чтении ответа) означает, что сообщение могло быть опубликовано.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.monitoring.metrics import PROVIDER_CALLS

CAPTION_LIMIT = 1024
MESSAGE_LIMIT = 4096
CALLBACK_DATA_LIMIT = 64


class TelegramError(Exception):
    def __init__(
        self,
        description: str,
        *,
        error_code: int | None = None,
        retry_after: float | None = None,
        request_sent: bool = True,
    ):
        super().__init__(description)
        self.description = description
        self.error_code = error_code
        self.retry_after = retry_after
        # False — запрос точно не дошёл до Telegram, повтор не приведёт к дублю.
        self.request_sent = request_sent

    @property
    def retryable(self) -> bool:
        return (
            self.error_code == 429
            or (self.error_code is not None and self.error_code >= 500)
            or not self.request_sent
        )


@dataclass(slots=True)
class InputFile:
    filename: str
    data: bytes
    mime_type: str


def inline_keyboard(rows: list[list[tuple[str, str]]]) -> dict[str, Any]:
    keyboard = []
    for row in rows:
        buttons = []
        for text, data in row:
            if len(data.encode()) > CALLBACK_DATA_LIMIT:
                raise ValueError(f"callback_data длиннее {CALLBACK_DATA_LIMIT} байт: {data}")
            buttons.append({"text": text, "callback_data": data})
        keyboard.append(buttons)
    return {"inline_keyboard": keyboard}


class TelegramBotClient:
    def __init__(
        self,
        token: str,
        *,
        base_url: str = "https://api.telegram.org",
        timeout_s: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
        proxy: str | None = None,
    ):
        if not token:
            raise ValueError("не задан токен бота")
        self._base = f"{base_url.rstrip('/')}/bot{token}"
        self._file_base = f"{base_url.rstrip('/')}/file/bot{token}"
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=10.0), transport=transport, proxy=proxy
        )
        self.bot_id = int(token.split(":", 1)[0]) if ":" in token else None

    async def aclose(self) -> None:
        await self._http.aclose()

    async def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        files: dict[str, InputFile] | None = None,
        *,
        timeout_s: float | None = None,
    ) -> Any:
        url = f"{self._base}/{method}"
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        kwargs: dict[str, Any] = {}
        if timeout_s is not None:
            kwargs["timeout"] = timeout_s
        try:
            if files:
                data = {
                    k: json.dumps(v, ensure_ascii=False) if isinstance(v, dict | list) else str(v)
                    for k, v in clean.items()
                }
                multipart = {name: (f.filename, f.data, f.mime_type) for name, f in files.items()}
                response = await self._http.post(url, data=data, files=multipart, **kwargs)
            else:
                response = await self._http.post(url, json=clean, **kwargs)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            PROVIDER_CALLS.labels("telegram", method, "connect_error").inc()
            raise TelegramError(
                f"нет соединения с Telegram: {type(exc).__name__}", request_sent=False
            ) from exc
        except httpx.HTTPError as exc:
            PROVIDER_CALLS.labels("telegram", method, "transport_error").inc()
            # Запрос мог быть обработан: ответ не получен.
            raise TelegramError(
                f"обрыв при обмене с Telegram: {type(exc).__name__}", request_sent=True
            ) from exc
        try:
            body = response.json()
        except ValueError as exc:
            raise TelegramError(
                f"некорректный ответ Telegram (HTTP {response.status_code})", error_code=response.status_code
            ) from exc
        if not body.get("ok"):
            PROVIDER_CALLS.labels("telegram", method, "error").inc()
            params_ = body.get("parameters") or {}
            raise TelegramError(
                body.get("description", "неизвестная ошибка"),
                error_code=body.get("error_code", response.status_code),
                retry_after=params_.get("retry_after"),
            )
        PROVIDER_CALLS.labels("telegram", method, "ok").inc()
        return body["result"]

    # --- Методы Bot API ---
    async def get_me(self) -> dict[str, Any]:
        return await self.call("getMe")

    async def get_updates(
        self, offset: int | None, timeout: int = 30, allowed_updates: list[str] | None = None
    ) -> list[dict[str, Any]]:
        return await self.call(
            "getUpdates",
            {"offset": offset, "timeout": timeout, "allowed_updates": allowed_updates},
            timeout_s=timeout + 15,
        )

    async def set_webhook(self, url: str, secret_token: str, allowed_updates: list[str]) -> bool:
        return await self.call(
            "setWebhook", {"url": url, "secret_token": secret_token, "allowed_updates": allowed_updates}
        )

    async def delete_webhook(self) -> bool:
        return await self.call("deleteWebhook", {"drop_pending_updates": False})

    async def send_message(
        self,
        chat_id: int | str,
        text: str,
        *,
        reply_markup: dict | None = None,
        disable_preview: bool = True,
        parse_mode: str | None = "HTML",
        reply_to: int | None = None,
    ) -> dict[str, Any]:
        return await self.call(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": parse_mode,
                "reply_markup": reply_markup,
                "link_preview_options": {"is_disabled": disable_preview},
                "reply_parameters": {"message_id": reply_to} if reply_to else None,
            },
        )

    async def send_photo(
        self,
        chat_id: int | str,
        photo: InputFile | str,
        *,
        caption: str | None = None,
        reply_markup: dict | None = None,
    ) -> dict[str, Any]:
        params = {
            "chat_id": chat_id,
            "caption": caption,
            "parse_mode": "HTML" if caption else None,
            "reply_markup": reply_markup,
        }
        if isinstance(photo, str):
            return await self.call("sendPhoto", {**params, "photo": photo})
        return await self.call("sendPhoto", params, files={"photo": photo}, timeout_s=180)

    async def send_video(
        self,
        chat_id: int | str,
        video: InputFile,
        *,
        caption: str | None = None,
        width: int | None = None,
        height: int | None = None,
        duration: int | None = None,
        thumbnail: InputFile | None = None,
        reply_markup: dict | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "chat_id": chat_id,
            "caption": caption,
            "parse_mode": "HTML" if caption else None,
            "width": width,
            "height": height,
            "duration": duration,
            "supports_streaming": True,
            "reply_markup": reply_markup,
        }
        files = {"video": video}
        if thumbnail is not None:
            files["thumbnail"] = thumbnail
            params["thumbnail"] = "attach://thumbnail"
        return await self.call("sendVideo", params, files=files, timeout_s=600)

    async def send_document(
        self, chat_id: int | str, document: InputFile, *, caption: str | None = None
    ) -> dict[str, Any]:
        return await self.call(
            "sendDocument",
            {"chat_id": chat_id, "caption": caption, "parse_mode": "HTML" if caption else None},
            files={"document": document},
            timeout_s=600,
        )

    async def send_poll(
        self,
        chat_id: int | str,
        question: str,
        options: list[str],
        *,
        is_anonymous: bool = True,
        allows_multiple_answers: bool = False,
    ) -> dict[str, Any]:
        return await self.call(
            "sendPoll",
            {
                "chat_id": chat_id,
                "question": question,
                "options": [{"text": o} for o in options],
                "is_anonymous": is_anonymous,
                "allows_multiple_answers": allows_multiple_answers,
            },
        )

    async def edit_message_reply_markup(
        self, chat_id: int | str, message_id: int, reply_markup: dict | None
    ) -> Any:
        return await self.call(
            "editMessageReplyMarkup",
            {"chat_id": chat_id, "message_id": message_id, "reply_markup": reply_markup},
        )

    async def answer_callback_query(
        self, callback_query_id: str, text: str | None = None, show_alert: bool = False
    ) -> Any:
        return await self.call(
            "answerCallbackQuery",
            {"callback_query_id": callback_query_id, "text": text, "show_alert": show_alert},
        )

    async def get_chat_member_count(self, chat_id: int | str) -> int:
        return await self.call("getChatMemberCount", {"chat_id": chat_id})

    async def get_chat(self, chat_id: int | str) -> dict[str, Any]:
        return await self.call("getChat", {"chat_id": chat_id})

    # Скачивание файлов, присланных боту. Лимит Bot API — 20 МБ (с локальным Bot API сервером больше).
    BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024

    async def get_file(self, file_id: str) -> dict[str, Any]:
        return await self.call("getFile", {"file_id": file_id})

    async def download_file(self, file_path: str, dest: Path, *, max_bytes: int) -> int:
        if ".." in file_path.split("/"):
            raise TelegramError("некорректный путь файла")
        total = 0
        try:
            async with self._http.stream("GET", f"{self._file_base}/{file_path}", timeout=600) as response:
                if response.status_code != 200:
                    raise TelegramError(
                        f"файл недоступен (HTTP {response.status_code})", error_code=response.status_code
                    )
                dest.parent.mkdir(parents=True, exist_ok=True)
                with dest.open("wb") as fh:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise TelegramError("файл больше допустимого размера")
                        fh.write(chunk)
        except httpx.HTTPError as exc:
            raise TelegramError(f"обрыв при загрузке файла: {type(exc).__name__}") from exc
        return total
