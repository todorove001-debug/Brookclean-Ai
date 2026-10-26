// личный кабинет клиента: вход по коду из SMS на телефон из заявки, список своих машин
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { many, one, tx } from "../db/pool.js";
import { bad, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import { sha256 } from "../services/auth.js";
import { config } from "../config.js";
import { trackInfo } from "../services/tracking.js";
import { phone } from "./auth.js";
import { sendAct } from "./handover.js";

export async function clientPhone(db: any, req: FastifyRequest) {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) throw unauthorized();
  const s = await one(db, "select phone from client_sessions where token_hash = $1 and expires_at > now()", [sha256(h.slice(7))]);
  if (!s) throw unauthorized();
  return s.phone as string;
}

export default async function (app: FastifyInstance) {
  const { pool, sms } = app.deps;

  // ответ одинаковый, есть заявки на этот номер или нет: по сайту нельзя узнать, кто наш клиент
  app.post("/client/login/request", async (req) => {
    const b = z.object({ phone }).parse(req.body);
    if (await one(pool, "select 1 from client_codes where phone = $1 and expires_at > now() + interval '9 minutes'", [b.phone]))
      throw new HttpError(429, "Код уже отправлен. Повторить можно через минуту", "too_many");
    if (await one(pool, "select 1 from orders where client_phone = $1 limit 1", [b.phone])) {
      const code = String(randomInt(0, 1e6)).padStart(6, "0");
      await pool.query(`insert into client_codes(phone, code_hash, expires_at) values ($1,$2, now() + interval '10 minutes')
        on conflict (phone) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`, [b.phone, sha256(`client:${b.phone}:${code}`)]);
      await sms.send(b.phone, `Код для входа в личный кабинет Brookclean: ${code}`);
    }
    return { sent: true };
  });

  app.post("/client/login/confirm", async (req) => {
    const b = z.object({ phone, code: z.string().regex(/^\d{6}$/, "Код — 6 цифр") }).parse(req.body);
    return tx(pool, async (c) => {
      const cc = await one(c, "select * from client_codes where phone = $1 for update", [b.phone]);
      if (!cc || new Date(cc.expires_at) < new Date()) throw bad("Код устарел. Запросите новый");
      if (cc.attempts >= 5) throw forbidden("Слишком много попыток. Запросите новый код");
      if (cc.code_hash !== sha256(`client:${b.phone}:${b.code}`)) {
        await c.query("update client_codes set attempts = attempts + 1 where phone = $1", [b.phone]);
        throw bad("Неверный код");
      }
      await c.query("delete from client_codes where phone = $1", [b.phone]);
      const token = randomBytes(32).toString("base64url");
      await c.query("insert into client_sessions(token_hash, phone, expires_at) values ($1,$2, now() + make_interval(days => $3))", [sha256(token), b.phone, config.sessionDays]);
      return { token };
    });
  });

  app.post("/client/logout", async (req) => {
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Bearer ")) await pool.query("delete from client_sessions where token_hash = $1", [sha256(h.slice(7))]);
    return { ok: true };
  });

  // итоговый акт по своей машине
  app.get("/client/orders/:no/act", async (req, reply) => {
    const ph = await clientPhone(pool, req);
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const o = await one(pool, "select * from orders where no = $1 and client_phone = $2", [no, ph]);
    if (!o) throw notFound("Заказ не найден");
    return sendAct(reply, o);
  });

  app.get("/client/orders", async (req) => {
    const ph = await clientPhone(pool, req);
    const rows = await many(pool, "select * from orders where client_phone = $1 order by no desc", [ph]);
    const out = [];
    for (const o of rows) {
      const t = await trackInfo(pool, o.no);
      out.push({
        no: o.no, createdAt: o.created_at, car: o.car, vin: o.vin, year: o.year, color: o.color, city: o.city,
        price: { delivery: o.tariff + o.cashback, insurance: o.insurance, total: o.tariff + o.cashback + o.insurance },
        signedAt: o.signed_at, paid: { delivery: o.pay_delivery, insurance: o.pay_insurance }, policyNo: o.policy_no,
        status: t.status, position: { city: t.trip?.currentCity ?? null, km: t.km }, trackToken: o.track_token, deliveredAt: o.delivered_at,
        actAvailable: !!o.delivered_at,
      });
    }
    return { phone: ph, orders: out };
  });
}

