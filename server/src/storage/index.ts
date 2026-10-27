import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline as pipe, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "../config.js";

// хранилище фото, видео, подписей и актов: папка на диске для разработки или S3 (Reg.ru) на сервере
export interface Storage {
  put(key: string, data: Readable | Buffer, contentType?: string): Promise<{ size: number }>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  check(): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(private root: string) {}
  private full(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Недопустимый путь файла");
    return p;
  }
  async put(key: string, data: Readable | Buffer) {
    const p = this.full(key);
    await mkdir(path.dirname(p), { recursive: true });
    if (Buffer.isBuffer(data)) await writeFile(p, data);
    else await pipeline(data, createWriteStream(p));
    return { size: (await stat(p)).size };
  }
  async get(key: string) {
    const p = this.full(key);
    await stat(p);
    return createReadStream(p);
  }
  async remove(key: string) {
    await rm(this.full(key), { force: true });
  }
  async check() {
    await mkdir(this.root, { recursive: true });
  }
}

export interface S3Options { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }

// S3-совместимое хранилище: Reg.ru (https://s3.regru.cloud), Yandex, Selectel. Большие видео грузятся частями
export class S3Storage implements Storage {
  private s3: S3Client;
  constructor(private o: S3Options) {
    this.s3 = new S3Client({
      endpoint: o.endpoint, region: o.region, forcePathStyle: o.forcePathStyle,
      credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
      // не все S3-совместимые хранилища принимают новые контрольные суммы AWS
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  async put(key: string, data: Readable | Buffer, contentType?: string) {
    let size = Buffer.isBuffer(data) ? data.length : 0;
    // размер считаем по ходу загрузки: длина потока заранее неизвестна
    const body = Buffer.isBuffer(data) ? data : new Transform({ transform(c: Buffer, _e, cb) { size += c.length; cb(null, c); } });
    if (!Buffer.isBuffer(data)) pipe(data, body as Transform, () => {});
    await new Upload({
      client: this.s3, queueSize: 4, partSize: 8 * 1024 * 1024, leavePartsOnError: false,
      params: { Bucket: this.o.bucket, Key: key, Body: body, ContentType: contentType },
    }).done();
    return { size };
  }
  async get(key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key }));
    return r.Body as Readable;
  }
  async remove(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: key }));
  }
  async check() {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.o.bucket }));
  }
}

export function storageFromConfig(): Storage {
  if (config.storage === "s3") {
    const s = config.s3;
    const miss = (["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const).filter((k) => !s[k]);
    if (miss.length) throw new Error(`Хранилище S3: не заданы ${miss.join(", ")} (S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY)`);
    return new S3Storage(s);
  }
  return new LocalStorage(config.storageDir);
}
