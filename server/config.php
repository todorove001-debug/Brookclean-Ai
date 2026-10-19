<?php
// Настройки сервера Brookclean Trucks. Поменяйте ADMIN_PASSWORD перед загрузкой на хостинг!
const ADMIN_LOGIN = 'admin';
const ADMIN_PASSWORD = 'ПОМЕНЯЙТЕ-ЭТОТ-ПАРОЛЬ';
// Откуда игра может обращаться к серверу (адреса сайта с игрой)
const ALLOWED_ORIGINS = ['https://brookcleangame.online', 'https://www.brookcleangame.online', 'https://todorove001-debug.github.io'];
// База SQLite — уровнем выше папки сайта, чтобы её нельзя было скачать по ссылке (папка создастся сама)
const DB_PATH = __DIR__ . '/../brookclean-data/game.sqlite';
// Сколько дней живёт вход на устройстве
const TOKEN_DAYS = 180;
