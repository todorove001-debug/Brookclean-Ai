"""Общие ошибки адаптеров внешних сервисов.

Каждый внешний сервис подключается отдельным адаптером с узким интерфейсом. Код агентов и сервисов
зависит только от интерфейса, поэтому поставщика можно заменить без переписывания системы.
"""

from __future__ import annotations


class ProviderError(Exception):
    def __init__(self, message: str, *, provider: str = "", code: str | None = None, retry_after_s: float | None = None):
        super().__init__(message)
        self.provider = provider
        self.code = code
        self.retry_after_s = retry_after_s


class ProviderNotConfigured(ProviderError):
    """Нет ключа или поставщик выключен в настройках. Генерация не имитируется."""


class ProviderUnavailable(ProviderError):
    """Временная недоступность: сеть, 5xx, 429. Повтор позже."""


class ProviderRejected(ProviderError):
    """Запрос отклонён окончательно: неверные параметры, модерация, отказ модели. Повтор не поможет."""


def classify_http_status(status: int, provider: str, message: str, retry_after: str | None = None) -> ProviderError:
    retry_s = None
    if retry_after:
        try:
            retry_s = float(retry_after)
        except ValueError:
            retry_s = None
    if status == 429 or status >= 500 or status == 408:
        return ProviderUnavailable(message, provider=provider, code=str(status), retry_after_s=retry_s)
    if status in (401, 403):
        return ProviderNotConfigured(f"доступ запрещён ({status}): проверьте ключ API. {message}", provider=provider, code=str(status))
    return ProviderRejected(message, provider=provider, code=str(status))
