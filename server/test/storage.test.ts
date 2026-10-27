// хранилище: папка на диске и S3 (проверяется на локальном S3-сервере s3rver)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import S3rver from "s3rver";
import { LocalStorage, S3Storage, type Storage } from "../src/storage/index.js";

// ключи как в системе: кириллица и пробелы в именах папок
const KEY = "Автомобили/2026/1000_Mazda-CX-5_KF2P-401234/01_Приемка_2026-10-21_Владивосток/Фото/01_Перед-левый-угол-45_ab12.jpg";
const read = async (r: Readable) => { const parts: Buffer[] = []; for await (const c of r) parts.push(Buffer.from(c)); return Buffer.concat(parts); };

let s3srv: any;
const stores: Record<string, Storage> = {};

beforeAll(async () => {
  stores.local = new LocalStorage(await mkdtemp(path.join(tmpdir(), "bc-local-")));
  s3srv = new S3rver({ port: 0, address: "127.0.0.1", silent: true, directory: await mkdtemp(path.join(tmpdir(), "bc-s3-")), configureBuckets: [{ name: "brookclean", configs: [] }] });
  const { port } = await s3srv.run();
  stores.s3 = new S3Storage({ endpoint: `http://127.0.0.1:${port}`, region: "ru-1", bucket: "brookclean", accessKeyId: "S3RVER", secretAccessKey: "S3RVER", forcePathStyle: true });
});
afterAll(async () => { await s3srv?.close(); });

describe.each(["local", "s3"])("хранилище %s", (name) => {
  it("сохраняет, отдаёт и удаляет файл", async () => {
    const st = stores[name];
    await st.check();
    const data = Buffer.from("фото-машины");
    expect((await st.put(KEY, data, "image/jpeg")).size).toBe(data.length);
    expect((await read(await st.get(KEY))).equals(data)).toBe(true);
    await st.remove(KEY);
    await expect(st.get(KEY).then(read)).rejects.toThrow();
  });

  it("большое видео потоком, частями", async () => {
    const st = stores[name], size = 20 * 1024 * 1024, chunk = Buffer.alloc(1024 * 1024, 7);
    const src = Readable.from((function* () { for (let i = 0; i < size / chunk.length; i++) yield chunk; })());
    const key = KEY.replace("Фото/01_Перед-левый-угол-45_ab12.jpg", "Видео/01_Круговой-обход_cd34.mp4");
    expect((await st.put(key, src, "video/mp4")).size).toBe(size);
    expect((await read(await st.get(key))).length).toBe(size);
  });
});
