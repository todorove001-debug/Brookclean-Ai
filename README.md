# Brookclean · доставка автомобилей автовозом

Сайт для клиента в формате PWA: открывается по ссылке, ставится значком на экран телефона
(Android — кнопка «Установить», iPhone — «Поделиться → На экран „Домой“»).

Клиент вводит автомобиль (марка, VIN или номер кузова, год, цвет, стоимость) и город, сразу видит
расчёт (тариф + страховка 0,3%), заполняет данные для договора, читает договор и согласие на ПД,
подписывает кодом из SMS (ПЭП) и получает ссылку на трекинг автовоза.

## Устройство

| Папка | Что внутри |
|---|---|
| `shared/` | Тарифы, схема маршрута, расчёт, сумма прописью, проверка полей — общие для сайта и сервера |
| `server/` | Node.js 22 + Fastify + SQLite (`node:sqlite`). API заказов, подписи, трекинга, менеджера; отдаёт собранный сайт |
| `web/` | React + Vite + vite-plugin-pwa: манифест, иконки, service worker (трекинг открывается и без сети) |
| `deploy/` | Конфиги для VPS: systemd и nginx |

Сервер пересчитывает цену сам и не доверяет цене из браузера. Кэшбэк партнёра хранится на сервере
и прибавляется к перевозке; в ссылке партнёра только токен (`/?p=…`).
При подписи сохраняется журнал: телефон, время, IP, браузер и SHA-256 данных договора.
Код из SMS живёт 10 минут, 5 попыток ввода, повторная отправка не чаще раза в минуту.
Трекинг `/t/{токен}` показывает только авто, маршрут и положение — без ФИО и телефона.

## Запуск для разработки

```bash
npm install
npm run dev          # сервер :3000 и сайт :5173
npm test             # тесты расчёта, API и SMS
```

С `SMS_PROVIDER=console` (по умолчанию) SMS не уходят: код пишется в лог сервера, а в режиме
разработки ещё и показывается на экране подписи.

## SMS Aero

В `.env`: `SMS_PROVIDER=smsaero`, `SMSAERO_EMAIL`, `SMSAERO_API_KEY` (кабинет smsaero.ru → Настройки → API).
`SMSAERO_SIGN` — имя отправителя (например, `Brookclean`) после согласования в кабинете;
пока оно пустое, SMS идут от общей подписи «SMS Aero».

## API менеджера (временно, до кабинета)

Заголовок `Authorization: Bearer $ADMIN_TOKEN`.

- `GET /api/admin/orders` — все заказы
- `POST /api/admin/partner-links` `{partner, cashback}` — ссылка партнёра
- `PUT /api/admin/trips/R-01` `{dest, truck, loadDate}` — рейс
- `POST /api/admin/orders/685/trip` `{tripId}` — поставить машину в рейс
- `POST /api/admin/trips/R-01/position` `{city, note}` — отметить, где автовоз (видят все клиенты рейса)
- `POST /api/admin/orders/685/status` `{status}` — `paid`, `delivered` и т.д.

## Размещение на Reg.ru (brookclean-reg.ru)

Нужен **Cloud VPS** (Ubuntu 24.04, 1 ядро / 1–2 ГБ на старт), а не виртуальный хостинг.

```bash
# на сервере
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs nginx certbot python3-certbot-nginx git
sudo useradd -r -m -d /opt/brookclean brookclean
sudo -u brookclean git clone https://github.com/todorove001-debug/Brookclean-Ai /opt/brookclean
cd /opt/brookclean && sudo -u brookclean npm ci && sudo -u brookclean npm run build
sudo -u brookclean cp .env.example .env   # заполнить ADMIN_TOKEN и ключи SMS Aero
sudo cp deploy/brookclean.service /etc/systemd/system/ && sudo systemctl enable --now brookclean
sudo cp deploy/nginx.conf /etc/nginx/sites-available/brookclean && sudo ln -s ../sites-available/brookclean /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d brookclean-reg.ru -d www.brookclean-reg.ru
```

В панели Reg.ru у домена — A-записи `@` и `www` на IP сервера. PWA работает только по HTTPS,
поэтому шаг с certbot обязателен.

## Что ещё не сделано

- PDF договора и согласия (отдельная задача)
- Кабинет менеджера и приёмщика, выгрузка в таблицу
- Оплата онлайн, push-уведомления о движении автовоза
- Шрифты сейчас грузятся с Google Fonts — перед запуском лучше положить их на свой сервер
