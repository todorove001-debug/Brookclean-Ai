// Панель управления: вход сотрудников, права, заявки, рейсы, отчёты, сотрудники.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  BODY, EXPENSE_KINDS, NET, PAY_FORM, PAY_TO, ROLES, can, isRole, kmTo, normalizePhone, parseRub, rub, routeFor,
  isDocKind, isSite, canTransfer, TRANSFER_CITY, validateCar, validateCustomer, CAPACITY, REPORT_STATUS, legShare, truckLine, trailerLine,
  type CarForm, type CustomerForm, type OrderRowView, type OrderStatus, type Permission, type Quote, type Role,
  type ExpenseKind, type ReportStatus, type StaffMe, type TripCar, type TripExpense, type TripReport, type TripView, type WaitingCar,
} from "@brookclean/shared";
import { nextOrderNo, nextTripNo, type DB } from "./db.ts";
import { sha256 } from "./contract.ts";
import { GoogleDrive, getSetting, sheetUrl, toCsv } from "./drive.ts";
import type { SmsSender } from "./sms.ts";
import { quote } from "./pricing.ts";
import type { Guard } from "./guard.ts";
import { requestView } from "./partners.ts";
import { VisionError, recognize, type Vision } from "./recognize.ts";
import type { MediaStore } from "./media.ts";
import { registerActs } from "./acts.ts";
import { registerFleet, type DriverRow } from "./fleet.ts";

export interface StaffContext {
  db: DB;
  sms: SmsSender;
  now: () => Date;
  publicUrl: string;
  adminToken?: string;
  drive?: GoogleDrive;
  vision?: Vision;
  /** Фото и видео приёмки (S3). */
  store?: MediaStore;
  secureCookies: boolean;
  guard: Guard;
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

interface StaffRow { id: number; name: string; login: string; pass_hash: string; role: Role; active: number; created_at: string; site: string | null; pending: number; phone: string | null }
interface OrderRow {
  id: string; no: number; created_at: string; status: OrderStatus; car: string; customer: string; phone: string;
  partner: string | null; cashback: number; quote: string; track_token: string | null; trip_id: string | null; signed_at: string | null;
  transfer: string | null; trip2_id: string | null; policy_no: string | null; delivered_at: string | null;
}
export interface TripRow {
  id: string; dest: string; truck: string; driver: string; load_date: string | null; km: number;
  drive_file_id: string | null; drive_synced_at: string | null; drive_error: string | null;
  driver_id: number | null; odometer_start: number | null; odometer_end: number | null; closed_at: string | null;
  trailer: string; carrier: string; reg_driver_id: number | null; formed_at: string | null; advance: number;
  report_status: ReportStatus; report_comment: string; submitted_at: string | null; accepted_at: string | null;
}

declare module "fastify" {
  interface FastifyRequest { staff?: StaffMe }
}

export function cookie(req: FastifyRequest, name: string) {
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
const REPORT_RU = Object.fromEntries(Object.entries(REPORT_STATUS).map(([k, [ru]]) => [k, ru])) as Record<ReportStatus, string>;
export interface TripBody {
  dest?: string; truck?: string; trailer?: string; carrier?: string; driver?: string; driverId?: number | null; regDriverId?: number | null;
  loadDate?: string; odometerStart?: number | string | null; advance?: number | string;
}
const STATUS_RU: Record<string, string> = {
  draft: "ждёт подписи", signed: "подписан", paid: "оплачен", loading: "погрузка", in_transit: "в пути", arrived: "прибыл", delivered: "выдан",
};
const maskPhone = (p: string) => (p.length === 12 ? `${p.slice(0, 2)} ${p.slice(2, 5)} ***-**-${p.slice(-2)}` : p);

export function registerStaff(app: FastifyInstance, ctx: StaffContext) {
  const { db, now } = ctx;
  const failed = new Map<string, { n: number; until: number }>();

  function meFor(s: Pick<StaffRow, "id" | "name" | "login" | "role"> & { site?: string | null }): StaffMe {
    return { id: s.id, name: s.name, login: s.login, role: s.role, perms: [...ROLES[s.role].perms], site: s.site ?? null };
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

  const needAny = (...perms: Permission[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = authenticate(req);
    if (!me) return reply.code(401).send({ error: "Войдите в панель" });
    if (!perms.some((p) => can(me.role, p))) return reply.code(403).send({ error: "Нет доступа к этому разделу" });
    req.staff = me;
  };
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
    // Самостоятельно зарегистрированные входят по телефону в любом написании
    const asPhone = /^[\d\s()+-]+$/.test(login) ? normalizePhone(login) : "";
    const s = db.prepare("SELECT * FROM staff WHERE login IN (?, ?) AND (active = 1 OR pending = 1)").get(login, asPhone || login) as StaffRow | undefined;
    if (!s || !checkPassword(String(req.body?.password ?? ""), s.pass_hash)) {
      failed.set(login, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      return reply.code(401).send({ error: "Неверный логин или пароль" });
    }
    failed.delete(login);
    if (s.pending) return reply.code(403).send({ error: "Заявка на доступ ждёт подтверждения менеджером" });
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
      payTo: p?.pay_to ?? "", payForm: p?.pay_form ?? "", tripId: o.trip_id, transfer: o.transfer, trip2Id: o.trip2_id, trackToken: o.track_token, signedAt: o.signed_at,
      policyNo: o.policy_no ?? "",
    };
  }

  app.get("/api/staff/orders", { preHandler: need("orders.read") }, async (req) => {
    const rows = db.prepare("SELECT * FROM orders ORDER BY no DESC").all() as unknown as OrderRow[];
    return rows.map((o) => rowView(o, can(req.staff!.role, "orders.personal")));
  });

  // Расчёт для формы «Оформить заявку»: тарифы есть только на сервере
  app.post<{ Body: { car: CarForm; cashback?: number } }>("/api/staff/quote", { preHandler: need("orders.create") }, async (req, reply) => {
    const car = req.body?.car;
    if (!car || !(car.body in BODY)) return reply.code(400).send({ error: "Выберите город и кузов" });
    return quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback: Math.max(0, Math.round(Number(req.body.cashback) || 0)) });
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

  /** Город, до которого машину везёт первый рейс: терминал перегруза или сам город получателя. */
  const legEnd = (o: Pick<OrderRow, "car" | "transfer">) => o.transfer ?? (JSON.parse(o.car) as CarForm).city;

  app.patch<{ Params: { no: string }; Body: Partial<{ status: OrderStatus; tripId: string | null; transfer: string | null; trip2Id: string | null; paidDelivery: boolean; paidInsurance: boolean; payTo: string; payForm: string; policyNo: string }> }>(
    "/api/staff/orders/:no", { preHandler: need("orders.read") }, async (req, reply) => {
      const o = db.prepare("SELECT * FROM orders WHERE no = ?").get(Number(req.params.no)) as OrderRow | undefined;
      if (!o) return reply.code(404).send({ error: "Заявка не найдена" });
      const b = req.body ?? {};
      const role = req.staff!.role;
      const touchesOrder = "status" in b || "tripId" in b || "transfer" in b || "trip2Id" in b;
      const touchesPay = ["paidDelivery", "paidInsurance", "payTo", "payForm", "policyNo"].some((k) => k in b);
      if ((touchesOrder && !can(role, "orders.edit")) || (touchesPay && !can(role, "payments.edit")))
        return reply.code(403).send({ error: "Нет доступа к этому полю" });

      if ("status" in b) {
        const allowed: OrderStatus[] = ["signed", "paid", "loading", "in_transit", "arrived", "delivered"];
        if (!allowed.includes(b.status!) || o.status === "draft") return reply.code(400).send({ error: "Нельзя поставить этот статус" });
        db.prepare("UPDATE orders SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE NULL END WHERE id = ?")
          .run(b.status!, b.status!, now().toISOString(), o.id);
        if (b.status === "delivered") await ctx.requestReview(o.no, req.log);
      }
      // Перегруз в Новосибирске: первый рейс до терминала, приёмщик терминала принимает и грузит на следующий рейс
      if ("transfer" in b) {
        const transfer = b.transfer || null;
        const city = (JSON.parse(o.car) as CarForm).city;
        if (transfer && (transfer !== TRANSFER_CITY || !canTransfer(city, routeFor)))
          return reply.code(400).send({ error: `Перегруз возможен в ${TRANSFER_CITY}, если город получателя дальше по маршруту` });
        const started = db.prepare("SELECT 1 FROM acts WHERE order_id = ? AND stage != 'priemka'").get(o.id);
        if (!transfer && started) return reply.code(409).send({ error: "Машину уже принимали на терминале: перегруз не отменить" });
        db.prepare("UPDATE orders SET transfer = ?, trip2_id = CASE WHEN ? IS NULL THEN NULL ELSE trip2_id END WHERE id = ?").run(transfer, transfer, o.id);
        o.transfer = transfer;
        // Рейс, который не доходит до нового конца плеча, снимаем: менеджер выберет подходящий
        const t = o.trip_id ? db.prepare("SELECT dest FROM trips WHERE id = ?").get(o.trip_id) as { dest: string } | undefined : undefined;
        if (t && !routeFor(t.dest).includes(legEnd(o)) && !("tripId" in b)) {
          db.prepare("UPDATE orders SET trip_id = NULL, status = CASE WHEN status = 'loading' THEN 'signed' ELSE status END WHERE id = ?").run(o.id);
          scheduleSync(o.trip_id!);
        }
      }
      if ("trip2Id" in b) {
        const trip2 = b.trip2Id || null;
        if (trip2) {
          if (!o.transfer) return reply.code(400).send({ error: "Второй рейс нужен только при перегрузе" });
          const t = db.prepare("SELECT dest FROM trips WHERE id = ?").get(trip2) as { dest: string } | undefined;
          if (!t) return reply.code(400).send({ error: "Рейс не найден" });
          const full = seatError(trip2, o.id);
          if (full) return reply.code(409).send({ error: full });
          const route = routeFor(t.dest), city = (JSON.parse(o.car) as CarForm).city;
          if (!route.includes(o.transfer) || !route.includes(city)) return reply.code(400).send({ error: `Рейс должен идти через ${o.transfer} до города получателя` });
        }
        db.prepare("UPDATE orders SET trip2_id = ? WHERE id = ?").run(trip2, o.id);
        if (o.trip2_id && o.trip2_id !== trip2) scheduleSync(o.trip2_id);
      }
      if ("tripId" in b) {
        const tripId = b.tripId || null;
        if (tripId) {
          const t = db.prepare("SELECT dest FROM trips WHERE id = ?").get(tripId) as { dest: string } | undefined;
          if (!t) return reply.code(400).send({ error: "Рейс не найден" });
          if (!routeFor(t.dest).includes(legEnd(o))) return reply.code(400).send({ error: "Город заявки не на маршруте рейса" });
          const full = seatError(tripId, o.id);
          if (full) return reply.code(409).send({ error: full });
        }
        if (o.trip_id && o.trip_id !== tripId && getTrip(o.trip_id)?.formed_at) return reply.code(409).send({ error: `Рейс ${o.trip_id} сформирован: сначала верните его в формирование` });
        db.prepare("UPDATE orders SET trip_id = ?, status = CASE WHEN status IN ('signed','paid') AND ? IS NOT NULL THEN 'loading' ELSE status END WHERE id = ?")
          .run(tripId, tripId, o.id);
        if (o.trip_id && o.trip_id !== tripId) scheduleSync(o.trip_id);
      }
      if (touchesPay) {
        if (b.payTo !== undefined && b.payTo !== "" && !PAY_TO.includes(b.payTo)) return reply.code(400).send({ error: "Неизвестный получатель оплаты" });
        if (b.payForm !== undefined && b.payForm !== "" && !PAY_FORM.includes(b.payForm)) return reply.code(400).send({ error: "Неизвестная форма оплаты" });
        db.prepare("INSERT OR IGNORE INTO payments (order_id) VALUES (?)").run(o.id);
        if ("policyNo" in b) db.prepare("UPDATE orders SET policy_no = ? WHERE id = ?").run(String(b.policyNo ?? "").trim().slice(0, 40) || null, o.id);
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
  // Менеджер видит и меняет все рейсы; водитель — только свои, и только пока рейс не закрыт.
  const canSeeTrip = (me: StaffMe, t: TripRow) => can(me.role, "trips.read") || (can(me.role, "trips.driver") && t.driver_id === me.id);
  const canEditTrip = (me: StaffMe, t: TripRow) =>
    can(me.role, "trips.edit") || (can(me.role, "trips.driver") && t.driver_id === me.id && !t.closed_at);

  /** Отчёт сдан или принят: водитель больше не меняет расходы и одометр, менеджер — может. */
  const reportLocked = (me: StaffMe, t: TripRow) => !can(me.role, "trips.edit") && (t.report_status === "submitted" || t.report_status === "accepted");
  const seatsTaken = (tripId: string, exceptOrder = "") =>
    (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE (trip_id = ? OR trip2_id = ?) AND id != ?").get(tripId, tripId, exceptOrder) as { n: number }).n;
  /** Почему машину нельзя поставить в рейс: рейс сформирован или мест нет. */
  function seatError(tripId: string, orderId = "") {
    const t = getTrip(tripId);
    if (t?.formed_at) return `Рейс ${tripId} сформирован: сначала верните его в формирование`;
    if (seatsTaken(tripId, orderId) >= CAPACITY) return `В рейсе ${tripId} нет мест: занято ${CAPACITY} из ${CAPACITY}`;
    return "";
  }

  function tripView(t: TripRow, me: StaffMe): TripView {
    const orders = (db.prepare("SELECT no FROM orders WHERE trip_id = ? OR trip2_id = ? ORDER BY no").all(t.id, t.id) as Array<{ no: number }>).map((x) => x.no);
    const events = db.prepare("SELECT at, city, note FROM trip_events WHERE trip_id = ? ORDER BY at").all(t.id) as TripView["events"];
    const exp = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM trip_expenses WHERE trip_id = ?").get(t.id) as { s: number }).s;
    return {
      id: t.id, dest: t.dest, truck: t.truck, driver: t.driver, driverId: t.driver_id, loadDate: t.load_date, km: t.km,
      odometerStart: t.odometer_start, odometerEnd: t.odometer_end, closedAt: t.closed_at, expensesTotal: exp,
      editable: canEditTrip(me, t),
      status: t.km >= kmTo(t.dest) && t.km > 0 ? "arrived" : t.km > 0 ? "in_transit" : "loading",
      orders, driveUrl: t.drive_file_id ? sheetUrl(t.drive_file_id) : null, driveError: t.drive_error,
      driveSyncedAt: t.drive_synced_at, events,
      trailer: t.trailer, carrier: t.carrier, regDriverId: t.reg_driver_id, formedAt: t.formed_at, seats: CAPACITY - orders.length,
      advance: t.advance, reportStatus: t.report_status, reportComment: t.report_comment, submittedAt: t.submitted_at, acceptedAt: t.accepted_at,
    };
  }
  const getTrip = (id: string) => db.prepare("SELECT * FROM trips WHERE id = ?").get(id) as TripRow | undefined;

  /** Рейс по id из URL с проверкой доступа: на чтение или на изменение. */
  function tripFor(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, edit: boolean) {
    const t = getTrip(req.params.id);
    if (!t || !canSeeTrip(req.staff!, t)) {
      reply.code(404).send({ error: "Рейс не найден" });
      return undefined;
    }
    if (edit && !canEditTrip(req.staff!, t)) {
      reply.code(403).send({ error: t.closed_at ? "Рейс закрыт" : "Нет доступа к этому рейсу" });
      return undefined;
    }
    return t;
  }

  const tripsAccess = needAny("trips.read", "trips.driver");
  const tripsWrite = needAny("trips.edit", "trips.driver");

  app.get("/api/staff/trips", { preHandler: tripsAccess }, async (req) =>
    (db.prepare("SELECT * FROM trips ORDER BY closed_at IS NOT NULL, load_date DESC, id DESC").all() as unknown as TripRow[])
      .filter((t) => canSeeTrip(req.staff!, t)).map((t) => tripView(t, req.staff!)));

  app.get("/api/staff/drivers", { preHandler: need("trips.edit") }, async () =>
    db.prepare("SELECT id, name FROM staff WHERE role = 'driver' AND active = 1 ORDER BY name").all());

  /** Данные рейса из формы; водитель всегда ставит в рейс себя. */
  function tripInput(me: StaffMe, b: TripBody) {
    let driverId: number | null = null;
    let driver = (b.driver ?? "").trim();
    let truck = b.truck?.trim() ?? "", trailer = b.trailer?.trim() ?? "", carrier = b.carrier?.trim() ?? "";
    let regDriverId: number | null = null;
    // Водитель из реестра: тягач, прицеп и перевозчик подставляются из карточки
    const card = can(me.role, "trips.edit") && b.regDriverId
      ? db.prepare("SELECT * FROM drivers WHERE id = ? AND active = 1").get(Number(b.regDriverId)) as DriverRow | undefined
      : !can(me.role, "trips.edit") ? db.prepare("SELECT * FROM drivers WHERE staff_id = ? AND active = 1").get(me.id) as DriverRow | undefined : undefined;
    if (b.regDriverId && can(me.role, "trips.edit") && !card) return { error: "Водитель не найден в реестре" } as const;
    if (card) {
      regDriverId = card.id;
      driver = card.name;
      driverId = card.staff_id;
      truck ||= truckLine({ tractorModel: card.tractor_model, tractorPlate: card.tractor_plate });
      trailer ||= trailerLine({ trailerModel: card.trailer_model, trailerPlate: card.trailer_plate });
      carrier ||= card.own ? "собственный" : card.company_name || "наёмный";
    }
    if (!b.dest || !NET[b.dest] || !truck) return { error: "Укажите город назначения и автовоз" } as const;
    const advance = Math.max(0, Math.round(Number(String(b.advance ?? 0).replace(/[^\d]/g, "")) || 0));
    if (!can(me.role, "trips.edit")) {
      driverId = me.id;
      driver = me.name;
    } else if (b.driverId && !card) {
      const d = db.prepare("SELECT id, name FROM staff WHERE id = ? AND role = 'driver'").get(Number(b.driverId)) as { id: number; name: string } | undefined;
      if (!d) return { error: "Водитель не найден" } as const;
      driverId = d.id;
      driver = d.name;
    }
    const odo = b.odometerStart === undefined || b.odometerStart === null || b.odometerStart === "" ? null : Math.round(Number(b.odometerStart));
    if (odo !== null && !(odo >= 0)) return { error: "Одометр — число километров" } as const;
    return { dest: b.dest, truck, trailer, carrier, regDriverId, driver, driverId, loadDate: b.loadDate || null, odo, advance: can(me.role, "trips.edit") ? advance : 0 } as const;
  }

  // Новый рейс с автономером R-N: его заводит менеджер или сам водитель
  app.post<{ Body: TripBody }>(
    "/api/staff/trips", { preHandler: tripsWrite }, async (req, reply) => {
      const f = tripInput(req.staff!, req.body ?? {});
      if ("error" in f) return reply.code(400).send({ error: f.error });
      let id = "";
      do id = `R-${String(nextTripNo(db)).padStart(2, "0")}`; while (getTrip(id));
      db.prepare(`INSERT INTO trips (id, dest, truck, trailer, carrier, reg_driver_id, driver, driver_id, load_date, odometer_start, advance, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, f.dest, f.truck, f.trailer, f.carrier, f.regDriverId, f.driver, f.driverId, f.loadDate, f.odo, f.advance, req.staff!.id || null);
      audit(req, "trip.create", { id });
      scheduleSync(id);
      return tripView(getTrip(id)!, req.staff!);
    });

  // Рейс с заданным номером (как в старой таблице рейсов) — только менеджер
  app.put<{ Params: { id: string }; Body: TripBody }>(
    "/api/staff/trips/:id", { preHandler: need("trips.edit") }, async (req, reply) => {
      if (!/^[\w-]{1,20}$/.test(req.params.id)) return reply.code(400).send({ error: "Номер рейса: буквы, цифры и дефис" });
      const f = tripInput(req.staff!, req.body ?? {});
      if ("error" in f) return reply.code(400).send({ error: f.error });
      db.prepare(`INSERT INTO trips (id, dest, truck, trailer, carrier, reg_driver_id, driver, driver_id, load_date, odometer_start, advance, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET dest = excluded.dest, truck = excluded.truck, trailer = excluded.trailer, carrier = excluded.carrier,
                  reg_driver_id = excluded.reg_driver_id, driver = excluded.driver, driver_id = excluded.driver_id, load_date = excluded.load_date,
                  odometer_start = COALESCE(excluded.odometer_start, odometer_start), advance = excluded.advance`)
        .run(req.params.id, f.dest, f.truck, f.trailer, f.carrier, f.regDriverId, f.driver, f.driverId, f.loadDate, f.odo, f.advance, req.staff!.id || null);
      audit(req, "trip.save", { id: req.params.id });
      scheduleSync(req.params.id);
      return tripView(getTrip(req.params.id)!, req.staff!);
    });

  // Одометр и закрытие рейса
  app.patch<{ Params: { id: string }; Body: Partial<{ odometerStart: number | null; odometerEnd: number | null; closed: boolean }> }>(
    "/api/staff/trips/:id", { preHandler: tripsAccess }, async (req, reply) => {
      const b = req.body ?? {};
      const reopening = b.closed === false;
      const t = getTrip(req.params.id);
      // Закрытый рейс может открыть только менеджер
      if (t && reopening && !can(req.staff!.role, "trips.edit")) return reply.code(403).send({ error: "Открыть закрытый рейс может менеджер" });
      const trip = tripFor(req, reply, !reopening);
      if (!trip) return;
      if (("odometerStart" in b || "odometerEnd" in b) && reportLocked(req.staff!, trip)) return reply.code(409).send({ error: "Отчёт сдан на проверку: изменения недоступны" });
      const num = (v: unknown) => (v === null || v === "" ? null : Math.round(Number(v)));
      for (const [k, col] of [["odometerStart", "odometer_start"], ["odometerEnd", "odometer_end"]] as const) {
        if (!(k in b)) continue;
        const v = num(b[k]);
        if (v !== null && !(v >= 0)) return reply.code(400).send({ error: "Одометр — число километров" });
        db.prepare(`UPDATE trips SET ${col} = ? WHERE id = ?`).run(v, trip.id);
      }
      const fresh = getTrip(trip.id)!;
      if (fresh.odometer_start !== null && fresh.odometer_end !== null && fresh.odometer_end < fresh.odometer_start)
        return reply.code(400).send({ error: "Одометр в конце меньше, чем в начале" });
      if (b.closed === true) {
        if (fresh.odometer_end === null) return reply.code(400).send({ error: "Перед закрытием укажите одометр в конце рейса" });
        db.prepare("UPDATE trips SET closed_at = ? WHERE id = ?").run(now().toISOString(), trip.id);
      }
      if (reopening) db.prepare("UPDATE trips SET closed_at = NULL WHERE id = ?").run(trip.id);
      audit(req, "trip.update", { id: trip.id, ...b });
      scheduleSync(trip.id);
      return tripView(getTrip(trip.id)!, req.staff!);
    });

  app.post<{ Params: { id: string }; Body: { city: string; note?: string } }>(
    "/api/staff/trips/:id/position", { preHandler: tripsWrite }, async (req, reply) => {
      const trip = tripFor(req, reply, true);
      if (!trip) return;
      const city = req.body?.city;
      if (!routeFor(trip.dest).includes(city)) return reply.code(400).send({ error: "Город не на маршруте рейса" });
      const km = kmTo(city);
      db.prepare("UPDATE trips SET km = ? WHERE id = ?").run(km, trip.id);
      db.prepare("INSERT INTO trip_events (trip_id, at, city, note) VALUES (?, ?, ?, ?)")
        .run(trip.id, now().toISOString(), city, req.body?.note?.trim() || (km ? "В пути" : "Погрузка"));
      // Статусы машин рейса: в пути / прибыл — по километражу до города каждой машины
      const orders = db.prepare("SELECT id, car, status, transfer FROM orders WHERE trip_id = ?").all(trip.id) as Array<{ id: string; car: string; status: OrderStatus; transfer: string | null }>;
      for (const o of orders) {
        if (o.status === "delivered") continue;
        // С перегрузом первый рейс довозит только до терминала: машина ещё в пути
        const dest = o.transfer ? Infinity : kmTo((JSON.parse(o.car) as CarForm).city);
        const status: OrderStatus = km >= dest ? "arrived" : km > 0 ? "in_transit" : "loading";
        db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, o.id);
      }
      // Второе плечо перегруза: машины, которые терминал уже погрузил на этот рейс
      const second = db.prepare(`SELECT o.id, o.car, o.status FROM orders o JOIN acts a ON a.order_id = o.id AND a.stage = 'term_out' AND a.closed_at IS NOT NULL
                                 WHERE o.trip2_id = ? AND o.status != 'delivered'`).all(trip.id) as Array<{ id: string; car: string }>;
      for (const o of second) {
        const dest = kmTo((JSON.parse(o.car) as CarForm).city);
        db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(km >= dest ? "arrived" : "in_transit", o.id);
      }
      audit(req, "trip.position", { id: trip.id, city });
      scheduleSync(trip.id);
      return tripView(getTrip(trip.id)!, req.staff!);
    });

  // --- Погрузка: подписанные машины без рейса, чей город на маршруте ---
  app.get<{ Params: { id: string } }>("/api/staff/trips/:id/waiting", { preHandler: tripsWrite }, async (req, reply) => {
    const trip = tripFor(req, reply, true);
    if (!trip) return;
    const route = new Set(routeFor(trip.dest));
    const rows = db.prepare("SELECT no, car, status, transfer FROM orders WHERE trip_id IS NULL AND status IN ('signed', 'paid') ORDER BY no").all() as Array<{ no: number; car: string; status: string; transfer: string | null }>;
    return rows.map((o) => ({ ...o, c: JSON.parse(o.car) as CarForm })).filter((o) => route.has(o.transfer ?? o.c.city))
      .map((o): WaitingCar => ({ no: o.no, car: `${o.c.car} ${o.c.year}`, vin: o.c.vin.toUpperCase(), city: o.c.city, status: o.status }));
  });

  app.post<{ Params: { id: string }; Body: { no: number; load: boolean } }>("/api/staff/trips/:id/cars", { preHandler: tripsWrite }, async (req, reply) => {
    const trip = tripFor(req, reply, true);
    if (!trip) return;
    const o = db.prepare("SELECT * FROM orders WHERE no = ?").get(Number(req.body?.no)) as OrderRow | undefined;
    if (!o) return reply.code(404).send({ error: "Заявка не найдена" });
    if (req.body.load) {
      if (o.trip_id) return reply.code(409).send({ error: "Машина уже в рейсе " + o.trip_id });
      if (!["signed", "paid"].includes(o.status)) return reply.code(409).send({ error: "Машину можно грузить только по подписанному договору" });
      if (!routeFor(trip.dest).includes(legEnd(o))) return reply.code(400).send({ error: "Город машины не на маршруте" });
      const full = seatError(trip.id, o.id);
      if (full) return reply.code(409).send({ error: full });
      db.prepare("UPDATE orders SET trip_id = ?, status = 'loading' WHERE id = ?").run(trip.id, o.id);
    } else {
      if (o.trip_id !== trip.id) return reply.code(409).send({ error: "Машина не в этом рейсе" });
      if (trip.formed_at) return reply.code(409).send({ error: `Рейс ${trip.id} сформирован: сначала верните его в формирование` });
      db.prepare("UPDATE orders SET trip_id = NULL, status = CASE WHEN status = 'loading' THEN 'signed' ELSE status END WHERE id = ?").run(o.id);
    }
    audit(req, req.body.load ? "trip.load" : "trip.unload", { id: trip.id, no: o.no });
    scheduleSync(trip.id);
    return tripView(getTrip(trip.id)!, req.staff!);
  });

  // --- Расходы рейса ---
  app.post<{ Params: { id: string }; Body: { kind: ExpenseKind; amount: number; liters?: number | null; note?: string } }>(
    "/api/staff/trips/:id/expenses", { preHandler: tripsWrite }, async (req, reply) => {
      const trip = tripFor(req, reply, true);
      if (!trip) return;
      if (reportLocked(req.staff!, trip)) return reply.code(409).send({ error: "Отчёт сдан на проверку: изменения недоступны" });
      const { kind, note } = req.body ?? ({} as never);
      const amount = Math.round(Number(req.body?.amount));
      const liters = req.body?.liters ? Number(req.body.liters) : null;
      if (!(kind in EXPENSE_KINDS)) return reply.code(400).send({ error: "Выберите вид расхода" });
      if (!(amount > 0 && amount < 10_000_000)) return reply.code(400).send({ error: "Сумма в рублях больше нуля" });
      if (liters !== null && !(liters > 0 && liters < 5000)) return reply.code(400).send({ error: "Литры — число больше нуля" });
      db.prepare("INSERT INTO trip_expenses (trip_id, at, kind, amount, liters, note, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(trip.id, now().toISOString(), kind, amount, kind === "fuel" ? liters : null, String(note ?? "").trim().slice(0, 300), req.staff!.id || null);
      audit(req, "trip.expense", { id: trip.id, kind, amount });
      scheduleSync(trip.id);
      return buildReport(getTrip(trip.id)!, req.staff!);
    });

  app.delete<{ Params: { id: string; eid: string } }>("/api/staff/trips/:id/expenses/:eid", { preHandler: tripsWrite }, async (req, reply) => {
    const trip = tripFor(req, reply, true);
    if (!trip) return;
    if (reportLocked(req.staff!, trip)) return reply.code(409).send({ error: "Отчёт сдан на проверку: изменения недоступны" });
    const r = db.prepare("DELETE FROM trip_expenses WHERE id = ? AND trip_id = ?").run(Number(req.params.eid), trip.id);
    if (!r.changes) return reply.code(404).send({ error: "Расход не найден" });
    audit(req, "trip.expense.delete", { id: trip.id, eid: req.params.eid });
    scheduleSync(trip.id);
    return buildReport(getTrip(trip.id)!, req.staff!);
  });

  // --- Распознавание фото: модель предлагает поля, сохраняет человек ---
  const recognizeLog = new Map<number, number[]>();
  const RECOGNIZE_PER_HOUR = 120;
  const jpegOf = (v: unknown) => {
    const b = Buffer.from(String(v ?? "").replace(/^data:image\/jpeg;base64,/, ""), "base64");
    return b.length > 1000 && b[0] === 0xff && b[1] === 0xd8 ? b : null;
  };
  app.post<{ Body: { kind: string; image: string; prev?: string } }>(
    "/api/staff/recognize", { preHandler: needAny("trips.edit", "trips.driver"), bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
      if (!ctx.vision) return reply.code(503).send({ error: "Распознавание не настроено на сервере. Заполните поля по фото." });
      const kind = req.body?.kind;
      if (!(kind === "receipt" || kind === "damage" || isDocKind(kind))) return reply.code(400).send({ error: "Неизвестный вид фото" });
      const img = jpegOf(req.body?.image);
      if (!img) return reply.code(400).send({ error: "Нужна фотография в JPEG" });
      const prev = req.body?.prev ? jpegOf(req.body.prev) ?? undefined : undefined;

      const id = req.staff!.id, t = Date.now();
      const recent = (recognizeLog.get(id) ?? []).filter((x) => x > t - 3600_000);
      if (recent.length >= RECOGNIZE_PER_HOUR) return reply.code(429).send({ error: "Слишком много фото за час. Заполните поля вручную или подождите." });
      recognizeLog.set(id, [...recent, t]);

      try {
        const r = await recognize(ctx.vision, kind, img, { prev, now: now() });
        audit(req, "recognize", { kind, model: r.model, ms: r.ms, errors: r.checks.filter((c) => c.level === "error").length, damages: r.damages?.length });
        return r;
      } catch (e) {
        if (!(e instanceof VisionError)) throw e;
        req.log.warn({ err: e.message }, "recognize");
        return reply.code(502).send({ error: "Распознать не удалось: сервис не ответил. Заполните поля по фото." });
      }
    });

  // --- Рейсовый отчёт ---
  /** finance: суммы перевозки и оплата — для ролей с reports.read; водителю не показываем. */
  function buildReport(t: TripRow, me: StaffMe | null): TripReport {
    const finance = !me || can(me.role, "reports.read");
    const orders = db.prepare("SELECT * FROM orders WHERE trip_id = ? OR trip2_id = ? ORDER BY no").all(t.id, t.id) as unknown as OrderRow[];
    const cars = orders.map((o): TripCar => {
      const r = rowView(o, false);
      const base: TripCar = { no: r.no, car: r.car, vin: r.vin, year: r.year, color: r.color, city: r.city, km: kmTo(r.city), client: r.client, phone: r.phone, status: STATUS_RU[r.status] ?? r.status };
      return finance
        ? { ...base, delivery: r.delivery, insurance: r.insurance, total: r.total, paidDelivery: r.paidDelivery, paidInsurance: r.paidInsurance, payTo: r.payTo, payForm: r.payForm }
        : base;
    });
    const expenses = (db.prepare(`SELECT e.id, e.at, e.kind, e.amount, e.liters, e.note, COALESCE(s.name, '') AS by
                                  FROM trip_expenses e LEFT JOIN staff s ON s.id = e.staff_id WHERE e.trip_id = ? ORDER BY e.at`).all(t.id)) as unknown as TripExpense[];
    const byKind: TripReport["totals"]["byKind"] = {};
    for (const e of expenses) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.amount;
    const sum = (f: (c: TripCar) => number) => cars.reduce((s, c) => s + f(c), 0);
    // Выручка рейса: машина с перегрузом делится между рейсами по километрам плеча
    const revenue = orders.reduce((s, o) => {
      const q = JSON.parse(o.quote) as Quote, city = (JSON.parse(o.car) as CarForm).city;
      const leg = !o.transfer ? null : o.trip_id === t.id ? 1 : 2;
      return s + q.delivery * legShare(leg, kmTo(o.transfer ?? city), kmTo(city));
    }, 0);
    const spent = expenses.reduce((s, e) => s + e.amount, 0);
    const view = me ? tripView(t, me) : tripView(t, { id: 0, name: "", login: "", role: "owner", perms: [], site: null });
    return {
      trip: view, cars, expenses, finance,
      totals: {
        cars: cars.length,
        expenses: spent,
        balance: t.advance - spent,
        byKind,
        fuelLiters: Math.round(expenses.reduce((s, e) => s + (e.liters ?? 0), 0) * 10) / 10,
        mileage: t.odometer_start !== null && t.odometer_end !== null ? t.odometer_end - t.odometer_start : null,
        ...(finance ? {
          delivery: sum((c) => c.delivery ?? 0), insurance: sum((c) => c.insurance ?? 0),
          unpaid: sum((c) => (c.paidDelivery ? 0 : c.delivery ?? 0) + (c.paidInsurance ? 0 : c.insurance ?? 0)),
          revenue: Math.round(revenue),
        } : {}),
      },
    };
  }

  /** Отчёт строками — для CSV и Google Таблицы. */
  function reportRows(r: TripReport) {
    const t = r.trip;
    const fmt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Vladivostok" });
    const last = t.events.at(-1);
    const head = ["№", "Автомобиль", "VIN / кузов", "Год", "Цвет", "Город выдачи", "Км", "Получатель", "Телефон", "Статус"];
    const money = ["Перевозка", "Страховка", "Итого", "Перевозка оплачена", "Страховка оплачена", "Кому", "Форма"];
    return [
      [`Рейсовый отчёт ${t.id}`, `Владивосток → ${t.dest}`],
      ["Автовоз", t.truck], ["Водитель", t.driver || "—"], ["Дата погрузки", t.loadDate ?? "—"],
      ["Текущая точка", last ? `${last.city}, ${fmt(last.at)}` : "Владивосток, погрузка"],
      ["Одометр в начале", t.odometerStart ?? "—"], ["Одометр в конце", t.odometerEnd ?? "—"], ["Пробег, км", r.totals.mileage ?? "—"],
      ["Состояние", t.closedAt ? `закрыт ${fmt(t.closedAt)}` : "открыт"],
      ["Машин", r.totals.cars], ["Аванс водителю, ₽", t.advance], ["Расходы, ₽", r.totals.expenses],
      [r.totals.balance >= 0 ? "Остаток аванса у водителя, ₽" : "Перерасход, вернуть водителю, ₽", Math.abs(r.totals.balance)],
      ["Отчёт водителя", REPORT_RU[t.reportStatus]], ["Топливо, л", r.totals.fuelLiters], ["Обновлено", fmt(now().toISOString())],
      [],
      r.finance ? [...head, ...money] : head,
      ...r.cars.map((c) => {
        const row: Array<string | number> = [c.no, c.car, c.vin, c.year, c.color, c.city, c.km, c.client, c.phone, c.status];
        return r.finance
          ? [...row, c.delivery!, c.insurance!, c.total!, c.paidDelivery ? "да" : "нет", c.paidInsurance ? "да" : "нет", c.payTo ?? "", c.payForm ?? ""]
          : row;
      }),
      ...(r.finance ? [["Итого", "", "", "", "", "", "", "", "", "", r.totals.delivery!, r.totals.insurance!, r.totals.delivery! + r.totals.insurance!,
        `не оплачено: ${rub(r.totals.unpaid!)}`]] : []),
      [],
      ["Расходы рейса"],
      ["Дата", "Вид", "Сумма, ₽", "Литры", "Комментарий", "Внёс"],
      ...r.expenses.map((e) => [fmt(e.at), EXPENSE_KINDS[e.kind], e.amount, e.liters ?? "", e.note, e.by]),
      ["Итого расходов", "", r.totals.expenses],
      [],
      ["История движения"],
      ...t.events.map((e) => [fmt(e.at), e.city, e.note]),
    ];
  }

  app.get<{ Params: { id: string } }>("/api/staff/trips/:id/report", { preHandler: tripsAccess }, async (req, reply) => {
    const t = tripFor(req, reply, false);
    if (!t) return;
    return buildReport(t, req.staff!);
  });

  app.get<{ Params: { id: string } }>("/api/staff/trips/:id/report.csv", { preHandler: tripsAccess }, async (req, reply) => {
    const t = tripFor(req, reply, false);
    if (!t) return;
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="trip-${t.id}.csv"`);
    return "﻿" + toCsv(reportRows(buildReport(t, req.staff!))); // BOM — чтобы Excel открыл кириллицу
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
      const id = await ctx.drive.upsertSheet(`Рейс ${t.id} · ${t.dest} · ${t.load_date ?? ""}`.trim(), toCsv(reportRows(buildReport(t, null))), t.drive_file_id);
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
    return tripView(getTrip(req.params.id)!, req.staff!);
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

  // --- Заявки на партнёрство: клиент присылает реквизиты, менеджер проверяет ---
  app.get("/api/staff/partner-requests", { preHandler: need("partners.edit") }, async () =>
    (db.prepare("SELECT * FROM partner_requests ORDER BY status = 'pending' DESC, created_at DESC").all() as never[]).map(requestView));

  app.patch<{ Params: { id: string }; Body: { status: "approved" | "rejected" } }>(
    "/api/staff/partner-requests/:id", { preHandler: need("partners.edit") }, async (req, reply) => {
      const status = req.body?.status;
      if (status !== "approved" && status !== "rejected") return reply.code(400).send({ error: "Одобрить или отклонить" });
      const r = db.prepare("SELECT * FROM partner_requests WHERE id = ?").get(Number(req.params.id)) as { phone: string; status: string } | undefined;
      if (!r) return reply.code(404).send({ error: "Заявка не найдена" });
      db.prepare("UPDATE partner_requests SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?")
        .run(status, now().toISOString(), req.staff!.id || null, Number(req.params.id));
      audit(req, "partner.request", { id: Number(req.params.id), status });
      if (status === "approved" && r.status !== "approved") {
        try {
          await ctx.sms.send(r.phone, `Brookclean: реквизиты проверены, теперь вы можете оформлять несколько автомобилей в день: ${ctx.publicUrl}`);
        } catch (err) {
          req.log.error(err);
        }
      }
      return requestView(db.prepare("SELECT * FROM partner_requests WHERE id = ?").get(Number(req.params.id)) as never);
    });

  // --- Сотрудники ---
  const staffView = (s: StaffRow) => ({ id: s.id, name: s.name, login: s.login, role: s.role, active: !!s.active, createdAt: s.created_at, site: s.site, pending: !!s.pending, phone: s.phone });

  app.get("/api/staff/users", { preHandler: need("staff.manage") }, async () =>
    (db.prepare("SELECT * FROM staff ORDER BY active DESC, name").all() as unknown as StaffRow[]).map(staffView));

  /** Площадка нужна только приёмщику: Владивосток или терминал Новосибирск. */
  const siteFor = (role: Role, site: unknown) => (role === "acceptor" ? (isSite(site) ? site : "Владивосток") : null);

  app.post<{ Body: { name: string; login: string; password: string; role: Role; site?: string } }>(
    "/api/staff/users", { preHandler: need("staff.manage") }, async (req, reply) => {
      const { name, login, password, role } = req.body ?? ({} as never);
      if (!name?.trim() || !login?.trim()) return reply.code(400).send({ error: "Укажите имя и логин" });
      if (!password || password.length < 8) return reply.code(400).send({ error: "Пароль не короче 8 символов" });
      if (!isRole(role)) return reply.code(400).send({ error: "Выберите роль" });
      try {
        const r = db.prepare("INSERT INTO staff (name, login, pass_hash, role, created_at, site) VALUES (?, ?, ?, ?, ?, ?)")
          .run(name.trim(), login.trim().toLowerCase(), hashPassword(password), role, now().toISOString(), siteFor(role, req.body.site));
        audit(req, "staff.create", { login, role });
        return staffView(db.prepare("SELECT * FROM staff WHERE id = ?").get(r.lastInsertRowid) as unknown as StaffRow);
      } catch {
        return reply.code(409).send({ error: "Такой логин уже есть" });
      }
    });

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; role: Role; active: boolean; password: string; site: string }> }>(
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
      if (b.role || b.site !== undefined) db.prepare("UPDATE staff SET site = ? WHERE id = ?").run(siteFor(b.role ?? s.role, b.site ?? s.site), id);
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

  // --- Защита цен: журнал подозрительных запросов и чёрный список ---
  app.get("/api/staff/security", { preHandler: need("security.manage") }, async () => ctx.guard.report());

  app.post<{ Body: { value: string; note?: string } }>("/api/staff/security/block", { preHandler: need("security.manage") }, async (req, reply) => {
    const raw = String(req.body?.value ?? "").trim();
    const value = /^[\d\s()+-]+$/.test(raw) && normalizePhone(raw) ? normalizePhone(raw) : raw;
    if (!value) return reply.code(400).send({ error: "Укажите телефон или IP" });
    ctx.guard.block(value, String(req.body?.note ?? "").trim().slice(0, 200), req.staff!.id || null);
    audit(req, "security.block", { value });
    return ctx.guard.report();
  });

  app.delete<{ Params: { value: string } }>("/api/staff/security/block/:value", { preHandler: need("security.manage") }, async (req) => {
    ctx.guard.unblock(req.params.value);
    audit(req, "security.unblock", { value: req.params.value });
    return ctx.guard.report();
  });

  registerActs(app, { db, now, store: ctx.store, vision: ctx.vision, need, audit });
  registerFleet(app, { db, now, need, needAny, audit, getTrip, tripView, tripFor, buildReport, scheduleSync, seatsTaken, hashPassword, staffView, siteFor, rowView });
}
