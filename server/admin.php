<?php
// Мастер-дашборд: сколько аккаунтов создано, кто активен, регистрации по дням. Вход — ADMIN_LOGIN / ADMIN_PASSWORD из config.php
require __DIR__ . '/lib.php';
session_start([ 'cookie_httponly' => true, 'cookie_samesite' => 'Strict', 'cookie_secure' => !empty($_SERVER['HTTPS']) ]);
header('Cache-Control: no-store');
header('X-Frame-Options: DENY');
$h = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');

if (isset($_GET['logout'])) { $_SESSION = []; session_destroy(); header('Location: admin.php'); exit; }
$err = '';
if (($_POST['do'] ?? '') === 'login') {
  $okPass = ADMIN_PASSWORD !== 'ПОМЕНЯЙТЕ-ЭТОТ-ПАРОЛЬ' && hash_equals(ADMIN_PASSWORD, (string)($_POST['password'] ?? ''));
  if (hash_equals(ADMIN_LOGIN, (string)($_POST['login'] ?? '')) && $okPass) { session_regenerate_id(true); $_SESSION['admin'] = true; header('Location: admin.php'); exit; }
  sleep(1);
  $err = ADMIN_PASSWORD === 'ПОМЕНЯЙТЕ-ЭТОТ-ПАРОЛЬ' ? 'Сначала задайте свой пароль в config.php (ADMIN_PASSWORD).' : 'Неверный логин или пароль';
}
$authed = !empty($_SESSION['admin']);

$stats = null;
if ($authed) {
  $db = db(); $now = time(); $day0 = strtotime('today');
  $one = fn($sql, $a = []) => (function () use ($db, $sql, $a) { $q = $db->prepare($sql); $q->execute($a); return (int)$q->fetchColumn(); })();
  $stats = [
    'total' => $one('SELECT COUNT(*) FROM users'),
    'today' => $one('SELECT COUNT(*) FROM users WHERE created >= ?', [$day0]),
    'd7' => $one('SELECT COUNT(*) FROM users WHERE created >= ?', [$now - 7 * 86400]),
    'd30' => $one('SELECT COUNT(*) FROM users WHERE created >= ?', [$now - 30 * 86400]),
    'act1' => $one('SELECT COUNT(*) FROM users WHERE last_seen >= ?', [$now - 86400]),
    'act7' => $one('SELECT COUNT(*) FROM users WHERE last_seen >= ?', [$now - 7 * 86400]),
    'saves' => $one('SELECT COUNT(*) FROM users WHERE save IS NOT NULL'),
  ];
  // регистрации по дням за 30 дней
  $byDay = [];
  for ($i = 29; $i >= 0; $i--) $byDay[date('Y-m-d', $day0 - $i * 86400)] = 0;
  $q = $db->prepare('SELECT created FROM users WHERE created >= ?'); $q->execute([$day0 - 29 * 86400]);
  foreach ($q as $r) { $k = date('Y-m-d', (int)$r['created']); if (isset($byDay[$k])) $byDay[$k]++; }
  $max = max(1, max($byDay));
  $leaders = $db->query("SELECT u.login, s.mode, s.capital, s.best, s.fleet, s.trips FROM scores s JOIN users u ON u.id = s.user_id ORDER BY s.capital DESC LIMIT 10")->fetchAll();
  // последние аккаунты и их прогресс из сохранения
  $users = $db->query('SELECT id, login, created, last_seen, logins, save, save_at FROM users ORDER BY id DESC LIMIT 200')->fetchAll();
  if (isset($_GET['csv'])) {
    header('Content-Type: text/csv; charset=utf-8'); header('Content-Disposition: attachment; filename="brookclean-accounts.csv"');
    $f = fopen('php://output', 'w'); fwrite($f, "\xEF\xBB\xBF"); fputcsv($f, ['id', 'login', 'created', 'last_seen', 'logins'], ';');
    foreach ($db->query('SELECT id, login, created, last_seen, logins FROM users ORDER BY id') as $r) fputcsv($f, [$r['id'], $r['login'], date('Y-m-d H:i', $r['created']), date('Y-m-d H:i', $r['last_seen']), $r['logins']], ';');
    exit;
  }
}
$prog = function ($json) {
  $s = $json ? json_decode($json, true) : null; if (!$s) return ['—', '—'];
  $trips = 0; $bal = null;
  foreach (['easy', 'hard'] as $m) if (!empty($s[$m]['stats'])) { $trips += ($s[$m]['stats']['trips'] ?? 0) + ($s[$m]['stats']['empty'] ?? 0); }
  $m = $s['mode'] ?? 'easy'; if (isset($s[$m]['balance'])) $bal = $s[$m]['balance'];
  return [$trips, $bal === null ? '—' : number_format($bal, 0, ',', ' ') . ' ₽'];
};
$dt = fn($t) => $t ? date('d.m.Y H:i', (int)$t) : '—';
?><!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Brookclean — мастер-дашборд</title>
<style>
:root{--bg:#F3F5F8;--card:#fff;--ink:#16202A;--ink2:#5B6875;--line:#DDE3EA;--acc:#F2A21B;--ok:#1F8A4C}
@media (prefers-color-scheme:dark){:root{--bg:#11161C;--card:#1A2129;--ink:#E8EDF2;--ink2:#9AA7B4;--line:#2C3642}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:20px 16px}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--ink2);font-size:13px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px}
.tile b{display:block;font-size:30px;line-height:1.1;margin-top:4px}.tile.main{border-color:var(--acc);box-shadow:0 3px 0 var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:16px;overflow-x:auto}
.bars{display:flex;align-items:flex-end;gap:3px;height:140px;padding-top:8px}
.bars div{flex:1;background:var(--acc);border-radius:3px 3px 0 0;min-height:2px;position:relative}
.bars div span{position:absolute;top:-17px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--ink2)}
.axis{display:flex;justify-content:space-between;font-size:11px;color:var(--ink2);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--ink2);font-weight:600}
a.btn,button{display:inline-block;background:var(--acc);color:#1B1300;border:0;border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
a.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
form.login{max-width:340px;margin:12vh auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;display:grid;gap:12px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:var(--bg);color:var(--ink)}
.err{color:#C6372B;font-size:14px}
</style></head><body><main>
<?php if (!$authed): ?>
  <form class="login" method="post" autocomplete="off">
    <h1>Мастер-дашборд</h1><span class="muted">Brookclean Trucks · вход администратора</span>
    <input type="hidden" name="do" value="login">
    <label>Логин<input name="login" required autofocus></label>
    <label>Пароль<input name="password" type="password" required></label>
    <?php if ($err): ?><div class="err"><?= $h($err) ?></div><?php endif; ?>
    <button type="submit">Войти</button>
  </form>
<?php else: ?>
  <div class="top"><div><h1>Мастер-дашборд</h1><span class="muted">Brookclean Trucks · обновлено <?= $h(date('d.m.Y H:i')) ?></span></div>
    <div><a class="btn ghost" href="admin.php?csv=1">Скачать CSV</a> <a class="btn ghost" href="admin.php?logout=1">Выйти</a></div></div>
  <div class="tiles">
    <div class="tile main"><span class="muted">Создано аккаунтов</span><b><?= $stats['total'] ?></b></div>
    <div class="tile"><span class="muted">Новых сегодня</span><b><?= $stats['today'] ?></b></div>
    <div class="tile"><span class="muted">За 7 дней</span><b><?= $stats['d7'] ?></b></div>
    <div class="tile"><span class="muted">За 30 дней</span><b><?= $stats['d30'] ?></b></div>
    <div class="tile"><span class="muted">Заходили за сутки</span><b><?= $stats['act1'] ?></b></div>
    <div class="tile"><span class="muted">Заходили за 7 дней</span><b><?= $stats['act7'] ?></b></div>
    <div class="tile"><span class="muted">С облачным сохранением</span><b><?= $stats['saves'] ?></b></div>
  </div>
  <div class="card"><b>Регистрации по дням, 30 дней</b>
    <div class="bars"><?php foreach ($byDay as $d => $n): ?><div style="height:<?= round($n / $max * 100) ?>%" title="<?= $h(date('d.m', strtotime($d))) ?>: <?= $n ?>"><?php if ($n): ?><span><?= $n ?></span><?php endif; ?></div><?php endforeach; ?></div>
    <div class="axis"><span><?= $h(date('d.m', strtotime(array_key_first($byDay)))) ?></span><span>сегодня</span></div></div>
  <div class="card"><b>Топ-10 по капиталу</b>
    <table><thead><tr><th>#</th><th>Логин</th><th>Режим</th><th>Касса</th><th>Лучший рейс</th><th>Сцепок</th><th>Рейсов</th></tr></thead><tbody>
    <?php foreach ($leaders as $i => $r): ?><tr><td><?= $i + 1 ?></td><td><?= $h($r['login']) ?></td><td><?= $r['mode'] === 'hard' ? 'Профи' : 'Стажёр' ?></td><td><?= number_format($r['capital'], 0, ',', ' ') ?> ₽</td><td><?= number_format($r['best'], 0, ',', ' ') ?> ₽</td><td><?= (int)$r['fleet'] ?></td><td><?= (int)$r['trips'] ?></td></tr><?php endforeach; if (!$leaders): ?><tr><td colspan="7" class="muted">Пока нет результатов</td></tr><?php endif; ?>
    </tbody></table></div>
  <div class="card"><b>Аккаунты</b> <span class="muted">последние <?= count($users) ?></span>
    <table><thead><tr><th>#</th><th>Логин</th><th>Создан</th><th>Последний вход</th><th>Входов</th><th>Рейсов</th><th>Касса</th><th>Сохранение</th></tr></thead><tbody>
    <?php foreach ($users as $u): [$trips, $bal] = $prog($u['save']); ?>
      <tr><td><?= (int)$u['id'] ?></td><td><?= $h($u['login']) ?></td><td><?= $h($dt($u['created'])) ?></td><td><?= $h($dt($u['last_seen'])) ?></td><td><?= (int)$u['logins'] ?></td><td><?= $h($trips) ?></td><td><?= $h($bal) ?></td><td><?= $h($dt($u['save_at'])) ?></td></tr>
    <?php endforeach; if (!$users): ?><tr><td colspan="8" class="muted">Аккаунтов пока нет</td></tr><?php endif; ?>
    </tbody></table></div>
<?php endif; ?>
</main></body></html>
