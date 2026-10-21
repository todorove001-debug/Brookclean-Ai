import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = DatabaseSync;

export function openDb(file: string, orderNoStart: number): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,               -- секрет клиента: доступ к заказу по ссылке
      no INTEGER UNIQUE NOT NULL,        -- номер договора
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      car TEXT NOT NULL,                 -- JSON CarForm
      customer TEXT NOT NULL,            -- JSON CustomerForm
      phone TEXT NOT NULL,               -- нормализованный +7XXXXXXXXXX
      partner TEXT,
      cashback INTEGER NOT NULL DEFAULT 0,
      quote TEXT NOT NULL,               -- JSON Quote на момент оформления
      track_token TEXT UNIQUE,
      trip_id TEXT,
      signed_at TEXT,
      signature TEXT,                    -- JSON журнал подписи ПЭП
      received_at TEXT,                  -- клиент отметил, что получил автомобиль
      review_sms_at TEXT                 -- когда отправили SMS с просьбой об отзыве
    );
    CREATE TABLE IF NOT EXISTS reviews (
      order_id TEXT PRIMARY KEY,
      rating INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sms_codes (
      order_id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sends INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS partner_links (
      token TEXT PRIMARY KEY,
      partner TEXT NOT NULL,
      cashback INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      dest TEXT NOT NULL,
      truck TEXT NOT NULL,
      load_date TEXT,
      km INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trip_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id TEXT NOT NULL,
      at TEXT NOT NULL,
      city TEXT NOT NULL,
      note TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  `);
  db.prepare("INSERT OR IGNORE INTO counters (name, value) VALUES ('order_no', ?)").run(orderNoStart - 1);
  return db;
}

export function nextOrderNo(db: DB): number {
  const row = db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'order_no' RETURNING value").get() as { value: number };
  return row.value;
}
