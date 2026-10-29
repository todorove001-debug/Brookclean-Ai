"""Адаптер Claude (официальный SDK anthropic).

- Структурированный ответ — messages.parse с Pydantic-схемой: результат проверяется SDK и ещё раз нашей схемой.
- Серверный повтор на запасной модели при отказе классификатора (fallbacks="default").
- Поиск — серверный инструмент web_search: ссылки берутся из блоков результатов, а не из текста модели.
"""

from __future__ import annotations

import base64
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from app.monitoring.metrics import PROVIDER_CALLS
from app.providers.base import ProviderNotConfigured, ProviderRejected, ProviderUnavailable
from app.providers.llm.base import ImageInput, LLMResult, LLMUsage, T, WebHit, WebSearchResult

FALLBACK_BETA = "server-side-fallback-2026-07-01"
WEB_SEARCH_TOOL = "web_search_20260209"


class AnthropicProvider:
    name = "anthropic"

    def __init__(
        self,
        *,
        api_key: str | None,
        model: str,
        effort: str = "high",
        server_fallbacks: bool = True,
        timeout_s: float = 300.0,
        client: Any | None = None,
    ) -> None:
        if client is None and not api_key:
            raise ProviderNotConfigured("не задан ANTHROPIC_API_KEY", provider=self.name)
        self.model = model
        self.effort = effort
        self.server_fallbacks = server_fallbacks
        self._client = client or AsyncAnthropic(api_key=api_key, timeout=timeout_s, max_retries=2)

    def _usage(self, response: Any) -> LLMUsage:
        u = response.usage
        server = getattr(u, "server_tool_use", None)
        return LLMUsage(
            model=getattr(response, "model", self.model),
            input_tokens=u.input_tokens or 0,
            output_tokens=u.output_tokens or 0,
            cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
            cache_write_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
            web_search_requests=getattr(server, "web_search_requests", 0) or 0 if server else 0,
            request_id=getattr(response, "_request_id", None),
        )

    def _extra(self) -> dict[str, Any]:
        if self.server_fallbacks:
            return {"betas": [FALLBACK_BETA], "fallbacks": "default"}
        return {}

    @staticmethod
    def _check_stop(response: Any) -> None:
        if response.stop_reason == "refusal":
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None) if details else None
            raise ProviderRejected(f"модель отказалась выполнять запрос (категория: {category})", provider="anthropic", code="refusal")
        if response.stop_reason == "max_tokens":
            raise ProviderRejected("ответ модели обрезан по лимиту max_tokens", provider="anthropic", code="max_tokens")

    async def _call(self, fn: Any, **kwargs: Any) -> Any:
        try:
            response = await fn(**kwargs)
        except anthropic.AuthenticationError as exc:
            PROVIDER_CALLS.labels(self.name, "messages", "auth_error").inc()
            raise ProviderNotConfigured(f"ключ Anthropic отклонён: {exc.message}", provider=self.name, code="401") from exc
        except anthropic.PermissionDeniedError as exc:
            PROVIDER_CALLS.labels(self.name, "messages", "forbidden").inc()
            raise ProviderNotConfigured(f"нет доступа к API Anthropic: {exc.message}", provider=self.name, code="403") from exc
        except anthropic.RateLimitError as exc:
            PROVIDER_CALLS.labels(self.name, "messages", "rate_limited").inc()
            retry = exc.response.headers.get("retry-after") if exc.response is not None else None
            raise ProviderUnavailable("лимит запросов Anthropic", provider=self.name, code="429",
                                      retry_after_s=float(retry) if retry and retry.isdigit() else 60) from exc
        except anthropic.BadRequestError as exc:
            PROVIDER_CALLS.labels(self.name, "messages", "bad_request").inc()
            raise ProviderRejected(f"некорректный запрос: {exc.message}", provider=self.name, code="400") from exc
        except anthropic.APIStatusError as exc:
            PROVIDER_CALLS.labels(self.name, "messages", "server_error").inc()
            if exc.status_code >= 500:
                raise ProviderUnavailable(f"ошибка сервера Anthropic {exc.status_code}", provider=self.name, code=str(exc.status_code)) from exc
            raise ProviderRejected(f"ошибка API {exc.status_code}: {exc.message}", provider=self.name, code=str(exc.status_code)) from exc
        except anthropic.APIConnectionError as exc:
            PROVIDER_CALLS.labels(self.name, "messages", "connection_error").inc()
            raise ProviderUnavailable(f"нет соединения с API Anthropic: {exc}", provider=self.name) from exc
        PROVIDER_CALLS.labels(self.name, "messages", "ok").inc()
        return response

    async def structured(
        self,
        *,
        system: str,
        prompt: str,
        schema: type[T],
        images: list[ImageInput] | None = None,
        max_tokens: int = 16000,
        effort: str | None = None,
    ) -> LLMResult[T]:
        content: list[dict[str, Any]] = []
        for image in images or []:
            content.append(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": image.media_type, "data": base64.standard_b64encode(image.data).decode()},
                }
            )
        content.append({"type": "text", "text": prompt})
        response = await self._call(
            self._client.beta.messages.parse,
            model=self.model,
            max_tokens=max_tokens,
            # Системная инструкция агента неизменна — кешируется между вызовами.
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
            output_format=schema,
            output_config={"effort": effort or self.effort},
            **self._extra(),
        )
        self._check_stop(response)
        parsed = response.parsed_output
        if parsed is None:
            raise ProviderRejected("модель не вернула структурированный ответ", provider=self.name, code="no_output")
        # Повторная проверка нашей схемой (валидаторы Pydantic, которые не выражаются в JSON Schema).
        data = schema.model_validate(parsed.model_dump() if hasattr(parsed, "model_dump") else parsed)
        return LLMResult(data=data, usage=self._usage(response))

    async def web_search(self, *, query: str, instructions: str, max_uses: int = 5) -> WebSearchResult:
        messages: list[dict[str, Any]] = [{"role": "user", "content": f"{instructions}\n\nЗапрос: {query}"}]
        hits: dict[str, WebHit] = {}
        summary_parts: list[str] = []
        total = LLMUsage(model=self.model)
        for _ in range(4):  # продолжение после pause_turn
            response = await self._call(
                self._client.beta.messages.create,
                model=self.model,
                max_tokens=8000,
                messages=messages,
                tools=[{"type": WEB_SEARCH_TOOL, "name": "web_search", "max_uses": max_uses}],
                output_config={"effort": "low"},
                **self._extra(),
            )
            usage = self._usage(response)
            total.input_tokens += usage.input_tokens
            total.output_tokens += usage.output_tokens
            total.cache_read_tokens += usage.cache_read_tokens
            total.cache_write_tokens += usage.cache_write_tokens
            total.web_search_requests += usage.web_search_requests
            total.request_id = usage.request_id
            for block in response.content:
                if block.type == "web_search_tool_result" and isinstance(block.content, list):
                    for result in block.content:
                        if result.url not in hits:
                            hits[result.url] = WebHit(url=result.url, title=result.title, page_age=result.page_age)
                elif block.type == "text":
                    summary_parts.append(block.text)
            if response.stop_reason != "pause_turn":
                if response.stop_reason == "refusal":
                    self._check_stop(response)
                break
            messages.append({"role": "assistant", "content": response.content})
        return WebSearchResult(hits=list(hits.values()), summary="\n".join(summary_parts).strip(), usage=total)
