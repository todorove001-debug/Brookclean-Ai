"""Интерфейс генераторов видеосцен и адаптеры OpenAI Sora и Runway.

Форматы запросов сверены с официальными SDK поставщиков (openai 3.x: resources/videos, types/video*;
runwayml 5.x: text_to_video, tasks). Генерация асинхронная: submit → опрос status → download.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import httpx

from app.monitoring.metrics import PROVIDER_CALLS
from app.providers.base import ProviderRejected, ProviderUnavailable, classify_http_status
from app.security.ssrf import FetchError, SafeFetcher, UnsafeURLError


@dataclass(slots=True)
class VideoRequest:
    prompt: str
    duration_s: float
    aspect: str  # 9:16 | 16:9 | 1:1
    quality: str = "standard"  # standard | high


@dataclass(slots=True)
class NormalizedVideoRequest:
    prompt: str
    duration_s: int
    size: str  # в терминах поставщика
    model: str
    notes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class VideoSubmission:
    provider_job_id: str
    estimated_cost_credits: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class VideoStatus:
    state: str  # pending | processing | succeeded | failed | cancelled
    progress: float | None = None
    error: str | None = None
    error_code: str | None = None
    output_urls: list[str] = field(default_factory=list)
    cost_credits: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class VideoGenerator(Protocol):
    name: str
    model: str

    def normalize(self, request: VideoRequest) -> NormalizedVideoRequest: ...
    async def submit(self, request: NormalizedVideoRequest) -> VideoSubmission: ...
    async def status(self, provider_job_id: str) -> VideoStatus: ...
    async def download(
        self, provider_job_id: str, status: VideoStatus, dest: Path, *, max_bytes: int
    ) -> int: ...


def _nearest(value: float, allowed: list[int]) -> int:
    return min(allowed, key=lambda a: (abs(a - value), -a))


class _HttpProvider:
    name = "base"

    def __init__(
        self,
        *,
        base_url: str,
        headers: dict[str, str],
        transport: httpx.AsyncBaseTransport | None = None,
        proxy: str | None = None,
        timeout_s: float = 120.0,
    ):
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers=headers,
            timeout=timeout_s,
            transport=transport,
            proxy=proxy,
        )

    async def _request(self, method: str, path: str, operation: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            PROVIDER_CALLS.labels(self.name, operation, "connection_error").inc()
            raise ProviderUnavailable(
                f"{self.name}: нет связи ({type(exc).__name__})", provider=self.name
            ) from exc
        if response.status_code >= 400:
            PROVIDER_CALLS.labels(self.name, operation, str(response.status_code)).inc()
            try:
                body = response.json()
                message = (
                    (body.get("error") or {}).get("message")
                    if isinstance(body.get("error"), dict)
                    else body.get("error")
                )
                message = message or body.get("message") or response.text[:300]
            except ValueError:
                message = response.text[:300]
            raise classify_http_status(
                response.status_code,
                self.name,
                f"{self.name} {operation}: {message}",
                response.headers.get("retry-after"),
            )
        PROVIDER_CALLS.labels(self.name, operation, "ok").inc()
        return response

    async def aclose(self) -> None:
        await self._http.aclose()


class OpenAISoraGenerator(_HttpProvider):
    """POST /videos (multipart), GET /videos/{id}, GET /videos/{id}/content."""

    name = "openai_sora"
    DURATIONS = [4, 8, 12]
    SIZES = {
        ("sora-2", "9:16"): "720x1280",
        ("sora-2", "16:9"): "1280x720",
        ("sora-2-pro", "9:16"): "1024x1792",
        ("sora-2-pro", "16:9"): "1792x1024",
    }

    def __init__(
        self, *, api_key: str, model: str = "sora-2", base_url: str = "https://api.openai.com/v1", **kw: Any
    ):
        super().__init__(base_url=base_url, headers={"Authorization": f"Bearer {api_key}"}, **kw)
        self.model = model

    def normalize(self, request: VideoRequest) -> NormalizedVideoRequest:
        notes: list[str] = []
        duration = _nearest(request.duration_s, self.DURATIONS)
        if duration != request.duration_s:
            notes.append(
                f"длительность {request.duration_s} с приведена к {duration} с (допустимо: 4, 8, 12)"
            )
        model_family = "sora-2-pro" if self.model.startswith("sora-2-pro") else "sora-2"
        aspect = request.aspect
        if aspect == "1:1":
            # Квадрат поставщик не генерирует: берём вертикаль, монтаж обрежет до 1:1.
            aspect = "9:16"
            notes.append("формат 1:1 генерируется как 9:16 и кадрируется при монтаже")
        size = self.SIZES.get((model_family, aspect))
        if size is None:
            raise ProviderRejected(
                f"соотношение {request.aspect} не поддерживается {self.model}", provider=self.name
            )
        return NormalizedVideoRequest(
            prompt=request.prompt[:4000], duration_s=duration, size=size, model=self.model, notes=notes
        )

    async def submit(self, request: NormalizedVideoRequest) -> VideoSubmission:
        response = await self._request(
            "POST",
            "/videos",
            "create",
            files={
                "model": (None, request.model),
                "prompt": (None, request.prompt),
                "seconds": (None, str(request.duration_s)),
                "size": (None, request.size),
            },
        )
        body = response.json()
        if body.get("status") == "failed":
            err = body.get("error") or {}
            raise ProviderRejected(
                f"Sora отклонила задание: {err.get('message')}", provider=self.name, code=err.get("code")
            )
        return VideoSubmission(provider_job_id=body["id"], raw=body)

    async def status(self, provider_job_id: str) -> VideoStatus:
        body = (await self._request("GET", f"/videos/{provider_job_id}", "retrieve")).json()
        state = {
            "queued": "pending",
            "in_progress": "processing",
            "completed": "succeeded",
            "failed": "failed",
        }.get(body.get("status", ""), "processing")
        err = body.get("error") or {}
        return VideoStatus(
            state=state,
            progress=body.get("progress"),
            error=err.get("message"),
            error_code=err.get("code"),
            raw=body,
        )

    async def download(self, provider_job_id: str, status: VideoStatus, dest: Path, *, max_bytes: int) -> int:
        dest.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        try:
            async with self._http.stream(
                "GET",
                f"/videos/{provider_job_id}/content",
                params={"variant": "video"},
                follow_redirects=True,
                timeout=600,
            ) as response:
                if response.status_code >= 400:
                    raise classify_http_status(response.status_code, self.name, "Sora: файл недоступен")
                with dest.open("wb") as fh:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ProviderRejected(
                                "Sora: файл больше допустимого размера", provider=self.name
                            )
                        fh.write(chunk)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(
                f"Sora: обрыв при загрузке ({type(exc).__name__})", provider=self.name
            ) from exc
        return total


class RunwayGenerator(_HttpProvider):
    """POST /v1/text_to_video, GET /v1/tasks/{id}. Стоимость Runway сообщает в кредитах."""

    name = "runway"
    RATIOS = {"9:16": "720:1280", "16:9": "1280:720"}

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gen4.5",
        base_url: str = "https://api.dev.runwayml.com",
        version: str = "2024-11-06",
        fetcher: SafeFetcher | None = None,
        **kw: Any,
    ):
        super().__init__(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}", "X-Runway-Version": version},
            **kw,
        )
        self.model = model
        self.fetcher = fetcher or SafeFetcher(timeout_s=120)

    def normalize(self, request: VideoRequest) -> NormalizedVideoRequest:
        notes: list[str] = []
        duration = int(min(max(round(request.duration_s), 2), 10))
        if duration != request.duration_s:
            notes.append(f"длительность приведена к {duration} с (допустимо 2–10)")
        aspect = request.aspect
        if aspect == "1:1":
            aspect = "9:16"
            notes.append("формат 1:1 генерируется как 9:16 и кадрируется при монтаже")
        ratio = self.RATIOS.get(aspect)
        if ratio is None:
            raise ProviderRejected(
                f"соотношение {request.aspect} не поддерживается Runway", provider=self.name
            )
        # promptText — не больше 1000 символов (UTF-16).
        return NormalizedVideoRequest(
            prompt=request.prompt[:1000], duration_s=duration, size=ratio, model=self.model, notes=notes
        )

    async def submit(self, request: NormalizedVideoRequest) -> VideoSubmission:
        body = (
            await self._request(
                "POST",
                "/v1/text_to_video",
                "create",
                json={
                    "model": request.model,
                    "promptText": request.prompt,
                    "ratio": request.size,
                    "duration": request.duration_s,
                },
            )
        ).json()
        credits = (body.get("estimatedCost") or {}).get("credits")
        return VideoSubmission(provider_job_id=body["id"], estimated_cost_credits=credits, raw=body)

    async def status(self, provider_job_id: str) -> VideoStatus:
        body = (await self._request("GET", f"/v1/tasks/{provider_job_id}", "retrieve")).json()
        raw_state = body.get("status", "")
        state = {
            "PENDING": "pending",
            "THROTTLED": "pending",
            "RUNNING": "processing",
            "SUCCEEDED": "succeeded",
            "FAILED": "failed",
            "CANCELLED": "cancelled",
        }.get(raw_state, "processing")
        cost = (body.get("cost") or {}).get("credits")
        return VideoStatus(
            state=state,
            progress=body.get("progress"),
            error=body.get("failure"),
            error_code=body.get("failureCode"),
            output_urls=list(body.get("output") or []),
            cost_credits=cost,
            raw=body,
        )

    async def download(self, provider_job_id: str, status: VideoStatus, dest: Path, *, max_bytes: int) -> int:
        if not status.output_urls:
            raise ProviderRejected("Runway: в задаче нет ссылки на результат", provider=self.name)
        try:
            return await self.fetcher.fetch_to_file(
                status.output_urls[0], dest, max_bytes=max_bytes, accept="video/*"
            )
        except UnsafeURLError as exc:
            raise ProviderRejected(f"Runway вернул небезопасную ссылку: {exc}", provider=self.name) from exc
        except FetchError as exc:
            raise ProviderUnavailable(
                f"Runway: не удалось скачать результат: {exc}", provider=self.name
            ) from exc
