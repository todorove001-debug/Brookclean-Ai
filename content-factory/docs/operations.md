# Эксплуатация

## Требования к серверу

2 vCPU, 4 ГБ памяти (рендер видео — основная нагрузка), 30+ ГБ диска под базу и временные файлы монтажа; Docker с Compose. Медиа хранятся в S3.

## Первый запуск

```bash
cd content-factory
bash scripts/setup.sh          # создаст .env с паролем базы
nano .env                      # ключи, Telegram, S3
bash scripts/setup.sh          # сборка, миграции, проверка, запуск, токен владельца
```

Обратный прокси (пример для Caddy, рядом с основным сайтом):

```
content.example.ru {
	encode gzip
	request_body {
		max_size 1100MB
	}
	reverse_proxy 127.0.0.1:8000
}
```

`PUBLIC_BASE_URL` должен совпадать с этим адресом: на него ведут отслеживаемые ссылки в постах (`/r/<код>`) и вебхук Telegram.

Режим вебхука: `TELEGRAM_MODE=webhook`, `TELEGRAM_WEBHOOK_SECRET=<случайная строка>`. API при старте регистрирует вебхук; запросы без правильного заголовка `X-Telegram-Bot-Api-Secret-Token` отклоняются.

## Резервное копирование

**База.** `factory backup create` делает `pg_dump` в формате custom и кладёт файл в хранилище (`S3_BACKUP_PREFIX/db/factory-<время>.dump`). Ежедневно по cron:

```
30 3 * * * cd /opt/brookclean/content-factory && bash scripts/backup.sh >> /var/log/content-factory-backup.log 2>&1
```

Список копий: `docker compose run --rm api factory backup list`.

**Медиа.** Файлы уже лежат в S3 и не перезаписываются (ключи уникальны, оригиналы неизменяемы). Включите версионирование бакета, если хранилище его поддерживает, и правило жизненного цикла для `backups/` (например, хранить 30 дней). Для копии в другое хранилище подойдёт `rclone sync s3:brookclean-content backup:brookclean-content`.

**Секреты.** Храните копию `.env` отдельно от сервера (менеджер паролей). Без него восстановленная база бесполезна: в ней нет ключей.

## Восстановление

```bash
docker compose run --rm api factory backup list
bash scripts/restore.sh backups/db/factory-20261101T033000Z.dump
```

Скрипт останавливает процессы, выполняет `pg_restore --clean --single-transaction` и запускает систему. Проверьте `factory check` и `/health/ready`. Задания публикации, которые были в статусе `sending` в момент копии, через 15 минут получат статус `uncertain`, а владелец — уведомление: сверьте канал вручную, автоматического повтора нет.

Проверяйте восстановление раз в квартал на отдельном сервере или базе.

## Обновление

```bash
cd /opt/brookclean && git pull
cd content-factory
bash scripts/backup.sh                  # копия перед обновлением
docker compose build
docker compose run --rm migrate          # миграции
docker compose up -d                     # перезапуск процессов
docker compose ps && curl -s http://127.0.0.1:8000/health/ready
```

Процессы останавливаются по SIGTERM: worker дожидается окончания шага; незавершённые задачи после истечения аренды подхватит другой процесс. Публикация в момент остановки защищена статусом `sending`.

Откат: верните предыдущий коммит, `docker compose build && docker compose up -d`. Если миграция несовместима, восстановите базу из копии, сделанной перед обновлением.

## Мониторинг

- `/health/live` — процесс жив; `/health/ready` — база, хранилище, FFmpeg (503 при сбое), плюс какие поставщики подключены.
- `/metrics` — Prometheus: задачи (`cf_tasks_total`, `cf_task_seconds`), вызовы и расходы внешних API (`cf_provider_calls_total`, `cf_provider_cost_usd_total`), публикации (`cf_publications_total`), глубина очереди, материалы по статусам. С `METRICS_TOKEN` требует Bearer-токен.
- Логи — JSON в stdout (`docker compose logs -f worker`), секреты вырезаются.
- Sentry — `SENTRY_DSN`, без персональных данных.
- Владельцу в Telegram приходят: остановленные задачи, ошибки публикации, пороги и остановка бюджета, недельный отчёт. Команды `/errors` и `/costs`.

## Частые проблемы

| Симптом | Что проверить |
|---|---|
| Черновики не приходят | `docker compose logs bot worker`; совпадает ли ваш Telegram ID с `factory users`; написали ли вы боту `/start`. |
| Публикация `failed` с «Forbidden» | Бот не администратор канала или нет права публикации. |
| Видео не отправляется | Файл больше 50 МБ — лимит Bot API. Уменьшите длительность или поднимите локальный Bot API сервер и `TELEGRAM_API_BASE`, `TELEGRAM_MAX_UPLOAD_MB`. |
| Материалы «висят» в `media_generation` | `/status <id>` в боте: задания ИИ-видео в `waiting_provider` (сервис недоступен) или `waiting_budget` (лимит). Повтор — `POST /api/v1/video-jobs/{id}/retry`. |
| «ожидает бюджета» | Лимиты в `/api/v1/budget` или панели «Бюджет». |
