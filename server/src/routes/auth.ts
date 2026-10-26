import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { many, one, tx, type Db } from "../db/pool.js";
import { bad, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { checkPassword, createSession, hashPassword, normPhone, requireUser, sha256, userFromRequest } from "../services/auth.js";
import { audit } from "../services/audit.js";

export const phone = z.string().transform(normPhone).refine((v) => v.length === 11, "Номер в формате +7 900 000 00 00");
const Register = z.object({
  role: z.enum(["driver", "terminal"]),   // партнёры регистрируются на сайте для клиентов
  name: z.string().trim().min(5, "ФИО полностью"),
  phone,
  password: z.string().min(8, "Пароль от 8 символов"),
  license: z.string().optional(),
  terminalCity: z.string().optional(),
});

// вход по телефону и паролю только для своих ролей: на чужом сайте учётная запись как будто не существует
export async function passwordLogin(db: Db, body: unknown, roles: string[]) {
  const b = z.object({ phone, password: z.string() }).parse(body);
  const u = await one(db, "select * from users where phone = $1", [b.phone]);
  if (!u || !roles.includes(u.role) || !(await checkPassword(b.password, u.password_hash))) throw unauthorized("Неверный телефон или пароль");
  if (u.status === "pending") throw forbidden("Заявка ждёт подтверждения менеджером");
  if (u.status !== "active") throw forbidden("Доступ закрыт. Обратитесь к менеджеру");
  return { token: await createSession(db, u.id), user: publicUser(u) };
}

export const publicUser = (u: any) => ({ id: u.id, role: u.role, name: u.name, phone: u.phone, status: u.status, terminalCity: u.terminal_city, createdAt: u.created_at });

export default async function (app: FastifyInstance) {
  const { pool } = app.deps;

  // новый сотрудник регистрируется сам, доступ открывает менеджер
  app.post("/auth/register", async (req, reply) => {
    const b = Register.parse(req.body);
    if (b.role === "driver" && String(b.license ?? "").replace(/\D/g, "").length !== 10) throw bad("Номер водительского удостоверения — 10 цифр");
    if (b.role === "terminal" && !b.terminalCity) throw bad("Укажите терминал");
    if (await one(pool, "select 1 from users where phone = $1", [b.phone])) throw conflict("Этот телефон уже зарегистрирован");
    const u = await one(pool, `insert into users(role, name, phone, password_hash, terminal_city, partner_code, license)
      values ($1,$2,$3,$4,$5,$6,$7) returning *`, [b.role, b.name, b.phone, await hashPassword(b.password), b.terminalCity ?? null, null, b.license ?? null]);
    await audit(pool, u.id, "register", "user", u.id, { role: b.role });
    return reply.status(201).send({ user: publicUser(u), message: "Заявка отправлена. Менеджер подтвердит доступ." });
  });

  // вход сотрудников; партнёры входят на сайте для клиентов
  app.post("/auth/login", async (req) => passwordLogin(pool, req.body, ["manager", "driver", "terminal"]));

  app.post("/auth/logout", async (req) => {
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Bearer ")) await pool.query("delete from sessions where token_hash = $1", [sha256(h.slice(7))]);
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const u = await userFromRequest(pool, req);
    if (!u) throw unauthorized();
    return { user: u };
  });

  /* --- сотрудники: менеджер подтверждает и блокирует доступ --- */
  app.get("/users", async (req) => {
    await requireUser(pool, req, "manager");
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = await many(pool, `select * from users ${status ? "where status = $1" : ""} order by created_at desc`, status ? [status] : []);
    return { users: rows.map(publicUser) };
  });

  app.post("/users/:id/status", async (req) => {
    const m = await requireUser(pool, req, "manager");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.enum(["active", "blocked", "rejected"]) }).parse(req.body);
    return tx(pool, async (c) => {
      const u = await one(c, "update users set status = $2 where id = $1 returning *", [id, status]);
      if (!u) throw notFound("Сотрудник не найден");
      if (status !== "active") await c.query("delete from sessions where user_id = $1", [id]);
      // подтверждённый водитель получает карточку: если терминал уже завёл его по этому телефону — связываем, иначе в общую базу
      if (status === "active" && u.role === "driver" && !(await one(c, "select 1 from drivers where user_id = $1", [u.id]))) {
        const free = (await many(c, "select id, phone from drivers where user_id is null")).find((d) => normPhone(d.phone ?? "") === u.phone);
        if (free) await c.query("update drivers set user_id = $2 where id = $1", [free.id, u.id]);
        else await c.query("insert into drivers(user_id, name, phone, own) values ($1,$2,$3,true)", [u.id, u.name, u.phone]);
      }
      await audit(c, m.id, "user_status", "user", id, { status });
      return { user: publicUser(u) };
    });
  });
}
