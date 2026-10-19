# Сервер аккаунтов Brookclean Trucks

PHP 7.4+ с SQLite (есть на хостинге Reg.ru). Даёт игре регистрацию и вход по логину и паролю,
облачное сохранение и мастер-дашборд с числом аккаунтов.

## Файлы
- `index.php` — API игры: `/index.php/auth/register`, `/auth/login`, `/auth/logout`, `/me`, `/save` (GET/PUT).
- `admin.php` — мастер-дашборд (вход: `ADMIN_LOGIN` / `ADMIN_PASSWORD` из `config.php`).
- `config.php` — настройки. **Пароль администратора задаётся только в копии на хостинге, в репозиторий его не коммитить.**
- `lib.php` — база. Файл базы создаётся сам уровнем выше папки сайта: `../brookclean-data/game.sqlite`.
- `.htaccess` — закрывает `config.php` и `lib.php`, передаёт заголовок `Authorization` в PHP.

## Установка на Reg.ru (ISPmanager)
1. «Сайты» → «Создать сайт» → имя `api.brookcleangame.online`, PHP включён. DNS-запись A для `api` создастся сама.
2. «Менеджер файлов» → папка сайта `www/api.brookcleangame.online/` → загрузить все файлы из `server/`
   (включая `.htaccess`).
3. Открыть `config.php` в менеджере файлов и вписать свой `ADMIN_PASSWORD`.
4. «SSL-сертификаты» → бесплатный Let's Encrypt для `api.brookcleangame.online`.
5. Проверка: `https://api.brookcleangame.online/index.php/ping` → `{"ok":true,...}`;
   дашборд — `https://api.brookcleangame.online/admin.php`.

Игра на `brookcleangame.online` сама обращается к `https://api.brookcleangame.online/index.php`.
