import base64
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import respx
from pydantic import BaseModel

from app.providers.base import ProviderNotConfigured, ProviderRejected, ProviderUnavailable
from app.providers.image.base import OpenAIImageGenerator
from app.providers.llm.anthropic_provider import FALLBACK_BETA, AnthropicProvider
from app.providers.speech.base import OpenAITranscriber
from app.providers.spelling.base import YandexSpeller
from app.providers.telegram.client import InputFile, TelegramBotClient, TelegramError, inline_keyboard
from app.providers.video.base import OpenAISoraGenerator, RunwayGenerator, VideoRequest, VideoStatus

TOKEN = "123456789:" + "A" * 35


class TestTelegramClient:
    @respx.mock
    async def test_send_message_ok(self):
        route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(
            return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 7}}))
        client = TelegramBotClient(TOKEN)
        result = await client.send_message("@chan", "<b>Привет</b>")
        body = json.loads(route.calls[0].request.content)
        assert result["message_id"] == 7
        assert body == {"chat_id": "@chan", "text": "<b>Привет</b>", "parse_mode": "HTML", "link_preview_options": {"is_disabled": True}}

    @respx.mock
    async def test_error_with_retry_after(self):
        respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(return_value=httpx.Response(
            429, json={"ok": False, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 17}}))
        with pytest.raises(TelegramError) as exc:
            await TelegramBotClient(TOKEN).send_message(1, "x")
        assert exc.value.error_code == 429 and exc.value.retry_after == 17 and exc.value.retryable

    @respx.mock
    async def test_connect_error_marks_not_sent(self):
        respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(side_effect=httpx.ConnectError("boom"))
        with pytest.raises(TelegramError) as exc:
            await TelegramBotClient(TOKEN).send_message(1, "x")
        assert exc.value.request_sent is False and "bot" not in str(exc.value)

    @respx.mock
    async def test_read_timeout_marks_maybe_sent(self):
        respx.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage").mock(side_effect=httpx.ReadTimeout("slow"))
        with pytest.raises(TelegramError) as exc:
            await TelegramBotClient(TOKEN).send_message(1, "x")
        assert exc.value.request_sent is True

    @respx.mock
    async def test_send_video_multipart(self):
        route = respx.post(f"https://api.telegram.org/bot{TOKEN}/sendVideo").mock(
            return_value=httpx.Response(200, json={"ok": True, "result": {"message_id": 9}}))
        await TelegramBotClient(TOKEN).send_video("@c", InputFile("v.mp4", b"data", "video/mp4"), caption="cap",
                                                  thumbnail=InputFile("t.jpg", b"jpg", "image/jpeg"))
        content = route.calls[0].request.content
        assert b'name="video"; filename="v.mp4"' in content and b"attach://thumbnail" in content

    def test_callback_data_limit(self):
        with pytest.raises(ValueError):
            inline_keyboard([[("x", "a" * 65)]])


class TestSora:
    @respx.mock
    async def test_submit_status_download(self, tmp_path: Path):
        create = respx.post("https://api.openai.com/v1/videos").mock(return_value=httpx.Response(200, json={"id": "video_1", "status": "queued"}))
        respx.get("https://api.openai.com/v1/videos/video_1").mock(return_value=httpx.Response(200, json={"id": "video_1", "status": "completed", "progress": 100}))
        respx.get("https://api.openai.com/v1/videos/video_1/content").mock(return_value=httpx.Response(200, content=b"mp4data"))
        gen = OpenAISoraGenerator(api_key="sk-test", model="sora-2")
        req = gen.normalize(VideoRequest(prompt="truck", duration_s=7, aspect="1:1"))
        assert req.duration_s == 8 and req.size == "720x1280" and req.notes
        sub = await gen.submit(req)
        form = create.calls[0].request.content
        assert b'name="seconds"' in form and b"720x1280" in form and sub.provider_job_id == "video_1"
        status = await gen.status("video_1")
        assert status.state == "succeeded"
        size = await gen.download("video_1", status, tmp_path / "v.mp4", max_bytes=100)
        assert size == 7

    @respx.mock
    async def test_status_mapping_and_errors(self):
        respx.get("https://api.openai.com/v1/videos/v").mock(return_value=httpx.Response(200, json={"status": "failed", "error": {"code": "moderation", "message": "blocked"}}))
        gen = OpenAISoraGenerator(api_key="sk-test")
        s = await gen.status("v")
        assert s.state == "failed" and s.error_code == "moderation"
        respx.post("https://api.openai.com/v1/videos").mock(return_value=httpx.Response(503, json={"error": {"message": "overloaded"}}))
        with pytest.raises(ProviderUnavailable):
            await gen.submit(gen.normalize(VideoRequest(prompt="x", duration_s=4, aspect="9:16")))

    @respx.mock
    async def test_bad_key(self):
        respx.post("https://api.openai.com/v1/videos").mock(return_value=httpx.Response(401, json={"error": {"message": "bad key"}}))
        gen = OpenAISoraGenerator(api_key="sk-bad")
        with pytest.raises(ProviderNotConfigured):
            await gen.submit(gen.normalize(VideoRequest(prompt="x", duration_s=4, aspect="9:16")))


class TestRunway:
    @respx.mock
    async def test_submit_and_task(self):
        create = respx.post("https://api.dev.runwayml.com/v1/text_to_video").mock(
            return_value=httpx.Response(200, json={"id": "task1", "estimatedCost": {"credits": 60}}))
        respx.get("https://api.dev.runwayml.com/v1/tasks/task1").mock(return_value=httpx.Response(200, json={
            "id": "task1", "status": "SUCCEEDED", "output": ["https://cdn.example/out.mp4"], "cost": {"credits": 50}}))
        gen = RunwayGenerator(api_key="key", model="gen4.5")
        req = gen.normalize(VideoRequest(prompt="p" * 2000, duration_s=12.4, aspect="16:9"))
        assert req.duration_s == 10 and req.size == "1280:720" and len(req.prompt) == 1000
        sub = await gen.submit(req)
        request = create.calls[0].request
        assert request.headers["X-Runway-Version"] == "2024-11-06"
        assert json.loads(request.content) == {"model": "gen4.5", "promptText": "p" * 1000, "ratio": "1280:720", "duration": 10}
        assert sub.estimated_cost_credits == 60
        status = await gen.status("task1")
        assert status.state == "succeeded" and status.cost_credits == 50 and status.output_urls

    async def test_download_rejects_private_output_url(self, tmp_path: Path):
        gen = RunwayGenerator(api_key="key")
        with pytest.raises(ProviderRejected):
            await gen.download("t", VideoStatus(state="succeeded", output_urls=["http://169.254.169.254/latest"]), tmp_path / "x.mp4", max_bytes=10)


class TestOtherAdapters:
    @respx.mock
    async def test_images(self):
        png = base64.b64encode(b"\x89PNG....").decode()
        route = respx.post("https://api.openai.com/v1/images/generations").mock(return_value=httpx.Response(200, json={"data": [{"b64_json": png}], "usage": {"input_tokens": 10}}))
        img = await OpenAIImageGenerator(api_key="k", model="gpt-image-2").generate("truck", aspect="16:9")
        assert img.data.startswith(b"\x89PNG") and img.size == "1536x1024"
        assert json.loads(route.calls[0].request.content)["size"] == "1536x1024"

    @respx.mock
    async def test_transcriber(self, tmp_path: Path):
        audio = tmp_path / "a.mp3"
        audio.write_bytes(b"ID3fake")
        route = respx.post("https://api.openai.com/v1/audio/transcriptions").mock(return_value=httpx.Response(200, json={
            "language": "russian", "duration": 3.5, "text": "Привет", "segments": [{"start": 0.0, "end": 1.2, "text": " Привет "}]}))
        t = await OpenAITranscriber(api_key="k").transcribe(audio)
        assert t.segments[0].text == "Привет" and t.duration_s == 3.5
        body = route.calls[0].request.content
        assert b"verbose_json" in body and b"timestamp_granularities[]" in body

    @respx.mock
    async def test_speller(self):
        respx.post("https://speller.yandex.net/services/spellservice.json/checkText").mock(return_value=httpx.Response(200, json=[
            {"code": 1, "pos": 5, "row": 0, "col": 5, "len": 7, "word": "машына", "s": ["машина"]}]))
        issues = await YandexSpeller("https://speller.yandex.net/services/spellservice.json/checkText").check("Наша машына")
        assert issues[0].word == "машына" and issues[0].suggestions == ["машина"]


class Answer(BaseModel):
    text: str


class FakeMessages:
    def __init__(self, responses):
        self.responses = list(responses)
        self.kwargs = []

    async def parse(self, **kwargs):
        self.kwargs.append(kwargs)
        return self.responses.pop(0)

    async def create(self, **kwargs):
        self.kwargs.append(kwargs)
        return self.responses.pop(0)


def usage(**kw):
    return SimpleNamespace(input_tokens=10, output_tokens=5, cache_read_input_tokens=0, cache_creation_input_tokens=0,
                           server_tool_use=SimpleNamespace(web_search_requests=kw.get("searches", 0), web_fetch_requests=0))


class TestAnthropicAdapter:
    async def test_structured(self):
        messages = FakeMessages([SimpleNamespace(stop_reason="end_turn", parsed_output=Answer(text="ok"), usage=usage(), model="claude-opus-5-5")])
        provider = AnthropicProvider(api_key=None, model="claude-opus-5-5", client=SimpleNamespace(beta=SimpleNamespace(messages=messages)))
        result = await provider.structured(system="sys", prompt="hi", schema=Answer)
        assert result.data.text == "ok" and result.usage.input_tokens == 10
        sent = messages.kwargs[0]
        assert sent["output_format"] is Answer and sent["betas"] == [FALLBACK_BETA] and sent["fallbacks"] == "default"
        assert "temperature" not in sent and sent["system"][0]["cache_control"] == {"type": "ephemeral"}

    async def test_refusal_and_truncation(self):
        refusal = SimpleNamespace(stop_reason="refusal", stop_details=SimpleNamespace(category="cyber"), parsed_output=None, usage=usage())
        provider = AnthropicProvider(api_key=None, model="m", client=SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages([refusal]))))
        with pytest.raises(ProviderRejected):
            await provider.structured(system="s", prompt="p", schema=Answer)
        cut = SimpleNamespace(stop_reason="max_tokens", parsed_output=None, usage=usage())
        provider = AnthropicProvider(api_key=None, model="m", client=SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages([cut]))))
        with pytest.raises(ProviderRejected):
            await provider.structured(system="s", prompt="p", schema=Answer)

    async def test_web_search_collects_hits_across_pause(self):
        hit = SimpleNamespace(url="https://pravo.gov.ru/a", title="Закон", page_age="March 1, 2026")
        first = SimpleNamespace(stop_reason="pause_turn", usage=usage(searches=1), model="m",
                                content=[SimpleNamespace(type="web_search_tool_result", content=[hit])])
        second = SimpleNamespace(stop_reason="end_turn", usage=usage(searches=1), model="m",
                                 content=[SimpleNamespace(type="text", text="Нашёл")])
        provider = AnthropicProvider(api_key=None, model="m", client=SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages([first, second]))))
        result = await provider.web_search(query="q", instructions="i")
        assert [h.url for h in result.hits] == ["https://pravo.gov.ru/a"] and result.usage.web_search_requests == 2

    def test_requires_key(self):
        with pytest.raises(ProviderNotConfigured):
            AnthropicProvider(api_key=None, model="m")
