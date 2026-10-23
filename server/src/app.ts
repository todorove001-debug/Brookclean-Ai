import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  CITIES, kmTo, maskVin, normalizePhone, parseRub, quote, routeFor, validateCar, validateCustomer,
  type CarForm, type CustomerForm, type OrderStatus, type Quote, type TrackingView,
} from "@brookclean/shared";
import { nextOrderNo, type DB } from "./db.ts";
import { contractPayload, sha256 } from "./contract.ts";
import type { SmsSender } from "./sms.ts";
import { registerStaff } from "./staff.ts";
import type { GoogleDrive } from "./drive.ts";
import type { Vision } from "./recognize.ts";

export interface AppOptions {
  db: DB;
  sms: SmsSender;
  adminToken?: string;
  drive?: GoogleDrive;
  /** Распознавание фото (Yandex AI Studio). Без него сотрудник заполняет поля вручную. */
  vision?: Vision;
  webDist?: string;
  /** Адрес сайта для ссылок в SMS. */
  publicUrl?: string;
  /** Только для разработки: возвращать код SMS в ответе API. */
  exposeSmsCode?: boolean;
  now?: () => Date;
}

const CODE_TTL_MS = 10 * 60_000;
const RESEND_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;

const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function randomToken(len = 16) {
  const b = randomBytes(len);
  return [...b].map((x) => TOKEN_ALPHABET[x % TOKEN_ALPHABET.length]).join("");
}

interface OrderRow {
  id: string; no: number; created_at: string; status: OrderStatus; car: string; customer: string; phone: string;
  partner: string | null; cashback: number; quote: string; track_token: string | null; trip_id: string | null;
  signed_at: string | null; signature: string | null; received_at: string | null; review_sms_at: string | null;
  created_by: number | null;
}

const ruDate = (d: Date) => d.toLocaleDateString("ru-RU", { timeZone: "Asia/Vladivostok" });

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db, sms } = opts;
  const now = opts.now ?? (() => new Date());
  const app = Fastify({ logger: process.env.NODE_ENV === "production", trustProxy: process.env.TRUST_PROXY ?? "127.0.0.1" });

  const publicUrl = (opts.publicUrl ?? "https://brookclean-reg.ru").replace(/\/$/, "");
  const byToken = (token: string) => db.prepare("SELECT * FROM orders WHERE track_token = ?").get(token) as OrderRow | undefined;
  const getOrder = (id: string) => db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;

  function publicOrder(o: OrderRow) {
    const car = JSON.parse(o.car) as CarForm;
    const customer = JSON.parse(o.customer) as CustomerForm;
    return {
      id: o.id, no: o.no, status: o.status, createdAt: o.created_at, car,
      customer: { fio: customer.fio, phone: o.phone },
      quote: JSON.parse(o.quote) as Quote,
      trackToken: o.track_token, signedAt: o.signed_at,
      signature: o.signature ? JSON.parse(o.signature) : null,
    };
  }

  app.get("/api/health", async () => ({ ok: true }));

  // --- Партнёрская ссылка: кэшбэк хранится на сервере, в URL только токен ---
  app.get<{ Params: { token: string } }>("/api/partner-links/:token", async (req, reply) => {
    const row = db.prepare("SELECT partner, cashback FROM partner_links WHERE token = ?").get(req.params.token) as
      | { partner: string; cashback: number } | undefined;
    if (!row) return reply.code(404).send({ error: "Ссылка не найдена" });
    return { partner: row.partner, cashback: row.cashback };
  });

  app.post<{ Body: { car: CarForm; partnerToken?: string } }>("/api/quote", async (req, reply) => {
    const car = req.body?.car;
    if (!car || !CITIES.includes(car.city)) return reply.code(400).send({ error: "Выберите город" });
    return quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback: partnerCashback(req.body.partnerToken)?.cashback });
  });

  function partnerCashback(token?: string) {
    if (!token) return undefined;
    return db.prepare("SELECT partner, cashback FROM partner_links WHERE token = ?").get(token) as
      | { partner: string; cashback: number } | undefined;
  }

  // --- Оформление: черновик заказа + отправка кода ---
  app.post<{ Body: { car: CarForm; customer: CustomerForm; partnerToken?: string; consents?: Record<string, boolean> } }>(
    "/api/orders",
    async (req, reply) => {
      const { car, customer, partnerToken, consents } = req.body ?? ({} as never);
      if (!car || !customer) return reply.code(400).send({ error: "Нет данных заказа" });
      const errors = { ...validateCar(car, now()), ...validateCustomer(customer) };
      if (Object.keys(errors).length) return reply.code(400).send({ error: "Проверьте поля", errors });
      if (!consents?.contract || !consents?.pep || !consents?.personalData)
        return reply.code(400).send({ error: "Нужны все три согласия" });

      const partner = partnerCashback(partnerToken);
      const q = quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback: partner?.cashback });
      const id = randomUUID();
      const no = nextOrderNo(db);
      const phone = normalizePhone(customer.phone);
      db.prepare(`INSERT INTO orders (id, no, created_at, status, car, customer, phone, partner, cashback, quote)
                  VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`)
        .run(id, no, now().toISOString(), JSON.stringify(car), JSON.stringify({ ...customer, phone }), phone,
          partner?.partner ?? null, partner?.cashback ?? 0, JSON.stringify(q));
      let devCode: string | undefined;
      try {
        devCode = await sendCode(id, no, phone);
      } catch (err) {
        req.log.error(err);
        db.prepare("DELETE FROM sms_codes WHERE order_id = ?").run(id);
        db.prepare("DELETE FROM orders WHERE id = ?").run(id);
        return reply.code(502).send({ error: "Не удалось отправить SMS. Попробуйте ещё раз через минуту." });
      }
      return { id, no, quote: q, ...(devCode ? { devCode } : {}) };
    },
  );

  async function sendCode(orderId: string, no: number, phone: string) {
    const code = String(randomInt(0, 10000)).padStart(4, "0");
    const t = now().getTime();
    db.prepare(`INSERT INTO sms_codes (order_id, code_hash, sent_at, expires_at, attempts, sends) VALUES (?, ?, ?, ?, 0, 1)
                ON CONFLICT(order_id) DO UPDATE SET code_hash = excluded.code_hash, sent_at = excluded.sent_at,
                expires_at = excluded.expires_at, attempts = 0, sends = sends + 1`)
      .run(orderId, sha256(orderId + code), t, t + CODE_TTL_MS);
    await sms.send(phone, `Код для подписания договора №${no}: ${code}. Никому не сообщайте.`);
    return opts.exposeSmsCode ? code : undefined;
  }

  app.post<{ Params: { id: string } }>("/api/orders/:id/resend", async (req, reply) => {
    const o = getOrder(req.params.id);
    if (!o) return reply.code(404).send({ error: "Заказ не найден" });
    if (o.status !== "draft") return reply.code(409).send({ error: "Договор уже подписан" });
    const c = db.prepare("SELECT sent_at, sends FROM sms_codes WHERE order_id = ?").get(o.id) as { sent_at: number; sends: number } | undefined;
    if (c && now().getTime() - c.sent_at < RESEND_AFTER_MS)
      return reply.code(429).send({ error: "Повторно код можно запросить через минуту" });
    if (c && c.sends >= MAX_SENDS) return reply.code(429).send({ error: "Слишком много попыток. Позвоните нам." });
    try {
      const devCode = await sendCode(o.id, o.no, o.phone);
      return { ok: true, ...(devCode ? { devCode } : {}) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Не удалось отправить SMS. Попробуйте ещё раз через минуту." });
    }
  });

  app.post<{ Params: { id: string }; Body: { code: string; consents?: Record<string, boolean> } }>("/api/orders/:id/sign", async (req, reply) => {
    const o = getOrder(req.params.id);
    if (!o) return reply.code(404).send({ error: "Заказ не найден" });
    if (o.status !== "draft") return publicOrder(o);
    // Заявку от менеджера клиент подписывает по ссылке: согласия ставит сам на этом шаге
    const cs = req.body?.consents;
    if (o.created_by !== null && !(cs?.contract && cs?.pep && cs?.personalData))
      return reply.code(400).send({ error: "Нужны все три согласия" });
    const c = db.prepare("SELECT * FROM sms_codes WHERE order_id = ?").get(o.id) as
      | { code_hash: string; expires_at: number; attempts: number } | undefined;
    if (!c || now().getTime() > c.expires_at) return reply.code(410).send({ error: "Код устарел, запросите новый" });
    if (c.attempts >= MAX_ATTEMPTS) return reply.code(429).send({ error: "Слишком много попыток, запросите новый код" });
    const code = String(req.body?.code ?? "").replace(/\D/g, "");
    if (sha256(o.id + code) !== c.code_hash) {
      db.prepare("UPDATE sms_codes SET attempts = attempts + 1 WHERE order_id = ?").run(o.id);
      return reply.code(400).send({ error: "Неверный код" });
    }

    const signedAt = now();
    const car = JSON.parse(o.car) as CarForm;
    const customer = JSON.parse(o.customer) as CustomerForm;
    const payload = contractPayload(o.no, ruDate(new Date(o.created_at)), car, customer, JSON.parse(o.quote));
    const signature = {
      method: "ПЭП: код из SMS",
      phone: o.phone,
      at: signedAt.toISOString(),
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? "",
      documentSha256: sha256(JSON.stringify(payload)),
      payload,
    };
    const token = randomToken();
    db.prepare("UPDATE orders SET status = 'signed', signed_at = ?, signature = ?, track_token = ? WHERE id = ?")
      .run(signedAt.toISOString(), JSON.stringify(signature), token, o.id);
    db.prepare("DELETE FROM sms_codes WHERE order_id = ?").run(o.id);
    return publicOrder(getOrder(o.id)!);
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => {
    const o = getOrder(req.params.id);
    if (!o) return reply.code(404).send({ error: "Заказ не найден" });
    if (o.status !== "draft") return publicOrder(o);
    // Неподписанная заявка: данные для текста договора, паспорт частично скрыт
    const c = JSON.parse(o.customer) as CustomerForm;
    return {
      ...publicOrder(o),
      documentCustomer: { ...c, passportNumber: "••••" + c.passportNumber.slice(-2) },
    };
  });

  // --- Трекинг по ссылке: без ФИО и телефона ---
  app.get<{ Params: { token: string } }>("/api/t/:token", async (req, reply) => {
    const o = byToken(req.params.token);
    if (!o) return reply.code(404).send({ error: "Ссылка не найдена" });
    const car = JSON.parse(o.car) as CarForm;
    const review = db.prepare("SELECT rating, text FROM reviews WHERE order_id = ?").get(o.id) as TrackingView["review"] | undefined;
    const trip = o.trip_id
      ? (db.prepare("SELECT * FROM trips WHERE id = ?").get(o.trip_id) as { truck: string; load_date: string | null; km: number } | undefined)
      : undefined;
    const events = o.trip_id
      ? (db.prepare("SELECT at, city, note FROM trip_events WHERE trip_id = ? ORDER BY at").all(o.trip_id) as TrackingView["events"])
      : [];
    const destKm = kmTo(car.city);
    const route = new Set(routeFor(car.city));
    const view: TrackingView = {
      orderNo: o.no, car: `${car.car} ${car.year}`, vinMasked: maskVin(car.vin.toUpperCase()), city: car.city,
      status: o.status, km: Math.min(trip?.km ?? 0, destKm), destKm,
      truck: trip?.truck ?? null, loadDate: trip?.load_date ?? null,
      // Клиент видит только точки своего маршрута: остальные машины рейса едут дальше
      events: events.filter((e) => route.has(e.city)),
      review: review ? { rating: review.rating, text: review.text } : null,
    };
    return view;
  });

  // --- Клиент отмечает получение автомобиля, затем оставляет отзыв ---
  app.post<{ Params: { token: string } }>("/api/t/:token/received", async (req, reply) => {
    const o = byToken(req.params.token);
    if (!o) return reply.code(404).send({ error: "Ссылка не найдена" });
    if (o.status === "draft") return reply.code(409).send({ error: "Договор не подписан" });
    db.prepare("UPDATE orders SET status = 'delivered', received_at = COALESCE(received_at, ?) WHERE id = ?").run(now().toISOString(), o.id);
    return { ok: true };
  });

  app.post<{ Params: { token: string }; Body: { rating: number; text?: string } }>("/api/t/:token/review", async (req, reply) => {
    const o = byToken(req.params.token);
    if (!o) return reply.code(404).send({ error: "Ссылка не найдена" });
    if (o.status !== "delivered") return reply.code(409).send({ error: "Отзыв можно оставить после получения автомобиля" });
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return reply.code(400).send({ error: "Поставьте оценку от 1 до 5" });
    const text = String(req.body?.text ?? "").trim().slice(0, 2000);
    db.prepare(`INSERT INTO reviews (order_id, rating, text, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(order_id) DO UPDATE SET rating = excluded.rating, text = excluded.text, created_at = excluded.created_at`)
      .run(o.id, rating, text, now().toISOString());
    return { ok: true };
  });

  registerStaff(app, {
    db, sms, now, publicUrl, adminToken: opts.adminToken, drive: opts.drive, vision: opts.vision,
    secureCookies: publicUrl.startsWith("https://") && process.env.NODE_ENV === "production",
    requestReview, randomToken,
  });

  /** Один раз после выдачи автомобиля: SMS со ссылкой на форму отзыва. */
  async function requestReview(no: number, log: { error: (e: unknown) => void }) {
    const o = db.prepare("SELECT * FROM orders WHERE no = ?").get(no) as OrderRow | undefined;
    if (!o?.track_token || o.review_sms_at) return;
    const has = db.prepare("SELECT 1 FROM reviews WHERE order_id = ?").get(o.id);
    if (has) return;
    try {
      await sms.send(o.phone, `Brookclean Trucks: автомобиль по договору №${o.no} выдан. Оцените доставку: ${publicUrl}/t/${o.track_token}`);
      db.prepare("UPDATE orders SET review_sms_at = ? WHERE id = ?").run(now().toISOString(), o.id);
    } catch (err) {
      log.error(err);
    }
  }

  // --- Сайт (PWA): собранный web/dist, все не-API пути отдают index.html ---
  if (opts.webDist && existsSync(opts.webDist)) {
    app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Не найдено" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
