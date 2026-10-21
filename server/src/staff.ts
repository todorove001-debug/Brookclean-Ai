// Панель управления: вход сотрудников, права, заявки, рейсы, отчёты, сотрудники.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  BODY, NET, PAY_FORM, PAY_TO, ROLES, can, isRole, kmTo, normalizePhone, parseRub, quote, rub, routeFor,
  validateCar, validateCustomer,
  type CarForm, type CustomerForm, type OrderRowView, type OrderStatus, type Permission, type Quote, type Role,
  type StaffMe, type TripView,
} from "@brookclean/shared";
import { nextOrderNo, type DB } from "./db.ts";
import { sha256 } from "./contract.ts";
import { GoogleDrive, getSetting, sheetUrl, toCsv } from "./drive.ts";
import type { SmsSender } from "./sms.ts";

export interface StaffContext {
  db: DB;
  sms: SmsSender;
  now: () => Date;
  publicUrl: string;
  adminToken?: string;
  drive?: GoogleDrive;
  secureCookies: boolean;
  requestReview: (no: number, log: { error: (e: unknown) => void }) => Promise<void>;
  randomToken: (len?: number) => string;
}

const SESSION_DAYS = 30;
const COOKIE = "bc_sid";

// --- Пароли ---
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString("hex")}`;
}
function checkPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const got = scryptSync(password, salt, 32);
  const exp = Buffer.from(hash, "hex");
  return got.length === exp.length && timingSafeEqual(got, exp);
}

/** Первый владелец из переменных окружения, если сотрудников ещё нет. */
export function ensureOwner(db: DB, login?: string, password?: string, name = "Владелец") {
  if (!login || !password) return;
  const count = (db.prepare("SELECT COUNT(*) AS n FROM staff").get() as { n: number }).n;
  if (count) return;
  db.prepare("INSERT INTO staff (name, login, pass_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
    .run(name, login.trim().toLowerCase(), hashPassword(password), new Date().toISOString());
}

interface StaffRow { id: number; name: string; login: string; pass_hash: string; role: Role; active: number; created_at: string }
interface OrderRow {
  id: string; no: number; created_at: string; status: OrderStatus; car: string; customer: string; phone: string;
  partner: string | null; cashback: number; quote: string; track_token: string | null; trip_id: string | null; signed_at: string | null;
}
interface TripRow {
  id: string; dest: string; truck: string; driver: string; load_date: string | null; km: number;
  drive_file_id: string | null; drive_synced_at: string | null; drive_error: string | null;
}

declare module "fastify" {
  interface FastifyRequest { staff?: StaffMe }
}

function cookie(req: FastifyRequest, name: string) {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const shortName = (fio: string) => {
  const [f, i, o] = fio.trim().split(/\s+/);
  return [f, i ? i[0] + "." : "", o ? o[0] + "." : ""].filter(Boolean).join(" ");
};
const STATUS_RU: Record<string, string> = {
  draft: "ждёт подписи", signed: "подписан", paid: "оплачен", loading: "погрузка", in_transit: "в пути", arrived: "прибыл", delivered: "выдан",
};
const maskPhone = (p: string) => (p.length === 12 ? `${p.slice(0, 2)} ${p.slice(2, 5)} ***-**-${p.slice(-2)}` : p);

export function registerStaff(app: FastifyInstance, ctx: StaffContext) {
  const { db, now } = ctx;
  const failed = new Map<string, { n: number; until: number }>();

  function meFor(s: Pick<StaffRow, "id" | "name" | "login" | "role">): StaffMe {
    return { id: s.id, name: s.name, login: s.login, role: s.role, perms: [...ROLES[s.role].perms] };
  }

  function authenticate(req: FastifyRequest): StaffMe | undefined {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (bearer && ctx.adminToken) {
      const a = Buffer.from(bearer), b = Buffer.from(ctx.adminToken);
      if (a.length === b.length && timingSafeEqual(a, b)) return meFor({ id: 0, name: "API", login: "api", role: "owner" });
    }
    const sid = cookie(req, COOKIE);
    if (!sid) return undefined;
    const row = db.prepare(`SELECT s.* FROM sessions x JOIN staff s ON s.id = x.staff_id
                            WHERE x.token_hash = ? AND x.expires_at > ? AND s.active = 1`).get(sha256(sid), now().getTime()) as StaffRow | undefined;
    return row ? meFor(row) : undefined;
  }

  const need = (...perms: Permission[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = authenticate(req);
    if (!me) return reply.code(401).send({ error: "Войдите в панель" });
    if (!perms.every((p) => can(me.role, p))) return reply.code(403).send({ error: "Нет доступа к этому разделу" });
    req.staff = me;
  };

  const audit = (req: FastifyRequest, action: string, details: unknown) =>
    db.prepare("INSERT INTO audit (at, staff_id, action, details) VALUES (?, ?, ?, ?)")
      .run(now().toISOString(), req.staff?.id ?? null, action, JSON.stringify(details));

  // --- Вход ---
  app.post<{ Body: { login: string; password: string } }>("/api/staff/login", async (req, reply) => {
    const login = String(req.body?.login ?? "").trim().toLowerCase();
    const f = failed.get(login);
    if (f && f.n >= 5 && f.until > Date.now()) return reply.code(429).send({ error: "Слишком много попыток. Подождите 15 минут." });
    const s = db.prepare("SELECT * FROM staff WHERE login = ? AND active = 1").get(login) as StaffRow | undefined;
    if (!s || !checkPassword(String(req.body?.password ?? ""), s.pass_hash)) {
      failed.set(login, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      return reply.code(401).send({ error: "Неверный логин или пароль" });
    }
    failed.delete(login);
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)")
      .run(sha256(token), s.id, now().getTime() + SESSION_DAYS * 86_400_000);
    reply.header("set-cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${ctx.secureCookies ? "; Secure" : ""}`);
    return meFor(s);
  });

  app.post("/api/staff/logout", async (req, reply) => {
    const sid = cookie(req, COOKIE);
    if (sid) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(sid));
    reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  app.get("/api/staff/me", async (req, reply) => {
    const me = authenticate(req);
    if (!me) return reply.code(401).send({ error: "Войдите в панель" });
    return me;
  });

  // --- Заявки ---
  function rowView(o: OrderRow, personal: boolean): OrderRowView {
    const car = JSON.parse(o.car) as CarForm;
    const customer = JSON.parse(o.customer) as CustomerForm;
    const q = JSON.parse(o.quote) as Quote;
    const p = db.prepare("SELECT * FROM payments WHERE order_id = ?").get(o.id) as
      | { paid_delivery: number; paid_insurance: number; pay_to: string; pay_form: string } | undefined;
    return {
      no: o.no, id: o.id, createdAt: o.created_at, status: o.status, car: car.car, vin: car.vin.toUpperCase(), year: car.year,
      color: car.color, body: BODY[car.body].name, city: car.city,
      client: personal ? customer.fio : shortName(customer.fio), phone: personal ? o.phone : maskPhone(o.phone),
      partner: o.partner, tariff: q.tariff, cashback: q.cashback, delivery: q.delivery, value: parseRub(car.value),
      insurance: q.insurance, total: q.total, paidDelivery: !!p?.paid_delivery, paidInsurance: !!p?.paid_insurance,
      payTo: p?.pay_to ?? "", payForm: p?.pay_form ?? "", tripId: o.trip_id, trackToken: o.track_token, signedAt: o.signed_at,
    };
  }

  app.get("/api/staff/orders", { preHandler: need("orders.read") }, async (req) => {
    const rows = db.prepare("SELECT * FROM orders ORDER BY no DESC").all() as unknown as OrderRow[];
    return rows.map((o) => rowView(o, can(req.staff!.role, "orders.personal")));
  });

  // Заявку оформляет менеджер, клиент получает SMS со ссылкой и подписывает сам
  app.post<{ Body: { car: CarForm; customer: CustomerForm; cashback?: number; partner?: string } }>(
    "/api/staff/orders", { preHandler: need("orders.create") }, async (req, reply) => {
      const { car, customer } = req.body ?? ({} as never);
      if (!car || !customer) return reply.code(400).send({ error: "Нет данных заявки" });
      const errors = { ...validateCar(car, now()), ...validateCustomer(customer) };
      if (Object.keys(errors).length) return reply.code(400).send({ error: "Проверьте поля", errors });
      const cashback = Math.max(0, Math.round(Number(req.body.cashback) || 0));
      const q = quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback });
      const id = randomUUID();
      const no = nextOrderNo(db);
      const phone = normalizePhone(customer.phone);
      db.prepare(`INSERT INTO orders (id, no, created_at, status, car, customer, phone, partner, cashback, quote, created_by)
                  VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, no, now().toISOString(), JSON.stringify(car), JSON.stringify({ ...customer, phone }), phone,
          req.body.partner?.trim() || null, cashback, JSON.stringify(q), req.staff!.id);
      const signUrl = `${ctx.publicUrl}/o/${id}`;
      let smsSent = true;
      try {
        await ctx.sms.send(phone, `Brookclean Trucks: договор перевозки №${no} готов. Проверьте и подпишите: ${signUrl}`);
      } catch (err) {
        req.log.error(err);
        smsSent = false;
      }
      audit(req, "order.create", { no });
      return { id, no, quote: q, signUrl, smsSent };
    });

  app.patch<{ Params: { no: string }; Body: Partial<{ status: OrderStatus; tripId: string | null; paidDelivery: boolean; paidInsurance: boolean; payTo: string; payForm: string }> }>(
    "/api/staff/orders/:no", { preHandler: need("orders.read") }, async (req, reply) => {
      const o = db.prepare("SELECT * FROM orders WHERE no = ?").get(Number(req.params.no)) as OrderRow | undefined;
      if (!o) return reply.code(404).send({ error: "Заявка не найдена" });
      const b = req.body ?? {};
      const role = req.staff!.role;
      const touchesOrder = "status" in b || "tripId" in b;
      const touchesPay = ["paidDelivery", "paidInsurance", "payTo", "payForm"].some((k) => k in b);
      if ((touchesOrder && !can(role, "orders.edit")) || (touchesPay && !can(role, "payments.edit")))
        return reply.code(403).send({ error: "Нет доступа к этому полю" });

      if ("status" in b) {
        const allowed: OrderStatus[] = ["signed", "paid", "loading", "in_transit", "arrived", "delivered"];
        if (!allowed.includes(b.status!) || o.status === "draft") return reply.code(400).send({ error: "Нельзя поставить этот статус" });
        db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(b.status!, o.id);
        if (b.status === "delivered") await ctx.requestReview(o.no, req.log);
      }
      if ("tripId" in b) {
        const tripId = b.tripId || null;
        if (tripId) {
          const t = db.prepare("SELECT dest FROM trips WHERE id = ?").get(tripId) as { dest: string } | undefined;
          if (!t) return reply.code(400).send({ error: "Рейс не найден" });
          if (!routeFor(t.dest).includes((JSON.parse(o.car) as CarForm).city)) return reply.code(400).send({ error: "Город заявки не на маршруте рейса" });
        }
        db.prepare("UPDATE orders SET trip_id = ?, status = CASE WHEN status IN ('signed','paid') AND ? IS NOT NULL THEN 'loading' ELSE status END WHERE id = ?")
          .run(tripId, tripId, o.id);
        if (o.trip_id && o.trip_id !== tripId) scheduleSync(o.trip_id);
      }
      if (touchesPay) {
        if (b.payTo !== undefined && b.payTo !== "" && !PAY_TO.includes(b.payTo)) return reply.code(400).send({ error: "Неизвестный получатель оплаты" });
        if (b.payForm !== undefined && b.payForm !== "" && !PAY_FORM.includes(b.payForm)) return reply.code(400).send({ error: "Неизвестная форма оплаты" });
        db.prepare("INSERT OR IGNORE INTO payments (order_id) VALUES (?)").run(o.id);
        const map = { paidDelivery: "paid_delivery", paidInsurance: "paid_insurance", payTo: "pay_to", payForm: "pay_form" } as const;
        for (const [k, col] of Object.entries(map)) {
          if (k in b) {
            const v = b[k as keyof typeof b];
            db.prepare(`UPDATE payments SET ${col} = ? WHERE order_id = ?`).run(typeof v === "boolean" ? Number(v) : String(v ?? ""), o.id);
          }
        }
        const p = db.prepare("SELECT paid_delivery, paid_insurance FROM payments WHERE order_id = ?").get(o.id) as { paid_delivery: number; paid_insurance: number };
        if (p.paid_delivery && p.paid_insurance) db.prepare("UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'signed'").run(o.id);
      }
      audit(req, "order.update", { no: o.no, ...b });
      const fresh = db.prepare("SELECT * FROM orders WHERE id = ?").get(o.id) as unknown as OrderRow;
      if (fresh.trip_id) scheduleSync(fresh.trip_id);
      return rowView(fresh, can(role, "orders.personal"));
    });

  // --- Рейсы ---
  function tripView(t: TripRow): TripView {
    const orders = (db.prepare("SELECT no FROM orders WHERE trip_id = ? ORDER BY no").all(t.id) as Array<{ no: number }>).map((x) => x.no);
    const events = db.prepare("SELECT at, city, note FROM trip_events WHERE trip_id = ? ORDER BY at").all(t.id) as TripView["events"];
    return {
      id: t.id, dest: t.dest, truck: t.truck, driver: t.driver, loadDate: t.load_date, km: t.km,
      status: t.km >= kmTo(t.dest) && t.km > 0 ? "arrived" : t.km > 0 ? "in_transit" : "loading",
      orders, driveUrl: t.drive_file_id ? sheetUrl(t.drive_file_id) : null, driveError: t.drive_error,
      driveSyncedAt: t.drive_synced_at, events,
    };
  }
  const getTrip = (id: string) => db.prepare("SELECT * FROM trips WHERE id = ?").get(id) as TripRow | undefined;

  app.get("/api/staff/trips", { preHandler: need("trips.read") }, async () =>
    (db.prepare("SELECT * FROM trips ORDER BY load_date DESC, id DESC").all() as unknown as TripRow[]).map(tripView));

  app.put<{ Params: { id: string }; Body: { dest: string; truck: string; driver?: string; loadDate?: string } }>(
    "/api/staff/trips/:id", { preHandler: need("trips.edit") }, async (req, reply) => {
      const { dest, truck, driver, loadDate } = req.body ?? ({} as never);
      if (!/^[\w-]{1,20}$/.test(req.params.id)) return reply.code(400).send({ error: "Номер рейса: буквы, цифры и дефис" });
      if (!NET[dest] || !truck?.trim()) return reply.code(400).send({ error: "Укажите город назначения и автовоз" });
      db.prepare(`INSERT INTO trips (id, dest, truck, driver, load_date) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET dest = excluded.dest, truck = excluded.truck, driver = excluded.driver, load_date = excluded.load_date`)
        .run(req.params.id, dest, truck.trim(), (driver ?? "").trim(), loadDate || null);
      audit(req, "trip.save", { id: req.params.id });
      scheduleSync(req.params.id);
      return tripView(getTrip(req.params.id)!);
    });

  app.post<{ Params: { id: string }; Body: { city: string; note?: string } }>(
    "/api/staff/trips/:id/position", { preHandler: need("trips.edit") }, async (req, reply) => {
      const trip = getTrip(req.params.id);
      if (!trip) return reply.code(404).send({ error: "Рейс не найден" });
      const city = req.body?.city;
      if (!routeFor(trip.dest).includes(city)) return reply.code(400).send({ error: "Город не на маршруте рейса" });
      const km = kmTo(city);
      db.prepare("UPDATE trips SET km = ? WHERE id = ?").run(km, trip.id);
      db.prepare("INSERT INTO trip_events (trip_id, at, city, note) VALUES (?, ?, ?, ?)")
        .run(trip.id, now().toISOString(), city, req.body?.note?.trim() || (km ? "В пути" : "Погрузка"));
      // Статусы машин рейса: в пути / прибыл — по километражу до города каждой машины
      const orders = db.prepare("SELECT id, car, status FROM orders WHERE trip_id = ?").all(trip.id) as Array<{ id: string; car: string; status: OrderStatus }>;
      for (const o of orders) {
        if (o.status === "delivered") continue;
        const dest = kmTo((JSON.parse(o.car) as CarForm).city);
        const status: OrderStatus = km >= dest ? "arrived" : km > 0 ? "in_transit" : "loading";
        db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, o.id);
      }
      audit(req, "trip.position", { id: trip.id, city });
      scheduleSync(trip.id);
      return tripView(getTrip(trip.id)!);
    });

  // --- Рейсовый отчёт ---
  function tripReport(t: TripRow) {
    const orders = db.prepare("SELECT * FROM orders WHERE trip_id = ? ORDER BY no").all(t.id) as unknown as OrderRow[];
    const rows = orders.map((o) => rowView(o, false));
    const events = db.prepare("SELECT at, city, note FROM trip_events WHERE trip_id = ? ORDER BY at").all(t.id) as TripView["events"];
    const last = events.at(-1);
    const fmt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Vladivostok" });
    const sum = (f: (r: OrderRowView) => number) => rows.reduce((s, r) => s + f(r), 0);
    return [
      [`Рейсовый отчёт ${t.id}`, `Владивосток → ${t.dest}`],
      ["Автовоз", t.truck], ["Водитель", t.driver || "—"], ["Дата погрузки", t.load_date ?? "—"],
      ["Текущая точка", last ? `${last.city}, ${fmt(last.at)}` : "Владивосток, погрузка"],
      ["Машин", rows.length], ["Обновлено", fmt(now().toISOString())],
      [],
      ["№", "Автомобиль", "VIN / кузов", "Год", "Цвет", "Кузов", "Город выдачи", "Км", "Получатель", "Телефон", "Перевозка", "Страховка", "Итого", "Перевозка оплачена", "Страховка оплачена", "Кому", "Форма", "Статус"],
      ...rows.map((r) => [r.no, r.car, r.vin, r.year, r.color, r.body, r.city, kmTo(r.city), r.client, r.phone, r.delivery, r.insurance, r.total,
        r.paidDelivery ? "да" : "нет", r.paidInsurance ? "да" : "нет", r.payTo, r.payForm, STATUS_RU[r.status] ?? r.status]),
      ["Итого", "", "", "", "", "", "", "", "", "", sum((r) => r.delivery), sum((r) => r.insurance), sum((r) => r.total),
        `не оплачено: ${rub(sum((r) => (r.paidDelivery ? 0 : r.delivery) + (r.paidInsurance ? 0 : r.insurance)))}`],
      [],
      ["История движения"],
      ...events.map((e) => [fmt(e.at), e.city, e.note]),
    ];
  }

  app.get<{ Params: { id: string } }>("/api/staff/trips/:id/report.csv", { preHandler: need("reports.read") }, async (req, reply) => {
    const t = getTrip(req.params.id);
    if (!t) return reply.code(404).send({ error: "Рейс не найден" });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="trip-${t.id}.csv"`);
    return "﻿" + toCsv(tripReport(t)); // BOM — чтобы Excel открыл кириллицу
  });

  // Автозагрузка в Google Диск: после каждого изменения рейса, с задержкой, чтобы не дёргать Google на каждый клик
  const timers = new Map<string, NodeJS.Timeout>();
  function scheduleSync(tripId: string) {
    if (!ctx.drive?.connected) return;
    clearTimeout(timers.get(tripId));
    timers.set(tripId, setTimeout(() => {
      timers.delete(tripId);
      syncTrip(tripId).catch((e) => app.log.error(e));
    }, 5_000).unref());
  }
  async function syncTrip(tripId: string) {
    const t = getTrip(tripId);
    if (!t || !ctx.drive) return;
    try {
      const id = await ctx.drive.upsertSheet(`Рейс ${t.id} · ${t.dest} · ${t.load_date ?? ""}`.trim(), toCsv(tripReport(t)), t.drive_file_id);
      db.prepare("UPDATE trips SET drive_file_id = ?, drive_synced_at = ?, drive_error = NULL WHERE id = ?").run(id, now().toISOString(), t.id);
    } catch (e) {
      db.prepare("UPDATE trips SET drive_error = ? WHERE id = ?").run((e as Error).message, t.id);
      throw e;
    }
  }

  app.post<{ Params: { id: string } }>("/api/staff/trips/:id/sync", { preHandler: need("reports.read") }, async (req, reply) => {
    if (!ctx.drive?.connected) return reply.code(409).send({ error: "Google Диск не подключён" });
    if (!getTrip(req.params.id)) return reply.code(404).send({ error: "Рейс не найден" });
    try {
      await syncTrip(req.params.id);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
    return tripView(getTrip(req.params.id)!);
  });

  // --- Google Диск: подключение владельцем ---
  app.get("/api/staff/google", { preHandler: need("reports.read") }, async () => ({
    configured: !!ctx.drive, connected: !!ctx.drive?.connected,
    folderUrl: getSetting(db, "google_folder_id") ? `https://drive.google.com/drive/folders/${getSetting(db, "google_folder_id")}` : null,
  }));

  const oauthStates = new Map<string, number>();
  app.get("/api/staff/google/connect", { preHandler: need("staff.manage") }, async (req, reply) => {
    if (!ctx.drive) return reply.code(409).send({ error: "На сервере не заданы GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET" });
    const state = ctx.randomToken(24);
    oauthStates.set(state, Date.now() + 10 * 60_000);
    return reply.redirect(ctx.drive.authUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/google/callback", async (req, reply) => {
    const { code, state, error } = req.query;
    const ok = state && (oauthStates.get(state) ?? 0) > Date.now();
    if (state) oauthStates.delete(state);
    if (!ctx.drive || !ok || !code || error) return reply.redirect("/admin?google=error");
    try {
      await ctx.drive.finishAuth(code);
    } catch (e) {
      req.log.error(e);
      return reply.redirect("/admin?google=error");
    }
    for (const t of db.prepare("SELECT id FROM trips").all() as Array<{ id: string }>) scheduleSync(t.id);
    return reply.redirect("/admin?google=ok");
  });

  app.post("/api/staff/google/disconnect", { preHandler: need("staff.manage") }, async (req) => {
    ctx.drive?.disconnect();
    audit(req, "google.disconnect", {});
    return { ok: true };
  });

  // --- Отзывы и партнёры ---
  app.get("/api/staff/reviews", { preHandler: need("reviews.read") }, async (req) => {
    const personal = can(req.staff!.role, "orders.personal");
    const rows = db.prepare(`SELECT o.no, o.phone, o.customer, r.rating, r.text, r.created_at AS createdAt
                FROM reviews r JOIN orders o ON o.id = r.order_id ORDER BY r.rating, r.created_at DESC`).all() as Array<
      { no: number; phone: string; customer: string; rating: number; text: string; createdAt: string }>;
    return rows.map(({ customer, phone, ...r }) => {
      const fio = (JSON.parse(customer) as CustomerForm).fio;
      return { ...r, client: personal ? fio : shortName(fio), phone: personal ? phone : maskPhone(phone) };
    });
  });

  app.get("/api/staff/partner-links", { preHandler: need("partners.edit") }, async () =>
    db.prepare("SELECT token, partner, cashback, created_at AS createdAt FROM partner_links ORDER BY created_at DESC").all());

  app.post<{ Body: { partner: string; cashback: number } }>("/api/staff/partner-links", { preHandler: need("partners.edit") }, async (req, reply) => {
    const { partner, cashback } = req.body ?? ({} as never);
    if (!partner?.trim() || !(Number(cashback) >= 0)) return reply.code(400).send({ error: "Укажите партнёра и кэшбэк" });
    const token = ctx.randomToken(10);
    db.prepare("INSERT INTO partner_links (token, partner, cashback, created_at) VALUES (?, ?, ?, ?)")
      .run(token, partner.trim(), Math.round(Number(cashback)), now().toISOString());
    audit(req, "partner.link", { partner, cashback });
    return { token, path: `/?p=${token}`, url: `${ctx.publicUrl}/?p=${token}` };
  });

  // --- Сотрудники ---
  const staffView = (s: StaffRow) => ({ id: s.id, name: s.name, login: s.login, role: s.role, active: !!s.active, createdAt: s.created_at });

  app.get("/api/staff/users", { preHandler: need("staff.manage") }, async () =>
    (db.prepare("SELECT * FROM staff ORDER BY active DESC, name").all() as unknown as StaffRow[]).map(staffView));

  app.post<{ Body: { name: string; login: string; password: string; role: Role } }>(
    "/api/staff/users", { preHandler: need("staff.manage") }, async (req, reply) => {
      const { name, login, password, role } = req.body ?? ({} as never);
      if (!name?.trim() || !login?.trim()) return reply.code(400).send({ error: "Укажите имя и логин" });
      if (!password || password.length < 8) return reply.code(400).send({ error: "Пароль не короче 8 символов" });
      if (!isRole(role)) return reply.code(400).send({ error: "Выберите роль" });
      try {
        const r = db.prepare("INSERT INTO staff (name, login, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(name.trim(), login.trim().toLowerCase(), hashPassword(password), role, now().toISOString());
        audit(req, "staff.create", { login, role });
        return staffView(db.prepare("SELECT * FROM staff WHERE id = ?").get(r.lastInsertRowid) as unknown as StaffRow);
      } catch {
        return reply.code(409).send({ error: "Такой логин уже есть" });
      }
    });

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; role: Role; active: boolean; password: string }> }>(
    "/api/staff/users/:id", { preHandler: need("staff.manage") }, async (req, reply) => {
      const id = Number(req.params.id);
      const s = db.prepare("SELECT * FROM staff WHERE id = ?").get(id) as StaffRow | undefined;
      if (!s) return reply.code(404).send({ error: "Сотрудник не найден" });
      const b = req.body ?? {};
      const owners = (db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'owner' AND active = 1").get() as { n: number }).n;
      const losesOwner = s.role === "owner" && s.active && ((b.role && b.role !== "owner") || b.active === false);
      if (losesOwner && owners <= 1) return reply.code(400).send({ error: "Нельзя убрать последнего владельца" });
      if (b.role !== undefined && !isRole(b.role)) return reply.code(400).send({ error: "Неизвестная роль" });
      if (b.password !== undefined && b.password.length < 8) return reply.code(400).send({ error: "Пароль не короче 8 символов" });
      if (b.name?.trim()) db.prepare("UPDATE staff SET name = ? WHERE id = ?").run(b.name.trim(), id);
      if (b.role) db.prepare("UPDATE staff SET role = ? WHERE id = ?").run(b.role, id);
      if (b.active !== undefined) db.prepare("UPDATE staff SET active = ? WHERE id = ?").run(Number(b.active), id);
      if (b.password) db.prepare("UPDATE staff SET pass_hash = ? WHERE id = ?").run(hashPassword(b.password), id);
      // Выключенный сотрудник или новый пароль — старые входы больше не действуют
      if (b.active === false || b.password) db.prepare("DELETE FROM sessions WHERE staff_id = ?").run(id);
      audit(req, "staff.update", { id, ...b, password: b.password ? "***" : undefined });
      return staffView(db.prepare("SELECT * FROM staff WHERE id = ?").get(id) as unknown as StaffRow);
    });

  app.get("/api/staff/audit", { preHandler: need("staff.manage") }, async () =>
    db.prepare(`SELECT a.at, a.action, a.details, s.name FROM audit a LEFT JOIN staff s ON s.id = a.staff_id
                ORDER BY a.id DESC LIMIT 200`).all());
}
