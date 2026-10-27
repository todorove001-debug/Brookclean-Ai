import type { FastifyInstance } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import S3rver from "s3rver";
import { LocalStorage, S3Storage, type Storage } from "../src/storage/index.js";
import { ConsoleSms } from "../src/services/sms.js";
import { hashPassword } from "../src/services/auth.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://brook:brook@localhost:5432/brookclean_test";

// чистая база и приложение для каждого набора тестов
export async function setup() {
  const pool = createPool(TEST_DB);
  await pool.query("drop schema public cascade; create schema public;");
  await migrate(pool, () => {});
  const sms = new ConsoleSms();
  sms.send = async (phone, text) => { sms.sent.push({ phone, text }); };
  // TEST_STORAGE=s3 — весь путь машины через S3 (локальный s3rver), как на сервере Reg.ru
  let storage: Storage = new LocalStorage(await mkdtemp(path.join(tmpdir(), "bc-"))), s3srv: any = null;
  if (process.env.TEST_STORAGE === "s3") {
    s3srv = new S3rver({ port: 0, address: "127.0.0.1", silent: true, directory: await mkdtemp(path.join(tmpdir(), "bc-s3-")), configureBuckets: [{ name: "brookclean", configs: [] }] });
    const { port } = await s3srv.run();
    storage = new S3Storage({ endpoint: `http://127.0.0.1:${port}`, region: "ru-1", bucket: "brookclean", accessKeyId: "S3RVER", secretAccessKey: "S3RVER", forcePathStyle: true });
  }
  const app = await buildApp({ pool, storage, sms });
  app.addHook("onClose", async () => { await s3srv?.close(); });
  return { pool, app, sms };
}

export function client(app: FastifyInstance) {
  const call = async (method: string, url: string, body?: unknown, token?: string) => {
    const r = await app.inject({ method: method as any, url, payload: body as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.body ? safeJson(r.body) : null, raw: r.rawPayload };
  };
  return call;
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

export function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
  const b = "----bc" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}

export async function addManager(pool: any, phone = "79502815555", pass = "manager123") {
  await pool.query("insert into users(role, name, phone, password_hash, status) values ('manager','Тодоров Евгений Константинович',$1,$2,'active')", [phone, await hashPassword(pass)]);
  return { phone, pass };
}

export const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
