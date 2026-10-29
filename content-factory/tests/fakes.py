"""Тестовые двойники внешних сервисов. Используются только в тестах, в приложение не входят."""

from __future__ import annotations

import asyncio
import itertools
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.providers.base import ProviderUnavailable
from app.providers.llm.base import ImageInput, LLMResult, LLMUsage, WebHit, WebSearchResult
from app.providers.telegram.client import InputFile, TelegramError
from app.providers.video.base import NormalizedVideoRequest, VideoRequest, VideoStatus, VideoSubmission


@dataclass
class LLMCall:
    agent_prompt: str
    prompt: str
    schema: str
    images: int


class FakeLLM:
    """Отвечает по имени схемы. Обработчик получает текст запроса и возвращает dict или модель."""

    name = "fake_llm"
    model = "claude-opus-5-5"

    def __init__(self, handlers: dict[str, Callable[[str], Any]] | None = None):
        self.handlers = handlers or {}
        self.calls: list[LLMCall] = []
        self.search_hits: list[WebHit] = []

    async def structured(self, *, system: str, prompt: str, schema: type[BaseModel], images: list[ImageInput] | None = None,
                         max_tokens: int = 16000, effort: str | None = None) -> LLMResult:
        self.calls.append(LLMCall(system[-200:], prompt, schema.__name__, len(images or [])))
        handler = self.handlers.get(schema.__name__)
        if handler is None:
            raise AssertionError(f"FakeLLM: нет ответа для схемы {schema.__name__}")
        data = handler(prompt)
        model = data if isinstance(data, BaseModel) else schema.model_validate(data)
        return LLMResult(data=model, usage=LLMUsage(model=self.model, input_tokens=1000, output_tokens=500, request_id="req_test"))

    async def web_search(self, *, query: str, instructions: str, max_uses: int = 5) -> WebSearchResult:
        return WebSearchResult(hits=list(self.search_hits), usage=LLMUsage(model=self.model, input_tokens=500, output_tokens=100,
                                                                           web_search_requests=1))

    def schemas_called(self) -> list[str]:
        return [c.schema for c in self.calls]


class FakeTelegram:
    """Записывает вызовы Bot API и возвращает ответы в формате Telegram."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self._ids = itertools.count(100)
        self.fail_next: TelegramError | None = None
        self.bot_id = 1

    def _result(self, method: str, chat_id: Any, **extra: Any) -> dict[str, Any]:
        if self.fail_next is not None:
            exc, self.fail_next = self.fail_next, None
            raise exc
        msg = {"message_id": next(self._ids), "date": 1700000000, "chat": {"id": chat_id}, **extra}
        self.sent.append({"method": method, "chat_id": chat_id, **extra, "message_id": msg["message_id"]})
        return msg

    async def send_message(self, chat_id, text, *, reply_markup=None, disable_preview=True, parse_mode="HTML", reply_to=None):  # noqa: ANN001, ANN201
        return self._result("sendMessage", chat_id, text=text, reply_markup=reply_markup)

    async def send_photo(self, chat_id, photo, *, caption=None, reply_markup=None):  # noqa: ANN001, ANN201
        assert isinstance(photo, InputFile) and photo.data
        return self._result("sendPhoto", chat_id, caption=caption, size=len(photo.data))

    async def send_video(self, chat_id, video, *, caption=None, width=None, height=None, duration=None, thumbnail=None, reply_markup=None):  # noqa: ANN001, ANN201
        assert isinstance(video, InputFile) and video.data
        return self._result("sendVideo", chat_id, caption=caption, size=len(video.data), width=width, height=height,
                            thumbnail=thumbnail is not None)

    async def send_document(self, chat_id, document, *, caption=None):  # noqa: ANN001, ANN201
        return self._result("sendDocument", chat_id, caption=caption)

    async def send_poll(self, chat_id, question, options, *, is_anonymous=True, allows_multiple_answers=False):  # noqa: ANN001, ANN201
        return self._result("sendPoll", chat_id, question=question, options=options, poll={"id": f"poll{len(self.sent)}"})

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup):  # noqa: ANN001, ANN201
        self.sent.append({"method": "editMessageReplyMarkup", "chat_id": chat_id, "message_id": message_id})
        return True

    async def answer_callback_query(self, callback_query_id, text=None, show_alert=False):  # noqa: ANN001, ANN201
        self.sent.append({"method": "answerCallbackQuery", "text": text, "show_alert": show_alert})
        return True

    async def get_chat_member_count(self, chat_id):  # noqa: ANN001, ANN201
        return 1234

    async def get_chat(self, chat_id):  # noqa: ANN001, ANN201
        return {"id": chat_id, "title": "Тест"}

    async def get_me(self):  # noqa: ANN201
        return {"username": "test_bot"}

    async def delete_webhook(self):  # noqa: ANN201
        return True

    async def aclose(self) -> None:
        return None

    def methods(self) -> list[str]:
        return [m["method"] for m in self.sent]

    def to_chat(self, chat_id: Any) -> list[dict[str, Any]]:
        return [m for m in self.sent if m.get("chat_id") == chat_id]


def make_test_video(path: Path, *, seconds: float = 6, size: str = "1280x720", color_scenes: bool = True, audio: bool = True) -> Path:
    """Тестовый ролик: несколько «сцен» разного цвета и тон в звуковой дорожке."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if color_scenes:
        n = 3
        part = seconds / n
        inputs = []
        for color in ("0x2f6db5", "0xc0392b", "0x27ae60")[:n]:
            inputs += ["-f", "lavfi", "-i", f"testsrc2=size={size}:rate=25:duration={part},hue=s=0,drawbox=c={color}@0.6:t=fill"]
        vf = "".join(f"[{i}:v]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]"
    else:
        inputs = ["-f", "lavfi", "-i", f"testsrc2=size={size}:rate=25:duration={seconds}"]
        vf = "[0:v]null[v]"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs]
    maps = ["-map", "[v]"]
    if audio:
        idx = len(inputs) // 4
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}"]
        maps += ["-map", f"{idx}:a"]
    cmd += ["-filter_complex", vf, *maps, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)]
    subprocess.run(cmd, check=True)
    return path


class FakeVideoGenerator:
    """Имитирует асинхронный сервис генерации для тестов: очередь → обработка → готово."""

    name = "openai_sora"
    model = "sora-2"

    def __init__(self, workdir: Path, *, polls_until_done: int = 1, fail_submit: Exception | None = None):
        self.workdir = workdir
        self.polls_until_done = polls_until_done
        self.fail_submit = fail_submit
        self.submitted: list[NormalizedVideoRequest] = []
        self.polls: dict[str, int] = {}
        self.final_state = "succeeded"

    def normalize(self, request: VideoRequest) -> NormalizedVideoRequest:
        return NormalizedVideoRequest(prompt=request.prompt, duration_s=4, size="720x1280", model=self.model)

    async def submit(self, request: NormalizedVideoRequest) -> VideoSubmission:
        if self.fail_submit is not None:
            raise self.fail_submit
        self.submitted.append(request)
        job_id = f"video_{len(self.submitted)}"
        self.polls[job_id] = 0
        return VideoSubmission(provider_job_id=job_id)

    async def status(self, provider_job_id: str) -> VideoStatus:
        self.polls[provider_job_id] += 1
        if self.polls[provider_job_id] <= self.polls_until_done:
            return VideoStatus(state="processing", progress=50)
        return VideoStatus(state=self.final_state, error="moderation_blocked" if self.final_state == "failed" else None)

    async def download(self, provider_job_id: str, status: VideoStatus, dest: Path, *, max_bytes: int) -> int:
        await asyncio.to_thread(make_test_video, dest, seconds=4, size="720x1280", color_scenes=False, audio=False)
        return dest.stat().st_size


__all__ = ["FakeLLM", "FakeTelegram", "FakeVideoGenerator", "ProviderUnavailable", "make_test_video", "field"]
