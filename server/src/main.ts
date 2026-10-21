import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { smsFromEnv } from "./sms.ts";
import { GoogleDrive } from "./drive.ts";
import { ensureOwner } from "./staff.ts";

const prod = process.env.NODE_ENV === "production";
const db = openDb(process.env.DB_FILE ?? "data/brookclean.db", Number(process.env.ORDER_NO_START ?? 685));
ensureOwner(db, process.env.OWNER_LOGIN, process.env.OWNER_PASSWORD);
const publicUrl = process.env.PUBLIC_URL ?? "https://brookclean-reg.ru";
const drive = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? new GoogleDrive(db, {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: `${publicUrl.replace(/\/$/, "")}/api/google/callback`,
    })
  : undefined;
const app = buildApp({
  db,
  sms: smsFromEnv(),
  adminToken: process.env.ADMIN_TOKEN,
  publicUrl,
  drive,
  webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  exposeSmsCode: !prod && process.env.SMS_PROVIDER === undefined,
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(`Brookclean: http://localhost:${port}`);
