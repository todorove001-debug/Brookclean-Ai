import httpx
import pytest

from app.security import telegram_html
from app.security.rbac import Permission, has_permission, hash_token, new_api_token
from app.security.redaction import redact, redact_text
from app.security.ssrf import FetchError, SafeFetcher, UnsafeURLError, resolve_public, validate_url_syntax
from app.security.uploads import UploadRejected, sniff_mime, validate_upload


class TestTelegramHtml:
    def test_keeps_allowed_tags_and_escapes_rest(self):
        out = telegram_html.sanitize('<p>Цена <b>от <i>x</b></p><script>alert(1)</script><img src=x onerror=1>&')
        assert out == "Цена <b>от <i>x</i></b>\n\n&amp;"

    def test_removes_unsafe_links(self):
        out = telegram_html.sanitize('<a href="javascript:alert(1)">тут</a> <a href="https://ok.ru/?a=1&b=2">ok</a>')
        assert out == 'тут <a href="https://ok.ru/?a=1&amp;b=2">ok</a>'

    def test_allowed_links_whitelist(self):
        out = telegram_html.sanitize('<a href="https://evil.example">клик</a>', set())
        assert out == "клик"

    def test_lists_and_paragraphs(self):
        out = telegram_html.sanitize("<p>Раз</p><ul><li>один</li><li>два</li></ul>")
        assert out == "Раз\n\n• один\n• два"

    def test_extract_links_and_visible_text(self):
        html = 'Смотрите <a href="https://a.ru/x">здесь</a> и https://b.ru/y.'
        assert telegram_html.extract_links(html) == ["https://a.ru/x", "https://b.ru/y"]
        assert telegram_html.visible_text("<b>a &amp; b</b>") == "a & b"


class TestSSRF:
    @pytest.mark.parametrize("url", ["ftp://x.ru/", "file:///etc/passwd", "http://localhost/", "http://x.ru:8080/",
                                     "http://user:pass@x.ru/", "http://metadata.internal/", "gopher://x.ru/"])
    def test_rejects_bad_syntax(self, url):
        with pytest.raises(UnsafeURLError):
            validate_url_syntax(url)

    @pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "100.64.1.1", "::1", "::ffff:127.0.0.1", "0.0.0.0"])
    async def test_rejects_private_addresses(self, ip):
        with pytest.raises(UnsafeURLError):
            await resolve_public(ip, 80)

    async def test_public_ip_allowed(self):
        assert await resolve_public("93.184.216.34", 443) == ["93.184.216.34"]

    async def test_redirect_to_private_blocked(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.headers["host"] == "93.184.216.34"
            return httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})

        fetcher = SafeFetcher(transport=httpx.MockTransport(handler))
        with pytest.raises(UnsafeURLError):
            await fetcher.fetch("http://93.184.216.34/start")

    async def test_size_limit(self):
        fetcher = SafeFetcher(max_bytes=100, transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 1000)))
        with pytest.raises(FetchError):
            await fetcher.fetch("http://93.184.216.34/big")

    async def test_pins_ip_and_keeps_host_header(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["host"] = request.headers["host"]
            seen["sni"] = request.extensions.get("sni_hostname")
            return httpx.Response(200, text="<html>ok</html>", headers={"content-type": "text/html; charset=utf-8"})

        fetcher = SafeFetcher(allow_private=True, transport=httpx.MockTransport(handler))
        page = await fetcher.fetch("https://127.0.0.1/page?q=1")
        assert seen["url"].startswith("https://127.0.0.1/page?q=1")
        assert page.text == "<html>ok</html>"


class TestRedaction:
    def test_tokens_removed(self):
        text = "GET https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage Bearer abcdefghijk sk-ant-api03-xyzxyzxyz"
        out = redact_text(text)
        assert "AAHdqTcv" not in out and "abcdefghijk" not in out and "xyzxyz" not in out

    def test_dict_keys(self):
        assert redact({"api_key": "s", "nested": {"password": "p", "ok": "v"}}) == {"api_key": "[redacted]", "nested": {"password": "[redacted]", "ok": "v"}}

    def test_database_url(self):
        assert "secret" not in redact_text("postgresql+asyncpg://user:secret@db:5432/x")


class TestRBAC:
    def test_roles(self):
        assert has_permission("owner", Permission.users_manage)
        assert has_permission("admin", Permission.content_approve)
        assert not has_permission("admin", Permission.budget_write)
        assert not has_permission("editor", Permission.content_approve)
        assert not has_permission("viewer", Permission.content_write)

    def test_token(self):
        token, digest, prefix = new_api_token()
        assert token.startswith("cf_") and len(token) > 40
        assert hash_token(token) == digest and token.startswith(prefix)


class TestUploads:
    def test_sniff(self):
        assert sniff_mime(b"\x89PNG\r\n\x1a\n" + b"0" * 10).mime == "image/png"
        assert sniff_mime(b"\x00\x00\x00\x18ftypmp42" + b"0" * 10).mime == "video/mp4"
        assert sniff_mime(b"\x00\x00\x00\x14ftypqt  " + b"0" * 10).mime == "video/quicktime"
        assert sniff_mime(b"MZ\x90\x00") is None

    def test_rejects(self):
        allowed = ["image/png"]
        with pytest.raises(UploadRejected):
            validate_upload(b"MZ\x90\x00", 10, max_bytes=100, allowed_mime=allowed)
        with pytest.raises(UploadRejected):
            validate_upload(b"\x89PNG\r\n\x1a\n", 1000, max_bytes=100, allowed_mime=allowed)
        with pytest.raises(UploadRejected):
            validate_upload(b"\xff\xd8\xff\xe0", 10, max_bytes=100, allowed_mime=allowed)
