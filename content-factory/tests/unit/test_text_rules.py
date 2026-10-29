from app.agents.qa import check_claims, check_forbidden, check_length, check_readability
from app.approval.render import parse_local_time, parse_video_params
from app.content.service import similarity, title_similarity
from app.database.models import ContentVersion


def version(**kw):
    defaults = {"title": "Заголовок", "body_html": "Текст " * 30, "hashtags": [], "poll": None}
    return ContentVersion(**{**defaults, **kw})


class TestClaims:
    def test_company_price_without_fact_is_blocking(self):
        findings = check_claims("Мы перевезём вашу машину за 90 000 рублей.", supported_text="", item_format="short_post")
        assert any(f.code == "unsupported_company_claim" and f.severity == "blocking" for f in findings)

    def test_supported_price_passes(self):
        text = "Перевозка седана Владивосток — Москва стоит от 150 000 рублей."
        findings = check_claims(text, supported_text="Перевозка седана стоит от 150 000 рублей.", item_format="ad")
        assert not [f for f in findings if f.code == "unsupported_company_claim"]

    def test_external_number_needs_manual_check(self):
        findings = check_claims("Пошлина выросла на 12%.", supported_text="", item_format="short_post")
        assert findings and findings[0].severity == "manual_check"

    def test_guarantee_and_reviews(self):
        findings = check_claims("Мы гарантируем доставку. Клиент рассказал, что всё отлично.", supported_text="", item_format="short_post")
        codes = [(f.code, f.severity) for f in findings]
        assert ("unsupported_company_claim", "blocking") in codes
        assert sum(1 for c in codes if c[0] == "unsupported_company_claim") >= 2

    def test_superlatives(self):
        findings = check_claims("Это самый надёжный способ.", supported_text="", item_format="short_post")
        assert any(f.code == "advertising_claim" for f in findings)

    def test_forbidden(self):
        assert check_forbidden("Мы — номер один на рынке", ["номер один"])


class TestLength:
    def test_caption_limit_for_video(self):
        assert any(f.code == "length" and f.severity == "blocking" for f in check_length("video", version(body_html="а" * 1100)))
        assert not [f for f in check_length("short_post", version(body_html="а " * 900)) if f.severity == "blocking"]

    def test_message_limit(self):
        assert any(f.severity == "blocking" for f in check_length("article", version(body_html="б" * 4200)))

    def test_poll(self):
        bad = version(poll={"question": "Как?", "options": ["Да"]})
        assert check_length("poll", bad)[0].code == "poll_format"
        good = version(poll={"question": "Как вы везёте машину?", "options": ["Автовоз", "Сам", "Поезд"]})
        assert check_length("poll", good) == []

    def test_readability(self):
        long_sentence = " ".join(["слово"] * 40) + "."
        assert check_readability(long_sentence)[0].code == "readability"


def test_similarity():
    a = "Как подготовить автомобиль к перевозке автовозом"
    b = "Как подготовить автомобиль к перевозке на автовозе"
    assert title_similarity(a, b) > 0.7
    assert similarity("Погрузка машины на автовоз зимой", "Растаможка автомобиля из Японии") < 0.1


def test_parse_video_params():
    p = parse_video_params("Формат 1:1, длительность 20, без ИИ, спокойнее и больше трассы")
    assert p["aspect"] == "1:1" and p["duration_s"] == 20 and p["no_ai"] is True
    assert "трассы" in p["style"]


def test_parse_local_time():
    from datetime import UTC, datetime

    now = datetime(2026, 11, 2, 10, 0, tzinfo=UTC)  # 13:00 МСК
    dt = parse_local_time("25.11 14:30", "Europe/Moscow", now)
    assert dt.isoformat() == "2026-11-25T14:30:00+03:00"
    assert parse_local_time("завтра 09:15", "Europe/Moscow", now).isoformat() == "2026-11-03T09:15:00+03:00"
    assert parse_local_time("12:00", "Europe/Moscow", now).day == 3  # уже прошло сегодня — завтра
    assert parse_local_time("в полдень", "Europe/Moscow", now) is None
