import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import { one, type Db } from "../db/pool.js";
import { config } from "../config.js";
import { forbidden, unauthorized } from "../errors.js";
import type { UserCtx } from "../domain/stages.js";

const scrypt = promisify(_scrypt) as (p: string, s: Buffer, n: number) => Promise<Buffer>;

export async function hashPassword(pass: string) {
  const salt = randomBytes(16), key = await scrypt(pass, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function checkPassword(pass: string, stored: string) {
  const [, s, k] = stored.split("$");
  if (!s || !k) return false;
  const key = await scrypt(pass, Buffer.from(s, "hex"), 64);
  return timingSafeEqual(key, Buffer.from(k, "hex"));
}
export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

// телефон как логин: только цифры, 8XXXXXXXXXX → 7XXXXXXXXXX
export function normPhone(v: string) {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d;
}

export async function createSession(db: Db, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query("insert into sessions(token_hash, user_id, expires_at) values ($1,$2, now() + make_interval(days => $3))",
    [sha256(token), userId, config.sessionDays]);
  return token;
}

export interface AuthUser extends UserCtx { phone: string; status: string }

export async function userFromRequest(db: Db, req: FastifyRequest): Promise<AuthUser | null> {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const u = await one(db, `select u.id, u.role, u.name, u.phone, u.status, u.terminal_city from sessions s join users u on u.id = s.user_id
    where s.token_hash = $1 and s.expires_at > now()`, [sha256(token)]);
  if (!u) return null;
  return { id: u.id, role: u.role, name: u.name, phone: u.phone, status: u.status, terminalCity: u.terminal_city };
}

// только активные сотрудники нужных ролей
export async function requireUser(db: Db, req: FastifyRequest, ...roles: AuthUser["role"][]): Promise<AuthUser> {
  const u = await userFromRequest(db, req);
  if (!u) throw unauthorized();
  if (u.status !== "active") throw forbidden("Доступ ещё не подтверждён менеджером или заблокирован");
  if (roles.length && !roles.includes(u.role)) throw forbidden();
  return u;
}
