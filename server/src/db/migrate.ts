import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";
import { createPool } from "./pool.js";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

// применяет по порядку файлы migrations/NNN_*.sql, которых ещё нет в таблице schema_migrations
export async function migrate(pool: pg.Pool, log = console.log) {
  await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await pool.query("select name from schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(DIR)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(DIR, f), "utf8");
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(sql);
      await c.query("insert into schema_migrations(name) values ($1)", [f]);
      await c.query("commit");
      log(`миграция применена: ${f}`);
    } catch (e) {
      await c.query("rollback");
      throw new Error(`миграция ${f} не применена: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  migrate(pool).then(() => pool.end(), (e) => { console.error(e.message); process.exit(1); });
}
