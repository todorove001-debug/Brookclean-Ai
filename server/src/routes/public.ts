// клиентская часть без входа: расчёт, заявка, подпись по коду из SMS, трекинг
import type { FastifyInstance } from "fastify";
import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { many, one, tx } from "../db/pool.js";
import { bad, forbidden, HttpError, notFound } from "../errors.js";
import { BODY, quote, TARIFF, type Body } from "../domain/tariffs.js";
import { kmOf, routeFor } from "../domain/route.js";
import { normPhone, sha256 } from "../services/auth.js";
import { audit } from "../services/audit.js";
import { loadOrder } from "../services/context.js";

const VIN17 = /^[A-HJ-NPR-Z0-9]{17}$/, FRAME = /^[A-Z0-9]{2,7}-\d{5,7}$/;
const cities = TARIFF.map((t) => t[0]);
const QuoteIn = z.object({
  city: z.string().refine((c) => cities.includes(c), "Город не из тарифной сетки"),
  body: z.enum(["sedan", "cross", "van"]),
  value: z.coerce.number().int().min(100000, "Стоимость от 100 000 ₽"),
  partnerCode: z.string().max(40).optional(),
  cashback: z.coerce.number().int().min(0).max(100000).default(0),
});
const OrderIn = QuoteIn.extend({
  car: z.string().trim().min(2, "Укажите марку и модель"),
  vin: z.string().trim().toUpperCase().refine((v) => VIN17.test(v) || FRAME.test(v), "Нужен VIN из 17 знаков или номер кузова вида ZVW51-6123456"),
  year: z.coerce.number().int().min(1990).max(new Date().getFullYear() + 1),
  color: z.string().trim().min(1, "Укажите цвет"),
  fio: z.string().trim().refine((v) => v.split(/\s+/).length >= 2, "Фамилия, имя и отчество полностью"),
  phone: z.string().transform(normPhone).refine((v) => v.length === 11, "Номер в формате +7 900 000 00 00"),
  passportSeries: z.string().regex(/^\d{4}$/, "Серия — 4 цифры"),
  passportNumber: z.string().regex(/^\d{6}$/, "Номер — 6 цифр"),
  passportIssued: z.string().trim().min(5, "Кем выдан паспорт"),
  passportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Дата выдачи"),
  address: z.string().trim().min(8, "Адрес регистрации"),
  consentPd: z.literal(true, { errorMap: () => ({ message: "Нужно согласие на обработку персональных данных" }) }),
});

// содержание договора, которое подписывает клиент; хеш фиксирует, что именно подписано
export function contractDoc(o: any) {
  return JSON.stringify({
    no: o.no, date: new Date(o.created_at).toISOString().slice(0, 10), carrier: "ИП Тодоров Евгений Константинович, ИНН 253717132973",
    client: o.client_fio, passport: `${o.passport_series} ${o.passport_number}`, address: o.address,
    car: o.car, vin: o.vin, year: o.year, color: o.color, value: o.value,
    from: "Владивосток", to: o.city, price: o.tariff + o.cashback, insurance: o.insurance,
  });
}

export default async function (app: FastifyInstance) {
  const { pool, sms } = app.deps;

  app.get("/tariffs", async () => ({ bodies: BODY, cities: TARIFF.map(([city, sedan, cross, van]) => ({ city, sedan, cross, van })) }));

  app.post("/quote", async (req) => {
    const b = QuoteIn.parse(req.body);
    return quote(b.city, b.body as Body, b.value, b.cashback)!;
  });

  app.post("/orders", async (req, reply) => {
    const b = OrderIn.parse(req.body);
    const q = quote(b.city, b.body as Body, b.value, b.partnerCode ? b.cashback : 0)!;
    const o = await tx(pool, async (c) => {
      const o = await one(c, `insert into orders(car, vin, year, color, body, value, city, client_fio, client_phone, passport_series, passport_number,
          passport_issued, passport_date, address, tariff, cashback, insurance, partner_code, track_token)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,
        [b.car, b.vin, b.year, b.color, b.body, b.value, b.city, b.fio, b.phone, b.passportSeries, b.passportNumber,
          b.passportIssued, b.passportDate, b.address, q.tariff, q.cashback, q.insurance, b.partnerCode ?? null, randomBytes(12).toString("base64url")]);
      await c.query("insert into order_legs(order_no, idx, from_city, to_city) values ($1, 0, 'Владивосток', $2)", [o.no, b.city]);
      await audit(c, null, "order_create", "order", o.no, { city: b.city, consentPd: true, ip: req.ip });
      return o;
    });
    return reply.status(201).send({ no: o.no, trackToken: o.track_token, quote: q });
  });

  const tokenOf = async (no: number, token: string) => {
    const o = await one(pool, "select * from orders where no = $1 and track_token = $2", [no, token]);
    if (!o) throw notFound("Заказ не найден");
    return o;
  };

  // код подписи: 6 цифр на 10 минут, в базе только хеш
  app.post("/orders/:no/sign/request", async (req) => {
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const { token } = z.object({ token: z.string() }).parse(req.body);
    const o = await tokenOf(no, token);
    if (o.signed_at) throw bad("Договор уже подписан");
    // не чаще раза в минуту: защита от рассылки SMS на чужой номер
    if (await one(pool, "select 1 from sign_codes where order_no = $1 and expires_at > now() + interval '9 minutes'", [no])) throw new HttpError(429, "Код уже отправлен. Повторить можно через минуту", "too_many");
    const code = String(randomInt(0, 1e6)).padStart(6, "0");
    await pool.query(`insert into sign_codes(order_no, code_hash, expires_at) values ($1,$2, now() + interval '10 minutes')
      on conflict (order_no) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`, [no, sha256(`${no}:${code}`)]);
    await sms.send(o.client_phone, `Код для подписи договора №${no}: ${code}. Никому не сообщайте.`);
    return { sent: true, phone: o.client_phone.replace(/^(\d)(\d{3})\d{5}(\d{2})$/, "+$1 $2 ***-**-$3") };
  });

  app.post("/orders/:no/sign/confirm", async (req) => {
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ token: z.string(), code: z.string().regex(/^\d{6}$/, "Код — 6 цифр") }).parse(req.body);
    return tx(pool, async (c) => {
      const o = await one(c, "select * from orders where no = $1 and track_token = $2 for update", [no, b.token]);
      if (!o) throw notFound("Заказ не найден");
      if (o.signed_at) throw bad("Договор уже подписан");
      const sc = await one(c, "select * from sign_codes where order_no = $1 for update", [no]);
      if (!sc || new Date(sc.expires_at) < new Date()) throw bad("Код устарел. Запросите новый");
      if (sc.attempts >= 5) throw forbidden("Слишком много попыток. Запросите новый код");
      if (sc.code_hash !== sha256(`${no}:${b.code}`)) {
        await c.query("update sign_codes set attempts = attempts + 1 where order_no = $1", [no]);
        throw bad("Неверный код");
      }
      const docHash = sha256(contractDoc(o));
      const r = await one(c, "update orders set signed_at = now(), signed_phone = client_phone, signed_ip = $2, doc_hash = $3 where no = $1 returning signed_at",
        [no, req.ip, docHash]);
      await c.query("delete from sign_codes where order_no = $1", [no]);
      await audit(c, null, "order_sign", "order", no, { docHash, ip: req.ip, ua: req.headers["user-agent"] ?? null });
      return { signedAt: r.signed_at, docHash };
    });
  });

  // трекинг по ссылке: без персональных данных, только машина, маршрут и позиция
  app.get("/track/:token", async (req) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const r = await one(pool, "select no from orders where track_token = $1", [token]);
    if (!r) throw notFound("Ссылка недействительна");
    const { row, ctx } = await loadOrder(pool, r.no);
    const done = new Set((await many(pool, "select stage from stages where order_no = $1 and done_at is not null", [r.no])).map((x) => x.stage));
    const leg = ctx.legs.length > 1 && done.has("term_out") ? ctx.legs[1] : ctx.legs[0];
    const trip = leg?.trip ?? null;
    let status = row.delivered_at ? "Выдан" : !row.signed_at ? "Ждёт подписания" : !trip ? "Оплачен, ждёт рейса" : "В пути";
    if (!row.delivered_at && ctx.legs.length > 1 && done.has("term_in") && !done.has("term_out")) status = `На терминале ${ctx.transferCity}`;
    const km = row.delivered_at ? kmOf(row.city) : Math.min(kmOf(trip?.currentCity), kmOf(row.city));
    if (status === "В пути" && km === 0) status = "Погрузка";
    if (status === "В пути" && km >= kmOf(row.city)) status = "Прибыл";
    const events = trip ? await many(pool, "select at, city, note from trip_events where trip_id = $1 and public order by at", [trip.id]) : [];
    return {
      no: row.no, car: row.car, city: row.city, transferCity: row.transfer_city, status,
      position: { city: trip?.currentCity ?? null, km },
      stops: routeFor(row.city).map((c) => ({ city: c, km: kmOf(c), passed: km > 0 && kmOf(c) <= km })),
      events,
    };
  });
}
