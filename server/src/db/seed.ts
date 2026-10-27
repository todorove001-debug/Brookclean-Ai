// первый менеджер для входа в систему: SEED_PHONE и SEED_PASSWORD из окружения
import { fileURLToPath } from "node:url";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
import { hashPassword, normPhone } from "../services/auth.js";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const phone = normPhone(process.env.SEED_PHONE ?? ""), pass = process.env.SEED_PASSWORD ?? "";
  const name = process.env.SEED_NAME ?? "Менеджер";
  if (phone.length !== 11 || pass.length < 8) {
    console.error("Укажите SEED_PHONE (телефон менеджера) и SEED_PASSWORD (от 8 символов)");
    process.exit(1);
  }
  const pool = createPool();
  await migrate(pool);
  await pool.query(`insert into users(role, name, phone, password_hash, status) values ('manager', $1, $2, $3, 'active')
    on conflict (phone) do update set role = 'manager', status = 'active', password_hash = excluded.password_hash`, [name, phone, await hashPassword(pass)]);
  console.log(`Менеджер ${phone} готов`);
  await pool.end();
}
