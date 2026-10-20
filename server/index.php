<?php
// API игры: /index.php/auth/register, /index.php/auth/login, /index.php/me, /index.php/save (GET, PUT), /index.php/auth/logout
require __DIR__ . '/lib.php';

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOWED_ORIGINS, true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Vary: Origin');
  header('Access-Control-Allow-Headers: Content-Type, Authorization');
  header('Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS');
  header('Access-Control-Max-Age: 86400');
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function out($data, int $code = 200) { http_response_code($code); echo json_encode($data, JSON_UNESCAPED_UNICODE); exit; }
function fail(string $msg, int $code = 400) { out(['error' => $msg], $code); }
function body(): array {
  $raw = file_get_contents('php://input', false, null, 0, 3 * 1024 * 1024);
  $d = json_decode($raw ?: '{}', true);
  return is_array($d) ? $d : [];
}
function ip(): string { return $_SERVER['REMOTE_ADDR'] ?? '?'; }
// не больше 10 неудачных входов с одного адреса за 10 минут
function throttle() {
  $db = db(); $since = time() - 600;
  $db->prepare('DELETE FROM fails WHERE at < ?')->execute([$since]);
  $q = $db->prepare('SELECT COUNT(*) FROM fails WHERE ip = ? AND at >= ?'); $q->execute([ip(), $since]);
  if ($q->fetchColumn() >= 10) fail('Слишком много попыток. Подождите 10 минут.', 429);
}
function failed() { db()->prepare('INSERT INTO fails (ip, at) VALUES (?, ?)')->execute([ip(), time()]); }
function issue(int $uid): string {
  $t = bin2hex(random_bytes(32)); $now = time();
  db()->prepare('INSERT INTO tokens (hash, user_id, created, expires) VALUES (?, ?, ?, ?)')->execute([hash('sha256', $t), $uid, $now, $now + TOKEN_DAYS * 86400]);
  return $t;
}
function me(): array {
  $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
  if (!$h && function_exists('getallheaders')) { foreach (getallheaders() as $k => $v) if (strtolower($k) === 'authorization') $h = $v; }
  if (!preg_match('/^Bearer\s+([a-f0-9]{64})$/i', $h, $m)) fail('Нужно войти', 401);
  $q = db()->prepare('SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND t.expires > ?');
  $q->execute([hash('sha256', $m[1]), time()]);
  $u = $q->fetch();
  if (!$u) fail('Вход устарел — войдите снова', 401);
  db()->prepare('UPDATE users SET last_seen = ? WHERE id = ?')->execute([time(), $u['id']]);
  return $u;
}
function pub(array $u): array { return ['id' => (int)$u['id'], 'login' => $u['login'], 'created' => (int)$u['created']]; }

$path = '/' . trim($_SERVER['PATH_INFO'] ?? ($_GET['r'] ?? ''), '/');
$method = $_SERVER['REQUEST_METHOD'];

try {
  if ($path === '/auth/register' && $method === 'POST') {
    throttle();
    $b = body(); $login = trim((string)($b['login'] ?? '')); $pass = (string)($b['password'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_.\-]{3,32}$/', $login)) fail('Логин: 3–32 символа, латинские буквы, цифры, точка, дефис, подчёркивание');
    if (mb_strlen($pass) < 6 || mb_strlen($pass) > 100) fail('Пароль: от 6 символов');
    $q = db()->prepare('SELECT id FROM users WHERE login = ?'); $q->execute([$login]);
    if ($q->fetch()) fail('Такой логин уже занят', 409);
    $now = time();
    db()->prepare('INSERT INTO users (login, pass, created, last_seen) VALUES (?, ?, ?, ?)')->execute([$login, password_hash($pass, PASSWORD_DEFAULT), $now, $now]);
    $uid = (int)db()->lastInsertId();
    out(['token' => issue($uid), 'user' => ['id' => $uid, 'login' => $login, 'created' => $now], 'new' => true]);
  }
  if ($path === '/auth/login' && $method === 'POST') {
    throttle();
    $b = body(); $login = trim((string)($b['login'] ?? '')); $pass = (string)($b['password'] ?? '');
    $q = db()->prepare('SELECT * FROM users WHERE login = ?'); $q->execute([$login]); $u = $q->fetch();
    if (!$u || !password_verify($pass, $u['pass'])) { failed(); fail('Неверный логин или пароль', 401); }
    db()->prepare('UPDATE users SET last_seen = ?, logins = logins + 1 WHERE id = ?')->execute([time(), $u['id']]);
    out(['token' => issue((int)$u['id']), 'user' => pub($u)]);
  }
  if ($path === '/auth/logout' && $method === 'POST') {
    $u = me(); $h = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/([a-f0-9]{64})/i', $h, $m)) db()->prepare('DELETE FROM tokens WHERE hash = ?')->execute([hash('sha256', $m[1])]);
    out(['ok' => true]);
  }
  if ($path === '/me' && $method === 'GET') { out(['user' => pub(me())]); }
  if ($path === '/save' && $method === 'GET') {
    $u = me();
    out(['save' => $u['save'] ? json_decode($u['save'], true) : null, 'at' => $u['save_at'] ? (int)$u['save_at'] : null]);
  }
  if ($path === '/save' && $method === 'PUT') {
    $u = me(); $b = body();
    if (!isset($b['save']) || !is_array($b['save'])) fail('Нет сохранения');
    $json = json_encode($b['save'], JSON_UNESCAPED_UNICODE);
    if (strlen($json) > 2 * 1024 * 1024) fail('Сохранение слишком большое', 413);
    db()->prepare('UPDATE users SET save = ?, save_at = ? WHERE id = ?')->execute([$json, time(), $u['id']]);
    out(['ok' => true]);
  }
  // рейтинг: результат игрока по режиму (после каждого рейса) и топ-50
  if ($path === '/score' && $method === 'PUT') {
    $u = me(); $b = body(); $mode = ($b['mode'] ?? '') === 'hard' ? 'hard' : 'easy';
    $n = fn($k, $max) => max(-$max, min($max, (int)($b[$k] ?? 0)));
    db()->prepare('INSERT INTO scores (user_id, mode, capital, best, fleet, trips, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, mode) DO UPDATE SET capital = excluded.capital, best = MAX(best, excluded.best), fleet = excluded.fleet, trips = excluded.trips, updated = excluded.updated')
      ->execute([$u['id'], $mode, $n('capital', 10_000_000_000), max(0, $n('best', 1_000_000_000)), max(1, min(10, $n('fleet', 10))), max(0, $n('trips', 1_000_000)), time()]);
    out(['ok' => true]);
  }
  if ($path === '/leaders' && $method === 'GET') {
    $u = me(); $mode = ($_GET['mode'] ?? '') === 'hard' ? 'hard' : 'easy';
    $by = in_array($_GET['by'] ?? '', ['capital', 'best', 'fleet', 'trips'], true) ? $_GET['by'] : 'capital';
    $q = db()->prepare("SELECT s.user_id, u.login, s.$by AS value FROM scores s JOIN users u ON u.id = s.user_id WHERE s.mode = ? ORDER BY s.$by DESC, s.updated ASC LIMIT 50");
    $q->execute([$mode]); $top = [];
    foreach ($q as $r) $top[] = ['login' => $r['login'], 'value' => (int)$r['value'], 'me' => (int)$r['user_id'] === (int)$u['id']];
    $mine = db()->prepare("SELECT $by FROM scores WHERE user_id = ? AND mode = ?"); $mine->execute([$u['id'], $mode]); $v = $mine->fetchColumn();
    $me = null;
    if ($v !== false) { $r = db()->prepare("SELECT COUNT(*) FROM scores WHERE mode = ? AND $by > ?"); $r->execute([$mode, $v]); $me = ['rank' => (int)$r->fetchColumn() + 1, 'value' => (int)$v]; }
    out(['top' => $top, 'me' => $me, 'by' => $by, 'mode' => $mode]);
  }
  if ($path === '/' || $path === '/ping') out(['ok' => true, 'service' => 'brookclean-trucks']);
  fail('Не найдено', 404);
} catch (Throwable $e) {
  error_log('brookclean api: ' . $e->getMessage());
  fail('Ошибка сервера', 500);
}
