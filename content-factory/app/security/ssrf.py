"""Безопасная загрузка внешних URL.

Защита от SSRF:
- только http/https и порты 80/443;
- имя хоста разрешается заранее, все адреса проверяются: запрещены частные, loopback, link-local,
  multicast, зарезервированные сети и адреса облачных метаданных;
- соединение идёт на проверенный IP (с SNI исходного хоста), чтобы DNS не подменили между проверкой
  и запросом (DNS rebinding);
- редиректы обрабатываются вручную, каждый шаг проверяется заново;
- ограничены размер ответа и время ожидания.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

ALLOWED_SCHEMES = {"http", "https"}
ALLOWED_PORTS = {80, 443}
MAX_REDIRECTS = 5
USER_AGENT = "BrookcleanContentFactory/0.1 (+research bot; respects robots)"


class UnsafeURLError(ValueError):
    """URL запрещён политикой безопасности."""


class FetchError(RuntimeError):
    """Страница недоступна или ответ некорректен."""


@dataclass(slots=True)
class FetchedResource:
    url: str
    final_url: str
    status_code: int
    content_type: str
    content: bytes
    headers: dict[str, str]

    @property
    def text(self) -> str:
        charset = "utf-8"
        if "charset=" in self.content_type:
            charset = self.content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
        try:
            return self.content.decode(charset, errors="replace")
        except LookupError:
            return self.content.decode("utf-8", errors="replace")


def _ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10"))
    )


def validate_url_syntax(url: str) -> tuple[str, str, int]:
    parts = urlsplit(url.strip())
    scheme = parts.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise UnsafeURLError(f"схема {scheme or '—'} запрещена")
    if parts.username or parts.password:
        raise UnsafeURLError("учётные данные в URL запрещены")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise UnsafeURLError("в URL нет хоста")
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".internal") or host.endswith(".local"):
        raise UnsafeURLError("внутренние имена хостов запрещены")
    port = parts.port or (443 if scheme == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise UnsafeURLError(f"порт {port} запрещён")
    return scheme, host, port


async def resolve_public(host: str, port: int, *, allow_private: bool = False) -> list[str]:
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addresses = [str(literal)]
    else:
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            raise FetchError(f"не удалось разрешить имя {host}") from exc
        addresses = sorted({info[4][0] for info in infos})
    if not addresses:
        raise FetchError(f"нет адресов для {host}")
    if not allow_private:
        for addr in addresses:
            if not _ip_is_public(ipaddress.ip_address(addr.split("%")[0])):
                raise UnsafeURLError(f"адрес {addr} хоста {host} не публичный")
    return addresses


class SafeFetcher:
    def __init__(
        self,
        *,
        timeout_s: float = 20.0,
        max_bytes: int = 5 * 1024 * 1024,
        allow_private: bool = False,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.timeout_s = timeout_s
        self.max_bytes = max_bytes
        self.allow_private = allow_private
        self._transport = transport

    async def fetch(self, url: str, *, method: str = "GET", accept: str = "text/html,application/xhtml+xml,*/*;q=0.5") -> FetchedResource:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            scheme, host, port = validate_url_syntax(current)
            addresses = await resolve_public(host, port, allow_private=self.allow_private)
            status, headers, content = await self._request(method, current, scheme, host, port, addresses[0], accept)
            if status in {301, 302, 303, 307, 308}:
                location = headers.get("location")
                if not location:
                    raise FetchError("редирект без Location")
                current = urljoin(current, location)
                if status == 303:
                    method = "GET"
                continue
            return FetchedResource(
                url=url,
                final_url=current,
                status_code=status,
                content_type=headers.get("content-type", ""),
                content=content,
                headers=headers,
            )
        raise FetchError("слишком много редиректов")

    async def _request(
        self, method: str, url: str, scheme: str, host: str, port: int, ip: str, accept: str
    ) -> tuple[int, dict[str, str], bytes]:
        parts = urlsplit(url)
        ip_host = f"[{ip}]" if ":" in ip else ip
        netloc = ip_host if port in (80, 443) and parts.port is None else f"{ip_host}:{port}"
        pinned = urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))
        headers = {"Host": parts.netloc.split("@")[-1], "User-Agent": USER_AGENT, "Accept": accept}
        extensions = {"sni_hostname": host} if scheme == "https" else {}
        # trust_env=False: запрос не уходит через системный прокси, иначе проверка IP теряет смысл.
        async with httpx.AsyncClient(
            timeout=self.timeout_s, follow_redirects=False, trust_env=False, transport=self._transport
        ) as client:
            try:
                async with client.stream(method, pinned, headers=headers, extensions=extensions) as response:
                    declared = response.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > self.max_bytes:
                        raise FetchError(f"ответ больше {self.max_bytes} байт")
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > self.max_bytes:
                            raise FetchError(f"ответ больше {self.max_bytes} байт")
                        chunks.append(chunk)
                    return (
                        response.status_code,
                        {k.lower(): v for k, v in response.headers.items()},
                        b"".join(chunks),
                    )
            except httpx.HTTPError as exc:
                raise FetchError(f"{type(exc).__name__}: {exc}") from exc
