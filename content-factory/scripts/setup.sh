#!/usr/bin/env bash
# Первоначальная настройка контент-фабрики на сервере с Docker.
# Запуск из каталога content-factory: bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Нужен Docker: https://docs.docker.com/engine/install/"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  password=$(openssl rand -hex 24)
  sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=${password}/" .env
  echo "Создан .env с паролем базы. Заполните ключи и Telegram ID, затем запустите скрипт снова:"
  echo "  nano .env"
  exit 0
fi

set -a; . ./.env; set +a
missing=()
for var in TELEGRAM_BOT_TOKEN TELEGRAM_CHANNEL_ID BOOTSTRAP_OWNER_TELEGRAM_IDS ANTHROPIC_API_KEY; do
  [ -n "${!var:-}" ] || missing+=("$var")
done
if [ "${STORAGE_BACKEND:-local}" = "s3" ]; then
  for var in S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY; do [ -n "${!var:-}" ] || missing+=("$var"); done
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "В .env не заполнено: ${missing[*]}"
  exit 1
fi

docker compose build
docker compose up -d db
docker compose run --rm migrate
docker compose run --rm api factory check
docker compose up -d

owner_id="${BOOTSTRAP_OWNER_TELEGRAM_IDS%%,*}"
echo
echo "API-токен владельца для веб-панели (${PUBLIC_BASE_URL}/admin/):"
docker compose run --rm api factory create-user --name "Владелец" --role owner --telegram-id "$owner_id"
docker compose run --rm api factory issue-token --telegram-id "$owner_id"
echo
docker compose run --rm api factory stories load
echo "Сведения о компании (✔ — утверждены, ✗ — ждут вашего решения):"
docker compose run --rm api factory facts list
echo "Утвердить: docker compose run --rm api factory facts approve <ключ> ..."
echo
echo "Ежедневная резервная копия базы (cron):"
echo "  30 3 * * * cd $(pwd) && docker compose run --rm api factory backup create >> /var/log/content-factory-backup.log 2>&1"
echo
echo "Готово. Напишите боту /help из аккаунта владельца."
