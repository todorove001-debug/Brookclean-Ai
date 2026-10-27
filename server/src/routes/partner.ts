// кабинет партнёра на сайте для клиентов: ссылки со своим кэшбэком и заказы по ним
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { many, one } from "../db/pool.js";
import { bad, conflict, notFound } from "../errors.js";
import { hashPassword, requireUser } from "../services/auth.js";
import { audit } from "../services/audit.js";
import { trackInfo } from "../services/tracking.js";
import { passwordLogin, phone, publicUser } from "./auth.js";

const linkOut = (l: any) => ({ id: l.id, code: l.code, title: l.title, cashback: l.cashback, active: l.active, createdAt: l.created_at, orders: l.orders ?? 0 });
const code = () => randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 7);

export default async function (app: FastifyInstance) {
  const { pool } = app.deps;
  const partner = (req: any) => requireUser(pool, req, "partner");

  app.post("/partner/auth/register", async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(3, "Имя или название"), company: z.string().trim().max(160).optional(), phone, password: z.string().min(8, "Пароль от 8 символов") }).parse(req.body);
    if (await one(pool, "select 1 from users where phone = $1", [b.phone])) throw conflict("Этот телефон уже зарегистрирован");
    const u = await one(pool, `insert into users(role, name, phone, password_hash, partner_code) values ('partner', $1, $2, $3, $4) returning *`,
      [b.company ? `${b.name} (${b.company})` : b.name, b.phone, await hashPassword(b.password), code()]);
    await audit(pool, u.id, "register", "user", u.id, { role: "partner" });
    return reply.status(201).send({ user: publicUser(u), message: "Заявка отправлена. Менеджер подтвердит доступ." });
  });

  app.post("/partner/auth/login", async (req) => passwordLogin(pool, req.body, ["partner"]));

  app.get("/partner/links", async (req) => {
    const u = await partner(req);
    const rows = await many(pool, `select l.*, (select count(*)::int from orders o where o.partner_link_id = l.id) orders
      from partner_links l where l.partner_id = $1 order by l.created_at desc`, [u.id]);
    return { links: rows.map(linkOut) };
  });

  const LinkIn = z.object({ title: z.string().trim().max(80), cashback: z.number().int().min(0).max(100000), active: z.boolean() });

  // размер кэшбэка партнёр решает сам; он прибавляется к цене перевозки для клиента
  app.post("/partner/links", async (req, reply) => {
    const u = await partner(req);
    const b = LinkIn.partial({ active: true }).parse(req.body);
    const l = await one(pool, "insert into partner_links(partner_id, code, title, cashback) values ($1,$2,$3,$4) returning *", [u.id, code(), b.title, b.cashback]);
    await audit(pool, u.id, "partner_link_create", "partner_link", l.id, b);
    return reply.status(201).send({ link: linkOut(l) });
  });

  app.patch("/partner/links/:id", async (req) => {
    const u = await partner(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = LinkIn.partial().parse(req.body);
    const keys = (Object.keys(b) as (keyof typeof b)[]).filter((k) => b[k] !== undefined);
    if (!keys.length) throw bad("Нечего менять");
    const l = await one(pool, `update partner_links set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and partner_id = $2 returning *`,
      [id, u.id, ...keys.map((k) => b[k])]);
    if (!l) throw notFound("Ссылка не найдена");
    await audit(pool, u.id, "partner_link_update", "partner_link", id, b);
    return { link: linkOut(l) };
  });

  // заказы клиентов партнёра: без паспорта и телефона клиента
  app.get("/partner/orders", async (req) => {
    const u = await partner(req);
    const rows = await many(pool, `select o.no, o.created_at, o.car, o.city, o.client_fio, o.tariff, o.cashback, o.insurance, o.signed_at, o.pay_delivery, o.pay_insurance, l.title link
      from orders o left join partner_links l on l.id = o.partner_link_id where o.partner_id = $1 order by o.no desc limit 500`, [u.id]);
    const out = [];
    for (const o of rows) {
      const t = await trackInfo(pool, o.no);
      out.push({ no: o.no, createdAt: o.created_at, car: o.car, city: o.city, client: o.client_fio, link: o.link, price: o.tariff + o.cashback, cashback: o.cashback,
        signed: !!o.signed_at, paid: o.pay_delivery && o.pay_insurance, status: t.status });
    }
    return { orders: out, cashbackTotal: out.filter((o) => o.paid).reduce((s, o) => s + o.cashback, 0) };
  });
}
