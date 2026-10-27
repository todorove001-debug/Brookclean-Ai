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
  // адрес сайта для клиентов: ссылка на личный кабинет в SMS
  clientUrl: process.env.CLIENT_URL || (process.env.CLIENT_DOMAIN ? `https://${process.env.CLIENT_DOMAIN}` : "http://localhost:3000"),
  // перевозчик в документах
  carrier: {
    name: process.env.CARRIER_NAME ?? "ИП Тодоров Евгений Константинович",
    inn: process.env.CARRIER_INN ?? "253717132973",
    phone: process.env.CARRIER_PHONE ?? "+7 950 281 55 55",
  },
  // часовой пояс дат в документах
  tz: process.env.TZ_DOCS ?? "Europe/Moscow",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  // в разработке код подписи пишется в лог вместо отправки SMS
  smsProvider: process.env.SMS_PROVIDER ?? "console",
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 500),
};
