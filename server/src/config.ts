// настройки из переменных окружения; значения по умолчанию — для локальной разработки
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://brook:brook@localhost:5432/brookclean",
  // local — папка на диске; s3 — объектное хранилище (Reg.ru)
  storage: (process.env.STORAGE ?? "local") as "local" | "s3",
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "https://s3.regru.cloud",
    region: process.env.S3_REGION ?? "ru-1",
    bucket: process.env.S3_BUCKET ?? "",
    accessKeyId: process.env.S3_ACCESS_KEY ?? "",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  },
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  // в разработке код подписи пишется в лог вместо отправки SMS
  smsProvider: process.env.SMS_PROVIDER ?? "console",
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 500),
};
