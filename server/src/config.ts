// настройки из переменных окружения; значения по умолчанию — для локальной разработки
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://brook:brook@localhost:5432/brookclean",
  storageDir: process.env.STORAGE_DIR ?? "./storage",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  // в разработке код подписи пишется в лог вместо отправки SMS
  smsProvider: process.env.SMS_PROVIDER ?? "console",
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 500),
};
