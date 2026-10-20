<?php
require __DIR__ . '/config.php';

function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  if (!is_dir(dirname(DB_PATH))) mkdir(dirname(DB_PATH), 0750, true);
  $pdo = new PDO('sqlite:' . DB_PATH, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
  $pdo->exec('PRAGMA journal_mode = WAL');
  $pdo->exec('CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass TEXT NOT NULL,
    created INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    logins INTEGER NOT NULL DEFAULT 1,
    save TEXT,
    save_at INTEGER)');
  $pdo->exec('CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL)');
  $pdo->exec('CREATE TABLE IF NOT EXISTS fails (ip TEXT NOT NULL, at INTEGER NOT NULL)');
  $pdo->exec('CREATE TABLE IF NOT EXISTS scores (
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    capital INTEGER NOT NULL DEFAULT 0,
    best INTEGER NOT NULL DEFAULT 0,
    fleet INTEGER NOT NULL DEFAULT 1,
    trips INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_id, mode))');
  return $pdo;
}
