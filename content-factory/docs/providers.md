# Внешние сервисы и адаптеры

Каждый сервис подключён отдельным адаптером с узким интерфейсом (`app/providers/*/base.py`). Выбор — в `app/orchestration/services.py` по переменным окружения. Без ключа сервис считается неподключённым: соответствующие шаги завершаются понятной ошибкой или ждут, но не имитируют результат.

| Функция | Адаптер | Интерфейс | Переменные |
|---|---|---|---|
| Языковая модель для всех агентов | Claude, официальный SDK `anthropic` (`messages.parse` со схемой Pydantic, серверный повтор на запасной модели при отказе классификатора) | `LLMProvider.structured`, `web_search` | `ANTHROPIC_API_KEY`, `LLM_MODEL`, `LLM_EFFORT` |
| Поиск | Claude web search (`web_search_20260209`); RSS-ленты (`rss_feeds` в настройках канала) | `SearchProvider.search` | `SEARCH_PROVIDERS` |
| Изображения | OpenAI Images API `POST /images/generations` | `ImageGenerator.generate` | `IMAGE_PROVIDER=openai`, `OPENAI_API_KEY`, `IMAGE_MODEL` |
| ИИ-видео | OpenAI Sora `POST /videos` → `GET /videos/{id}` → `GET /videos/{id}/content`; Runway `POST /v1/text_to_video` → `GET /v1/tasks/{id}` | `VideoGenerator.normalize/submit/status/download` | `VIDEO_PROVIDER`, `VIDEO_MODEL`, `RUNWAY_API_KEY` |
| Распознавание речи | OpenAI `POST /audio/transcriptions` (`verbose_json`, сегменты) | `Transcriber.transcribe` | `TRANSCRIPTION_PROVIDER=openai` |
| Орфография | Яндекс.Спеллер `checkText` | `SpellChecker.check` | `SPELLER_ENABLED` |
| Telegram | Bot API (свой клиент на httpx) | `TelegramBotClient` | `TELEGRAM_*` |
| Просмотры (необязательно) | MTProto через Telethon | `analytics/collector.collect_mtproto` | `MTPROTO_*` |
| Хранилище | S3 (boto3), локальный диск | `Storage` | `STORAGE_*`, `S3_*` |

Форматы запросов к OpenAI и Runway сверены с официальными SDK (`openai` 3.41: `types/video_create_params.py`, `video.py`; `runwayml` 5.24: `text_to_video`, `tasks`). Допустимые значения на момент разработки: Sora — длительность 4/8/12 с, размеры 720×1280 и 1280×720 (`sora-2-pro` — также 1024×1792, 1792×1024); Runway gen4.5 — 2–10 с, 1280:720 и 720:1280. Квадрат генерируется вертикально и кадрируется при монтаже. Поставщики меняют параметры — при ошибке 400 сверяйтесь с их документацией.

## Цены и бюджет

`config/pricing.yaml` — цены для оценки до вызова (за токены, поиск, изображение, секунду видео, минуту распознавания). Фактическая стоимость: Claude — по токенам из ответа; Runway — кредиты из задачи; Sora и изображения — по оценке (поставщик не возвращает сумму в ответе), такие записи помечены `cost_source=estimate` и видны в `/costs`. Сверяйте с счетами поставщиков и обновляйте файл без изменения кода.

## Доступность

Условия и географические ограничения поставщиков нужно проверить до запуска. Если API недоступен напрямую с сервера, можно указать `OUTBOUND_PROXY_URL` (используется адаптерами OpenAI, Runway и Telegram) — только если это допускается условиями поставщика. Для Claude используется стандартный клиент SDK (переменные `HTTPS_PROXY`).

## Как добавить поставщика

1. Реализуйте интерфейс из `base.py` нужной категории (например, `VideoGenerator` для нового видеогенератора) с разбором ошибок через `classify_http_status`: временные — `ProviderUnavailable`, окончательные — `ProviderRejected`, ключ — `ProviderNotConfigured`.
2. Добавьте цены в `config/pricing.yaml`.
3. Подключите в `build_services` по значению переменной окружения.
4. Добавьте тест с HTTP-моками по образцу `tests/unit/test_providers.py`.

Остальной код (агенты, бюджет, конвейер) менять не нужно.
