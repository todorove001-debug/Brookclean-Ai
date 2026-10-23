import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY, CARRIER, CITIES, contractData, contractDate, kmTo, maskVin, normalizePhone, parseRub, routeFor, validateCar, validateCompany, validateCustomer,
  type BodyType, type CarForm, type CompanyForm, type ContractData, type CustomerForm, type OrderStatus, type Quote, type TrackingView,
} from "@brookclean/shared";
import { quote } from "./pricing.ts";
import { Guard, migrateGuard, type CaptchaVerifier } from "./guard.ts";
import { CLIENT_ORDERS_PER_DAY, canOrder, isPartner, migratePartners, partnerRequest } from "./partners.ts";
import { nextOrderNo, type DB } from "./db.ts";
import { contractPayload, sha256 } from "./contract.ts";
import type { SmsSender } from "./sms.ts";
import { cookie, registerStaff } from "./staff.ts";
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
  /** Отдельный адрес панели сотрудников (https://staff.brookclean-reg.ru). Если задан, на сайте клиента панели нет. */
  staffUrl?: string;
  /** Яндекс SmartCaptcha: без неё при подозрительной активности действуют только лимиты. */
  captcha?: CaptchaVerifier;
  /** Только для разработки: возвращать код SMS в ответе API. */
  exposeSmsCode?: boolean;
  now?: () => Date;
}

const CODE_TTL_MS = 10 * 60_000;
const RESEND_AFTER_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS = 5;
const CLIENT_COOKIE = "bc_client";
const CLIENT_SESSION_DAYS = 30;
/** Ответ для номеров и адресов из чёрного списка: без подробностей, чтобы не подсказывать обход. */
const PARTNER_ERROR = "Обычный клиент может оформить один автомобиль в сутки. Чтобы оформлять больше, заполните карточку партнёра.";
const BLOCKED_ERROR = `Онлайн-расчёт сейчас недоступен. Позвоните нам: ${CARRIER.phone}`;

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

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db, sms } = opts;
  const now = opts.now ?? (() => new Date());
  const app = Fastify({ logger: process.env.NODE_ENV === "production", trustProxy: process.env.TRUST_PROXY ?? "127.0.0.1" });
  migrateGuard(db);
  migratePartners(db);
  const guard = new Guard(db, now);

  const publicUrl = (opts.publicUrl ?? "https://brookclean-reg.ru").replace(/\/$/, "");
  const secureCookies = publicUrl.startsWith("https://") && process.env.NODE_ENV === "production";
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
      // Журнал подписи без подписанных данных: в них паспорт, их видит только сам клиент (signedContract)
      signature: o.signature ? (({ payload: _, ...s }) => s)(JSON.parse(o.signature)) : null,
    };
  }

  /** Данные для договора: у одобренного партнёра Заказчик — компания из его карточки. */
  function orderContract(o: OrderRow): ContractData {
    const company = isPartner(db, o.phone) ? partnerRequest(db, o.phone)!.company : null;
    return contractData(o.no, contractDate(new Date(o.created_at)), JSON.parse(o.car), JSON.parse(o.customer), JSON.parse(o.quote), company);
  }

  /** То, что клиент подписал: из журнала подписи, чтобы PDF совпадал с подписанным. */
  const signedContract = (o: OrderRow) => (o.signature ? (JSON.parse(o.signature).payload?.data as ContractData | undefined) : undefined);

  app.get("/api/health", async () => ({ ok: true }));

  // --- Партнёрская ссылка: кэшбэк хранится на сервере, в URL только токен ---
  app.get<{ Params: { token: string } }>("/api/partner-links/:token", async (req, reply) => {
    const row = db.prepare("SELECT partner, cashback FROM partner_links WHERE token = ?").get(req.params.token) as
      | { partner: string; cashback: number } | undefined;
    if (!row) return reply.code(404).send({ error: "Ссылка не найдена" });
    return { partner: row.partner, cashback: row.cashback };
  });

  // --- Вход клиента по SMS: цену видит только подтверждённый номер ---
  function clientPhone(req: FastifyRequest): string | undefined {
    const token = cookie(req, CLIENT_COOKIE);
    if (!token) return undefined;
    const row = db.prepare("SELECT phone FROM client_sessions WHERE token_hash = ? AND expires_at > ?").get(sha256(token), now().getTime()) as
      | { phone: string } | undefined;
    return row?.phone;
  }

  /** Номер, статус партнёра и можно ли сегодня оформить ещё один автомобиль. */
  const clientView = (phone: string) => ({
    phone, partner: partnerRequest(db, phone)?.status ?? null, canOrder: canOrder(db, phone, now()), ordersPerDay: CLIENT_ORDERS_PER_DAY,
  });

  app.get("/api/auth/me", async (req, reply) => {
    const phone = clientPhone(req);
    return phone ? clientView(phone) : reply.code(401).send({ error: "Подтвердите номер телефона" });
  });

  app.post<{ Body: { phone: string; captcha?: string } }>("/api/auth/code", async (req, reply) => {
    const phone = normalizePhone(String(req.body?.phone ?? ""));
    if (!phone) return reply.code(400).send({ error: "Укажите номер мобильного телефона", errors: { phone: "Укажите номер мобильного телефона" } });
    if (guard.isBlocked(phone, req.ip)) {
      guard.log("blocked", req.ip, phone, "вход");
      return reply.code(403).send({ error: BLOCKED_ERROR });
    }
    if (opts.captcha && guard.captchaNeeded(phone, req.ip)) {
      const token = String(req.body?.captcha ?? "");
      if (!token) return reply.code(428).send({ error: "Подтвердите, что вы не робот", captcha: opts.captcha.siteKey });
      if (!(await opts.captcha.verify(token, req.ip))) {
        guard.log("captcha_failed", req.ip, phone);
        return reply.code(428).send({ error: "Проверка не пройдена, попробуйте ещё раз", captcha: opts.captcha.siteKey });
      }
    }
    const denied = guard.smsDenied(phone, req.ip, true);
    if (denied) return reply.code(429).send({ error: denied });
    const code = String(randomInt(0, 10000)).padStart(4, "0");
    db.prepare(`INSERT INTO login_codes (phone, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
                ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`)
      .run(phone, sha256(phone + code), now().getTime() + CODE_TTL_MS);
    try {
      await sms.send(phone, `Brookclean: код для входа ${code}. Никому не сообщайте.`);
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Не удалось отправить SMS. Попробуйте ещё раз через минуту." });
    }
    guard.recordSms(phone, req.ip, "login");
    return { ok: true, phone, ...(opts.exposeSmsCode ? { devCode: code } : {}) };
  });

  app.post<{ Body: { phone: string; code: string } }>("/api/auth/verify", async (req, reply) => {
    const phone = normalizePhone(String(req.body?.phone ?? ""));
    const c = db.prepare("SELECT * FROM login_codes WHERE phone = ?").get(phone) as
      | { code_hash: string; expires_at: number; attempts: number } | undefined;
    if (!c || now().getTime() > c.expires_at) return reply.code(410).send({ error: "Код устарел, запросите новый" });
    if (c.attempts >= MAX_ATTEMPTS) return reply.code(429).send({ error: "Слишком много попыток, запросите новый код" });
    const code = String(req.body?.code ?? "").replace(/\D/g, "");
    if (sha256(phone + code) !== c.code_hash) {
      db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE phone = ?").run(phone);
      if (c.attempts + 1 === MAX_ATTEMPTS) guard.log("bad_code", req.ip, phone, "вход");
      return reply.code(400).send({ error: "Неверный код" });
    }
    db.prepare("DELETE FROM login_codes WHERE phone = ?").run(phone);
    const token = randomToken(24);
    const t = now().getTime();
    db.prepare("INSERT INTO client_sessions (token_hash, phone, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), phone, t, t + CLIENT_SESSION_DAYS * 86_400_000);
    reply.header("set-cookie",
      `${CLIENT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CLIENT_SESSION_DAYS * 86400}${secureCookies ? "; Secure" : ""}`);
    return clientView(phone);
  });

  // --- Карточка партнёра: реквизиты компании, после проверки менеджером — больше одного автомобиля в сутки ---
  app.get("/api/partner", async (req, reply) => {
    const phone = clientPhone(req);
    if (!phone) return reply.code(401).send({ error: "Подтвердите номер телефона" });
    return partnerRequest(db, phone) ?? null;
  });

  app.post<{ Body: { company: CompanyForm } }>("/api/partner", async (req, reply) => {
    const phone = clientPhone(req);
    if (!phone) return reply.code(401).send({ error: "Подтвердите номер телефона" });
    const company = req.body?.company;
    if (!company) return reply.code(400).send({ error: "Нет реквизитов" });
    const errors = validateCompany(company);
    if (Object.keys(errors).length) return reply.code(400).send({ error: "Проверьте реквизиты", errors });
    if (isPartner(db, phone)) return reply.code(409).send({ error: "Вы уже партнёр" });
    const clean = Object.fromEntries(Object.entries(company).map(([k, v]) => [k, String(v ?? "").trim().slice(0, 300)]));
    db.prepare(`INSERT INTO partner_requests (phone, created_at, status, company) VALUES (?, ?, 'pending', ?)
                ON CONFLICT(phone) DO UPDATE SET created_at = excluded.created_at, status = 'pending', company = excluded.company,
                reviewed_at = NULL, reviewed_by = NULL`)
      .run(phone, now().toISOString(), JSON.stringify(clean));
    return partnerRequest(db, phone);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = cookie(req, CLIENT_COOKIE);
    if (token) db.prepare("DELETE FROM client_sessions WHERE token_hash = ?").run(sha256(token));
    reply.header("set-cookie", `${CLIENT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  /** Общая проверка для расчёта и заказа: вход, чёрный список, лимит вариантов. */
  function quoteFor(req: FastifyRequest, reply: FastifyReply, car: CarForm | undefined, partnerToken?: string): Quote | undefined {
    const phone = clientPhone(req);
    if (!phone) return void reply.code(401).send({ error: "Подтвердите номер телефона, чтобы увидеть цену" });
    if (guard.isBlocked(phone, req.ip)) {
      guard.log("blocked", req.ip, phone, "расчёт");
      return void reply.code(403).send({ error: BLOCKED_ERROR });
    }
    // Лимит автомобилей на сегодня исчерпан: цену не показываем, только карточка партнёра
    if (!canOrder(db, phone, now())) return void reply.code(403).send({ error: PARTNER_ERROR, needPartner: true });
    if (!car || !CITIES.includes(car.city) || !(car.body in BODY)) return void reply.code(400).send({ error: "Выберите город" });
    // Партнёрам с проверенными реквизитами лимит вариантов не нужен
    const denied = isPartner(db, phone) ? undefined : guard.quoteDenied(phone, req.ip, car.city, car.body as BodyType);
    if (denied) return void reply.code(429).send({ error: denied });
    return quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback: partnerCashback(partnerToken)?.cashback });
  }

  app.post<{ Body: { car: CarForm; partnerToken?: string } }>("/api/quote", async (req, reply) => {
    const q = quoteFor(req, reply, req.body?.car, req.body?.partnerToken);
    return q ?? reply;
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
      const sessionPhone = clientPhone(req);
      if (!sessionPhone) return reply.code(401).send({ error: "Подтвердите номер телефона" });
      if (!car || !customer) return reply.code(400).send({ error: "Нет данных заказа" });
      const errors = { ...validateCar(car, now()), ...validateCustomer(customer) };
      if (Object.keys(errors).length) return reply.code(400).send({ error: "Проверьте поля", errors });
      if (!consents?.contract || !consents?.pep || !consents?.personalData)
        return reply.code(400).send({ error: "Нужны все три согласия" });

      const phone = normalizePhone(customer.phone);
      // Договор подписывается кодом на тот же номер, которым клиент вошёл
      if (phone !== sessionPhone)
        return reply.code(400).send({ error: "Проверьте поля", errors: { phone: "Укажите номер, который вы подтвердили кодом" } });
      if (!canOrder(db, phone, now())) return reply.code(403).send({ error: PARTNER_ERROR, needPartner: true });
      const q = quoteFor(req, reply, car, partnerToken);
      if (!q) return reply;
      const denied = guard.smsDenied(phone, req.ip, false, isPartner(db, phone));
      if (denied) return reply.code(429).send({ error: denied });
      const partner = partnerCashback(partnerToken);
      const id = randomUUID();
      const no = nextOrderNo(db);
      db.prepare(`INSERT INTO orders (id, no, created_at, status, car, customer, phone, partner, cashback, quote)
                  VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`)
        .run(id, no, now().toISOString(), JSON.stringify(car), JSON.stringify({ ...customer, phone }), phone,
          partner?.partner ?? null, partner?.cashback ?? 0, JSON.stringify(q));
      let devCode: string | undefined;
      try {
        devCode = await sendCode(id, no, phone);
        guard.recordSms(phone, req.ip, "sign");
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
    const denied = guard.smsDenied(o.phone, req.ip, false, isPartner(db, o.phone));
    if (denied) return reply.code(429).send({ error: denied });
    try {
      const devCode = await sendCode(o.id, o.no, o.phone);
      guard.recordSms(o.phone, req.ip, "sign");
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
    // Два черновика, открытых параллельно, не дают обойти лимит: проверяем ещё раз при подписи
    if (o.created_by === null && !canOrder(db, o.phone, now(), o.id))
      return reply.code(403).send({ error: PARTNER_ERROR, needPartner: true });
    const code = String(req.body?.code ?? "").replace(/\D/g, "");
    if (sha256(o.id + code) !== c.code_hash) {
      db.prepare("UPDATE sms_codes SET attempts = attempts + 1 WHERE order_id = ?").run(o.id);
      return reply.code(400).send({ error: "Неверный код" });
    }

    const signedAt = now();
    const payload = contractPayload(orderContract(o));
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
    // Код из SMS только что подтвердил владельца номера: отдаём подписанный договор для PDF
    return { ...publicOrder(getOrder(o.id)!), contract: payload.data };
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => {
    const o = getOrder(req.params.id);
    if (!o) return reply.code(404).send({ error: "Заказ не найден" });
    // Подписанный договор целиком (с паспортом) видит только вошедший владелец номера
    if (o.status !== "draft") return { ...publicOrder(o), contract: clientPhone(req) === o.phone ? signedContract(o) : undefined };
    // Неподписанная заявка: данные для текста договора, паспорт частично скрыт
    const contract = orderContract(o);
    const c = contract.customer;
    return { ...publicOrder(o), contract: { ...contract, customer: { ...c, passportNumber: "••••" + c.passportNumber.slice(-2) } } };
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
    db, sms, now, publicUrl, adminToken: opts.adminToken, drive: opts.drive, guard, vision: opts.vision,
    secureCookies: (opts.staffUrl ?? publicUrl).startsWith("https://") && process.env.NODE_ENV === "production",
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

  // --- Панель сотрудников на отдельном адресе: на сайте клиента её API, страниц и кода нет ---
  const staffHost = opts.staffUrl ? new URL(opts.staffUrl).host : undefined;
  const isStaffHost = (req: FastifyRequest) => !staffHost || req.host === staffHost;
  const webDist = opts.webDist && existsSync(opts.webDist) ? opts.webDist : undefined;
  // Список файлов, которые нужны только панели, пишет сборка (web/vite.config.ts)
  const adminFiles = new Set<string>(webDist && existsSync(join(webDist, "admin-assets.json"))
    ? JSON.parse(readFileSync(join(webDist, "admin-assets.json"), "utf8")) as string[] : []);
  const isAdminPath = (path: string) =>
    path === "/admin" || path.startsWith("/admin/") || path === "/admin.html" || path.startsWith("/api/staff/") || path === "/api/google/callback" ||
    path === "/admin-assets.json" || adminFiles.has(path.slice(1));

  app.addHook("onRequest", async (req, reply) => {
    if (!staffHost) return;
    const path = req.url.split("?")[0];
    if (isStaffHost(req)) {
      if (path === "/") return reply.redirect("/admin");
    } else if (isAdminPath(path)) {
      if (path.startsWith("/api/")) return reply.code(404).send({ error: "Не найдено" });
      // Для посетителя сайта клиента такой страницы просто нет
      return webDist ? reply.type("text/html").sendFile("index.html") : reply.code(404).send({ error: "Не найдено" });
    }
  });

  // --- Сайт (PWA): собранный web/dist, все не-API пути отдают index.html (на адресе панели — admin.html) ---
  if (webDist) {
    app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Не найдено" });
      const admin = staffHost ? isStaffHost(req) : req.url.startsWith("/admin");
      return reply.sendFile(admin ? "admin.html" : "index.html");
    });
  }

  return app;
}
