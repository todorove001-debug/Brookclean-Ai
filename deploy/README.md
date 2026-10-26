# Развёртывание на сервере Reg.ru

На одном облачном сервере работают три контейнера: база PostgreSQL, API Brookclean и Caddy. Caddy принимает HTTPS, сам выпускает сертификаты Let's Encrypt и раздаёт два сайта:

- **основной домен** (`CLIENT_DOMAIN`, например `brookclean.ru`) — для клиентов и партнёров. Входа для сотрудников там нет, служебные адреса API закрыты;
- **поддомен** (`STAFF_DOMAIN`, например `crm.brookclean.ru`) — для менеджера, водителей и приёмщиков. Поисковики его не индексируют.

Фото, видео, подписи и копии базы хранятся в объектном хранилище S3 Reg.ru. Серверы Reg.ru находятся в России, что подходит под 152-ФЗ.

## 1. Что заказать в Reg.ru

1. **Облачный сервер.** Ubuntu 24.04, 2 vCPU, 4 ГБ памяти, диск 40–60 ГБ. На диске только база и система, файлы лежат в S3.
2. **Объектное хранилище S3.**
   - Создайте **приватный** бакет, например `brookclean`.
   - Выпустите ключи доступа: Access Key и Secret Key.
   - Адрес хранилища: `https://s3.regru.cloud`.
3. **Домен и поддомен.** В DNS добавьте две A-записи на IP облачного сервера: для основного домена (`brookclean.ru`) и для поддомена сотрудников (`crm.brookclean.ru`). Название поддомена можно выбрать любое.

## 2. Подготовка сервера

```bash
ssh root@IP_СЕРВЕРА
apt update && apt upgrade -y
curl -fsSL https://get.docker.com | sh
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
git clone https://github.com/todorove001-debug/Brookclean-Ai.git /opt/brookclean
cd /opt/brookclean/deploy
cp .env.example .env
nano .env
```

Что заполнить в `.env`:

- `CLIENT_DOMAIN` — домен для клиентов, `STAFF_DOMAIN` — поддомен для сотрудников.
- `DB_PASSWORD` — длинный случайный пароль: `openssl rand -hex 24`.
- `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` — из личного кабинета Reg.ru.
- `S3_REGION` — если в личном кабинете указан другой регион, впишите его.

## 3. Запуск

```bash
docker compose up -d --build
docker compose logs -f api        # «миграция применена», затем «Server listening»
```

При старте API проверяет, что бакет доступен с этими ключами. Если ключи или бакет неверные, в логе будет ошибка, и API не запустится.

Первый менеджер:

```bash
docker compose run --rm -e SEED_PHONE=79001234567 -e SEED_PASSWORD='надёжный-пароль' -e SEED_NAME='Тодоров Евгений Константинович' api node dist/db/seed.js
```

Проверка:

- `https://CLIENT_DOMAIN/api/health` и `https://STAFF_DOMAIN/api/health` возвращают `{"ok":true}`;
- `https://CLIENT_DOMAIN/api/orders` возвращает 404: адреса сотрудников с клиентского сайта закрыты.

Менеджер входит на сайте сотрудников.

## 4. Резервные копии базы

Скрипт `backup.sh` выгружает базу в тот же бакет, в папку `backups/`. Чтобы он запускался каждую ночь:

```bash
crontab -e
# добавить строку:
30 3 * * * /opt/brookclean/deploy/backup.sh >> /var/log/brookclean-backup.log 2>&1
```

Старые копии можно удалять автоматически правилом жизненного цикла бакета для папки `backups/`, если хранилище это поддерживает, или вручную раз в месяц.

## 5. Обновление

```bash
cd /opt/brookclean && git pull
cd deploy && docker compose up -d --build api
```

Новые миграции базы применяются сами при старте API.
