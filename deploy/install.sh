#!/usr/bin/env bash
# Установка Brookclean на облачный сервер Reg.ru (Ubuntu 22.04/24.04), запускать от root из папки deploy:
#   cd /opt/brookclean/deploy && bash install.sh
# Скрипт можно запускать повторно: готовый .env он предложит оставить, контейнеры пересоберёт.
set -euo pipefail
cd "$(dirname "$0")"

say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
ask(){ local q="$1" def="${2:-}" v; read -r -p "$q${def:+ [$def]}: " v; echo "${v:-$def}"; }
ask_secret(){ local q="$1" v; read -r -s -p "$q: " v; echo >&2; echo "$v"; }

[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash install.sh"; exit 1; }

say "1/6 Docker и сетевой экран"
if ! command -v docker >/dev/null; then
  apt-get update -y && apt-get install -y curl ca-certificates
  curl -fsSL https://get.docker.com | sh
fi
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
fi
docker compose version >/dev/null || { echo "Нет docker compose — обновите Docker"; exit 1; }

say "2/6 Настройки (.env)"
if [ -f .env ] && [ "$(ask 'Файл .env уже есть. Оставить его? (д/н)' д)" = "д" ]; then
  echo "Оставляю текущий .env"
else
  client=$(ask "Домен для клиентов, например brookclean.ru")
  staff=$(ask "Поддомен для сотрудников" "crm.$client")
  bucket=$(ask "Бакет S3 (имя из личного кабинета Reg.ru)" "brookclean")
  region=$(ask "Регион S3 (как в личном кабинете)" "ru-1")
  akey=$(ask "S3 Access Key")
  skey=$(ask_secret "S3 Secret Key (ввод не отображается)")
  dbpass=$(openssl rand -hex 24)
  umask 077
  cat > .env <<EOF
CLIENT_DOMAIN=$client
STAFF_DOMAIN=$staff
DB_PASSWORD=$dbpass
S3_ENDPOINT=https://s3.regru.cloud
S3_REGION=$region
S3_BUCKET=$bucket
S3_ACCESS_KEY=$akey
S3_SECRET_KEY=$skey
S3_FORCE_PATH_STYLE=true
SESSION_DAYS=30
MAX_UPLOAD_MB=500
SMS_PROVIDER=console
EOF
  chmod 600 .env
  echo "Сохранено в deploy/.env (доступ только у root). Пароль базы сгенерирован."
fi
set -a; source .env; set +a

say "3/6 Проверка доменов"
ip=$(curl -fsS4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
for d in "$CLIENT_DOMAIN" "$STAFF_DOMAIN"; do
  got=$(getent ahostsv4 "$d" | awk 'NR==1{print $1}')
  if [ "$got" = "$ip" ]; then echo "  $d → $ip — ок"
  else echo "  ВНИМАНИЕ: $d указывает на '${got:-ничего}', а IP сервера $ip. Сертификат HTTPS не выпустится, пока A-запись не обновится."; fi
done

say "4/6 Сборка и запуск (первый раз 3–5 минут)"
docker compose up -d --build
echo "Жду запуска API…"
for i in $(seq 1 60); do
  if docker compose exec -T api node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
  sleep 3
done
if [ "${ok:-}" != 1 ]; then
  echo "API не ответил. Последние строки журнала:"; docker compose logs --tail 40 api
  echo "Частые причины: неверные ключи или имя бакета S3, неверный регион. Исправьте .env и запустите install.sh снова."
  exit 1
fi
echo "API работает, база и хранилище подключены."

say "5/6 Первый менеджер"
if [ "$(ask 'Создать (или обновить) учётную запись менеджера? (д/н)' д)" = "д" ]; then
  mphone=$(ask "Телефон менеджера, например 79001234567")
  mname=$(ask "ФИО" "Тодоров Евгений Константинович")
  mpass=$(ask_secret "Пароль (от 8 символов, ввод не отображается)")
  docker compose run --rm -e SEED_PHONE="$mphone" -e SEED_PASSWORD="$mpass" -e SEED_NAME="$mname" api node dist/db/seed.js
fi

say "6/6 Ночная копия базы в S3"
chmod +x backup.sh
line="30 3 * * * $(pwd)/backup.sh >> /var/log/brookclean-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'brookclean.*backup.sh' ; echo "$line" ) | crontab -
echo "Каждую ночь в 03:30 по времени сервера. Проверить сейчас: bash $(pwd)/backup.sh"

say "Готово"
echo "Проверка (сертификат выпускается в первые минуты после запуска):"
echo "  https://$CLIENT_DOMAIN/api/health  → {\"ok\":true}"
echo "  https://$STAFF_DOMAIN/api/health   → {\"ok\":true}"
echo "  https://$CLIENT_DOMAIN/api/orders  → 404 (служебные адреса закрыты на сайте клиентов)"
echo "Журнал API: cd $(pwd) && docker compose logs -f api"
