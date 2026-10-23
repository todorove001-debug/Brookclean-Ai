// Фото и видео приёмки — в объектном хранилище S3 (Reg.ru), не на диске сервера.
// Телефон приёмщика грузит файл прямо в S3 по подписанной ссылке: сервер не гоняет через себя сотни мегабайт видео.
import { createHash, createHmac } from "node:crypto";

export interface MediaStore {
  /** Ссылка, по которой браузер кладёт файл (PUT). */
  putUrl(key: string, contentType: string): Promise<string>;
  /** Ссылка на просмотр, живёт expiresSec. */
  getUrl(key: string, expiresSec?: number): Promise<string>;
  /** Размер файла или null, если его нет. */
  size(key: string): Promise<number | null>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  fetch?: typeof fetch;
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha = (data: string) => createHash("sha256").update(data).digest("hex");

/** S3-совместимое хранилище: ссылки с подписью AWS Signature V4 в адресе (path-style: /bucket/key). */
export class S3Store implements MediaStore {
  constructor(private o: S3Options, private now: () => Date = () => new Date()) {}

  presign(method: "GET" | "PUT" | "HEAD" | "DELETE", key: string, expiresSec = 3600): string {
    const url = new URL(this.o.endpoint);
    const path = `/${enc(this.o.bucket)}/${key.split("/").map(enc).join("/")}`;
    const t = this.now().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const day = t.slice(0, 8);
    const scope = `${day}/${this.o.region}/s3/aws4_request`;
    const q: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.o.accessKey}/${scope}`,
      "X-Amz-Date": t,
      "X-Amz-Expires": String(expiresSec),
      "X-Amz-SignedHeaders": "host",
    };
    const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join("&");
    const canonical = [method, path, query, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", t, scope, sha(canonical)].join("\n");
    const kSigning = hmac(hmac(hmac(hmac("AWS4" + this.o.secretKey, day), this.o.region), "s3"), "aws4_request");
    const sig = createHmac("sha256", kSigning).update(toSign).digest("hex");
    return `${url.origin}${path}?${query}&X-Amz-Signature=${sig}`;
  }

  async putUrl(key: string) {
    return this.presign("PUT", key, 3600);
  }
  async getUrl(key: string, expiresSec = 3600) {
    return this.presign("GET", key, expiresSec);
  }
  private f() {
    return this.o.fetch ?? fetch;
  }
  async size(key: string) {
    const r = await this.f()(this.presign("HEAD", key, 300), { method: "HEAD" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`S3 HEAD ${r.status}`);
    return Number(r.headers.get("content-length") ?? 0);
  }
  async get(key: string) {
    const r = await this.f()(this.presign("GET", key, 300));
    if (!r.ok) throw new Error(`S3 GET ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async remove(key: string) {
    const r = await this.f()(this.presign("DELETE", key, 300), { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${r.status}`);
  }
}

export function s3FromEnv(env = process.env): S3Store | undefined {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) return undefined;
  return new S3Store({
    endpoint: env.S3_ENDPOINT ?? "https://s3.regru.cloud",
    region: env.S3_REGION ?? "ru-1",
    bucket: env.S3_BUCKET,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  });
}

/**
 * Хранилище в памяти — только для разработки и тестов, когда S3 не настроен.
 * Файлы принимает сам сервер по /api/staff/dev-media/…; в продакшене не используется.
 */
export class MemoryStore implements MediaStore {
  files = new Map<string, { type: string; data: Buffer }>();
  async putUrl(key: string) {
    return `/api/staff/dev-media/${encodeURIComponent(key)}`;
  }
  async getUrl(key: string) {
    return `/api/staff/dev-media/${encodeURIComponent(key)}`;
  }
  async size(key: string) {
    return this.files.get(key)?.data.length ?? null;
  }
  async get(key: string) {
    const f = this.files.get(key);
    if (!f) throw new Error("нет файла");
    return f.data;
  }
  async remove(key: string) {
    this.files.delete(key);
  }
}
