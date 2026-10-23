// Автопарк: реестр водителей, сдача и проверка рейсового отчёта, формирование рейса на 8 мест,
// распределение машин, таблица доставок по рейсу с обраткой и самостоятельная регистрация сотрудников.
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import {
  CAPACITY, DOC_KINDS, HUB, TRANSFER_CITY, can, terminalOf, docsFilled, isDocKind, isSite, kmTo, licExpired, normalizePhone, routeFor,
  type CarForm, type DeliveryRow, type Deliveries, type DistributionItem, type DriverCard, type DriverDocs, type DriverInput,
  type OrderRowView, type Permission, type Role, type StaffMe, type TripReport, type TripView,
} from "@brookclean/shared";
import type { DB } from "./db.ts";
import type { TripRow } from "./staff.ts";

export function migrateFleet(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      own INTEGER NOT NULL DEFAULT 1,      -- свой водитель или наёмный
      grp TEXT NOT NULL DEFAULT '',        -- группа из Excel: «Наёмники», компания
      tractor_model TEXT NOT NULL DEFAULT '',
      tractor_plate TEXT NOT NULL DEFAULT '',
      trailer_model TEXT NOT NULL DEFAULT '',
      trailer_plate TEXT NOT NULL DEFAULT '',
      company_name TEXT NOT NULL DEFAULT '',
      company_inn TEXT NOT NULL DEFAULT '',
      company_phone TEXT NOT NULL DEFAULT '',
      docs TEXT NOT NULL DEFAULT '{}',     -- JSON DriverDocs: поля паспорта, ВУ, СТС (фото не храним)
      staff_id INTEGER,                    -- учётная запись водителя в панели
      import_key TEXT UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backhaul (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id TEXT NOT NULL,
      car TEXT NOT NULL,
      vin TEXT NOT NULL DEFAULT '',
      route TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL DEFAULT '',
      price INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  const add = (t: string, col: string, def: string) => {
    if (!cols(t).includes(col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`);
  };
  add("trips", "trailer", "TEXT NOT NULL DEFAULT ''");
  add("trips", "carrier", "TEXT NOT NULL DEFAULT ''");
  add("trips", "reg_driver_id", "INTEGER");
  add("trips", "formed_at", "TEXT");
  add("trips", "advance", "INTEGER NOT NULL DEFAULT 0");
  add("trips", "report_status", "TEXT NOT NULL DEFAULT 'draft'");
  add("trips", "report_comment", "TEXT NOT NULL DEFAULT ''");
  add("trips", "submitted_at", "TEXT");
  add("trips", "accepted_at", "TEXT");
  add("orders", "policy_no", "TEXT");
  add("orders", "delivered_at", "TEXT");
  add("staff", "pending", "INTEGER NOT NULL DEFAULT 0");
  add("staff", "phone", "TEXT");
  add("drivers", "site", `TEXT NOT NULL DEFAULT '${HUB}'`);
  add("orders", "note", "TEXT NOT NULL DEFAULT ''");
}

export interface DriverRow {
  id: number; name: string; phone: string; own: number; grp: string;
  tractor_model: string; tractor_plate: string; trailer_model: string; trailer_plate: string;
  company_name: string; company_inn: string; company_phone: string; docs: string;
  staff_id: number | null; import_key: string | null; active: number; created_at: string; site: string;
}

type StaffView = { id: number; name: string; login: string; role: Role; active: boolean; createdAt: string; site: string | null; pending: boolean; phone: string | null };

export interface FleetContext {
  db: DB;
  now: () => Date;
  need: (...perms: Permission[]) => preHandlerHookHandler;
  needAny: (...perms: Permission[]) => preHandlerHookHandler;
  audit: (req: FastifyRequest, action: string, details: unknown) => void;
  getTrip: (id: string) => TripRow | undefined;
  tripView: (t: TripRow, me: StaffMe) => TripView;
  tripFor: (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, edit: boolean) => TripRow | undefined;
  buildReport: (t: TripRow, me: StaffMe | null) => TripReport;
  scheduleSync: (tripId: string) => void;
  seatsTaken: (tripId: string, exceptOrder?: string) => number;
  hashPassword: (p: string) => string;
  staffView: (s: never) => StaffView;
  siteFor: (role: Role, site: unknown) => string | null;
  rowView: (o: never, personal: boolean) => OrderRowView;
}

const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
/** Поля документов: только известные виды и поля, строки до 200 символов. */
function cleanDocs(v: unknown): DriverDocs {
  const out: DriverDocs = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, fields] of Object.entries(v as Record<string, unknown>)) {
    if (!isDocKind(k) || !fields || typeof fields !== "object") continue;
    const known = new Set<string>(DOC_KINDS[k].fields.map(([f]) => f));
    const f = Object.fromEntries(Object.entries(fields as Record<string, unknown>).filter(([n]) => known.has(n)).map(([n, x]) => [n, str(x)]));
    if (Object.keys(f).length) out[k] = f;
  }
  return out;
}
const COLS = {
  name: "name", phone: "phone", group: "grp", tractorModel: "tractor_model", tractorPlate: "tractor_plate", trailerModel: "trailer_model",
  trailerPlate: "trailer_plate", companyName: "company_name", companyInn: "company_inn", companyPhone: "company_phone",
} as const satisfies Partial<Record<keyof DriverInput, string>>;

export function registerFleet(app: FastifyInstance, ctx: FleetContext) {
  const { db, now, need, needAny, audit } = ctx;
  const tripsWrite = needAny("trips.edit", "trips.driver");

  // --- Реестр водителей ---
  function cardView(d: DriverRow): DriverCard {
    const docs = JSON.parse(d.docs) as DriverDocs;
    const staff = d.staff_id ? db.prepare("SELECT active, pending FROM staff WHERE id = ?").get(d.staff_id) as { active: number; pending: number } | undefined : undefined;
    const trip = db.prepare("SELECT id FROM trips WHERE reg_driver_id = ? AND closed_at IS NULL ORDER BY load_date DESC LIMIT 1").get(d.id) as { id: string } | undefined;
    return {
      id: d.id, site: d.site, name: d.name, phone: d.phone, own: !!d.own, group: d.grp, tractorModel: d.tractor_model, tractorPlate: d.tractor_plate,
      trailerModel: d.trailer_model, trailerPlate: d.trailer_plate, companyName: d.company_name, companyInn: d.company_inn, companyPhone: d.company_phone,
      docs, staffId: d.staff_id, pending: !!staff?.pending, active: !!d.active, fromExcel: !!d.import_key, createdAt: d.created_at,
      tripId: trip?.id ?? null, docsFilled: docsFilled(docs), licExpired: licExpired(docs, now()),
    };
  }
  const getCard = (id: number) => db.prepare("SELECT * FROM drivers WHERE id = ?").get(id) as DriverRow | undefined;

  function insertCard(b: Partial<DriverInput>, importKey: string | null = null, staffId: number | null = null, site: string = HUB) {
    const r = db.prepare(`INSERT INTO drivers (name, phone, own, grp, tractor_model, tractor_plate, trailer_model, trailer_plate,
                          company_name, company_inn, company_phone, docs, staff_id, import_key, created_at, site)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(str(b.name), str(b.phone, 30), b.own === false ? 0 : 1, str(b.group), str(b.tractorModel), str(b.tractorPlate, 20), str(b.trailerModel),
        str(b.trailerPlate, 20), str(b.companyName), str(b.companyInn, 12), str(b.companyPhone, 30), JSON.stringify(cleanDocs(b.docs)), staffId, importKey,
        now().toISOString(), site);
    return Number(r.lastInsertRowid);
  }
  function updateCard(id: number, b: Partial<DriverInput> & { active?: boolean }, self: boolean) {
    for (const [k, col] of Object.entries(COLS)) {
      if (k in b) db.prepare(`UPDATE drivers SET ${col} = ? WHERE id = ?`).run(str(b[k as keyof typeof COLS], k.endsWith("Plate") ? 20 : 200), id);
    }
    if (b.docs) {
      // Документы сливаются по видам: пустой вид удаляет запись
      const cur = JSON.parse(getCard(id)!.docs) as DriverDocs;
      const next = { ...cur, ...cleanDocs(b.docs) };
      for (const k of Object.keys(b.docs)) if (isDocKind(k) && !Object.values(next[k] ?? {}).some(Boolean)) delete next[k];
      db.prepare("UPDATE drivers SET docs = ? WHERE id = ?").run(JSON.stringify(next), id);
    }
    if (!self && b.own !== undefined) db.prepare("UPDATE drivers SET own = ? WHERE id = ?").run(Number(!!b.own), id);
    if (!self && b.active !== undefined) db.prepare("UPDATE drivers SET active = ? WHERE id = ?").run(Number(!!b.active), id);
  }

  // Менеджер видит всех водителей; приёмщик терминала — только свой список, водители Владивостока ему не видны
  const registryAccess = needAny("drivers.edit", "drivers.site");
  /** undefined — все площадки, строка — только эта, null — нет доступа (приёмщик Владивостока). */
  function scopeOf(me: StaffMe): string | null | undefined {
    if (can(me.role, "drivers.edit") || can(me.role, "trips.edit")) return undefined;
    return can(me.role, "drivers.site") ? terminalOf(me) : null;
  }
  function scoped(req: FastifyRequest, reply: FastifyReply): string | undefined | false {
    const s = scopeOf(req.staff!);
    if (s === null) {
      reply.code(403).send({ error: "Свой список водителей есть только у терминала перегруза" });
      return false;
    }
    return s;
  }
  const inScope = (d: DriverRow, scope: string | undefined) => scope === undefined || d.site === scope;

  app.get("/api/staff/registry", { preHandler: needAny("drivers.edit", "trips.edit", "drivers.site") }, async (req, reply) => {
    const scope = scoped(req, reply);
    if (scope === false) return;
    return (db.prepare("SELECT * FROM drivers ORDER BY active DESC, own DESC, name").all() as unknown as DriverRow[])
      .filter((d) => inScope(d, scope)).map(cardView);
  });

  app.post<{ Body: Partial<DriverInput> & { site?: string } }>("/api/staff/registry", { preHandler: registryAccess }, async (req, reply) => {
    const scope = scoped(req, reply);
    if (scope === false) return;
    if (str(req.body?.name).length < 3) return reply.code(400).send({ error: "Укажите ФИО водителя" });
    const id = insertCard(req.body ?? {}, null, null, scope ?? (isSite(req.body?.site) ? req.body.site : HUB));
    audit(req, "driver.create", { id });
    return cardView(getCard(id)!);
  });

  app.patch<{ Params: { id: string }; Body: Partial<DriverInput> & { active?: boolean; site?: string } }>(
    "/api/staff/registry/:id", { preHandler: registryAccess }, async (req, reply) => {
      const scope = scoped(req, reply);
      if (scope === false) return;
      const d = getCard(Number(req.params.id));
      if (!d || !inScope(d, scope)) return reply.code(404).send({ error: "Водитель не найден" });
      if (scope === undefined && isSite(req.body?.site)) db.prepare("UPDATE drivers SET site = ? WHERE id = ?").run(req.body.site, d.id);
      if (req.body?.name !== undefined && str(req.body.name).length < 3) return reply.code(400).send({ error: "Укажите ФИО водителя" });
      updateCard(d.id, req.body ?? {}, false);
      audit(req, "driver.update", { id: d.id, fields: Object.keys(req.body ?? {}) });
      return cardView(getCard(d.id)!);
    });

  // Импорт из Excel: файл читает браузер, сюда приходят готовые карточки. Повторный импорт того же файла ничего не дублирует.
  app.post<{ Body: { drivers: Array<Partial<DriverInput> & { importKey?: string }> } }>(
    "/api/staff/registry/import", { preHandler: registryAccess, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
      const scope = scoped(req, reply);
      if (scope === false) return;
      const list = req.body?.drivers;
      if (!Array.isArray(list) || !list.length || list.length > 2000) return reply.code(400).send({ error: "В файле нет водителей" });
      let added = 0, skipped = 0;
      for (const d of list) {
        const key = str(d.importKey, 300) || null;
        if (str(d.name).length < 3 || (key && db.prepare("SELECT 1 FROM drivers WHERE import_key = ?").get(key))) {
          skipped++;
          continue;
        }
        insertCard(d, key, null, scope ?? HUB);
        added++;
      }
      audit(req, "driver.import", { added, skipped });
      return { added, skipped };
    });

  // Водитель видит и дополняет свою карточку: телефон, транспорт, документы
  const ownCard = (me: StaffMe) => db.prepare("SELECT * FROM drivers WHERE staff_id = ?").get(me.id) as DriverRow | undefined;
  app.get("/api/staff/registry/me", { preHandler: need("trips.driver") }, async (req) => {
    const d = ownCard(req.staff!);
    return d ? cardView(d) : null;
  });
  app.patch<{ Body: Partial<DriverInput> }>("/api/staff/registry/me", { preHandler: need("trips.driver") }, async (req) => {
    let d = ownCard(req.staff!);
    if (!d) d = getCard(insertCard({ name: req.staff!.name }, null, req.staff!.id))!;
    const { name: _n, own: _o, group: _g, ...rest } = req.body ?? {};
    updateCard(d.id, rest, true);
    audit(req, "driver.self", { id: d.id, fields: Object.keys(rest) });
    return cardView(getCard(d.id)!);
  });

  // --- Рейс: аванс, прицеп, перевозчик; формирование ---
  app.post<{ Params: { id: string }; Body: Partial<{ advance: number; truck: string; trailer: string; carrier: string }> }>(
    "/api/staff/trips/:id/meta", { preHandler: need("trips.edit") }, async (req, reply) => {
      const t = ctx.tripFor(req, reply, true);
      if (!t) return;
      const b = req.body ?? {};
      if (b.advance !== undefined) {
        const a = Math.round(Number(b.advance));
        if (!(a >= 0 && a < 10_000_000)) return reply.code(400).send({ error: "Аванс — сумма в рублях" });
        db.prepare("UPDATE trips SET advance = ? WHERE id = ?").run(a, t.id);
      }
      if (b.truck !== undefined) {
        if (!str(b.truck)) return reply.code(400).send({ error: "Укажите тягач" });
        db.prepare("UPDATE trips SET truck = ? WHERE id = ?").run(str(b.truck), t.id);
      }
      if (b.trailer !== undefined) db.prepare("UPDATE trips SET trailer = ? WHERE id = ?").run(str(b.trailer), t.id);
      if (b.carrier !== undefined) db.prepare("UPDATE trips SET carrier = ? WHERE id = ?").run(str(b.carrier), t.id);
      audit(req, "trip.meta", { id: t.id, ...b });
      ctx.scheduleSync(t.id);
      return ctx.tripView(ctx.getTrip(t.id)!, req.staff!);
    });

  app.post<{ Params: { id: string }; Body: { formed: boolean } }>("/api/staff/trips/:id/form", { preHandler: need("trips.edit") }, async (req, reply) => {
    const t = ctx.tripFor(req, reply, true);
    if (!t) return;
    if (req.body?.formed) {
      if (!t.driver && !t.reg_driver_id) return reply.code(400).send({ error: "Чтобы сформировать рейс, назначьте водителя" });
      if (!ctx.seatsTaken(t.id)) return reply.code(400).send({ error: "Чтобы сформировать рейс, поставьте в него хотя бы одну машину" });
      db.prepare("UPDATE trips SET formed_at = COALESCE(formed_at, ?) WHERE id = ?").run(now().toISOString(), t.id);
    } else {
      if (t.km > 0) return reply.code(409).send({ error: "Рейс уже в пути: состав не меняется" });
      db.prepare("UPDATE trips SET formed_at = NULL WHERE id = ?").run(t.id);
    }
    audit(req, req.body?.formed ? "trip.form" : "trip.unform", { id: t.id });
    return ctx.tripView(ctx.getTrip(t.id)!, req.staff!);
  });

  // --- Рейсовый отчёт: водитель сдаёт, менеджер принимает или возвращает с комментарием ---
  app.post<{ Params: { id: string } }>("/api/staff/trips/:id/report/submit", { preHandler: tripsWrite }, async (req, reply) => {
    const t = ctx.tripFor(req, reply, true);
    if (!t) return;
    if (t.report_status === "submitted" || t.report_status === "accepted") return reply.code(409).send({ error: "Отчёт уже сдан" });
    const n = (db.prepare("SELECT COUNT(*) AS n FROM trip_expenses WHERE trip_id = ?").get(t.id) as { n: number }).n;
    if (!n) return reply.code(400).send({ error: "Добавьте хотя бы один чек" });
    db.prepare("UPDATE trips SET report_status = 'submitted', submitted_at = ? WHERE id = ?").run(now().toISOString(), t.id);
    audit(req, "report.submit", { id: t.id });
    ctx.scheduleSync(t.id);
    return ctx.buildReport(ctx.getTrip(t.id)!, req.staff!);
  });

  app.post<{ Params: { id: string }; Body: { accept: boolean; comment?: string } }>(
    "/api/staff/trips/:id/report/decision", { preHandler: need("reports.read") }, async (req, reply) => {
      const t = ctx.tripFor(req, reply, false);
      if (!t) return;
      if (t.report_status !== "submitted") return reply.code(409).send({ error: "Отчёт ещё не сдан водителем" });
      const comment = str(req.body?.comment, 500);
      if (!req.body?.accept && !comment) return reply.code(400).send({ error: "Напишите водителю, что исправить" });
      if (req.body?.accept) db.prepare("UPDATE trips SET report_status = 'accepted', accepted_at = ?, report_comment = ? WHERE id = ?").run(now().toISOString(), comment, t.id);
      else db.prepare("UPDATE trips SET report_status = 'returned', report_comment = ? WHERE id = ?").run(comment, t.id);
      audit(req, req.body?.accept ? "report.accept" : "report.return", { id: t.id, comment });
      ctx.scheduleSync(t.id);
      return ctx.buildReport(ctx.getTrip(t.id)!, req.staff!);
    });

  // --- Распределение: машины без рейса и машины на терминале, которым нужен рейс дальше ---
  app.get("/api/staff/distribution", { preHandler: need("trips.edit") }, async () => {
    const open = db.prepare("SELECT * FROM trips WHERE closed_at IS NULL AND formed_at IS NULL ORDER BY load_date IS NULL, load_date, id").all() as unknown as TripRow[];
    const fits = (t: TripRow, from: string | null, to: string) => {
      const route = routeFor(t.dest);
      if (!route.includes(to) || (from && !route.includes(from))) return false;
      // На первое плечо — только рейсы, которые ещё не выехали; от терминала — ещё не прошедшие его
      return from ? t.km < kmTo(from) : t.km === 0;
    };
    const pick = (from: string | null, to: string) => open.filter((t) => fits(t, from, to))
      .map((t) => ({ id: t.id, dest: t.dest, loadDate: t.load_date, seats: CAPACITY - ctx.seatsTaken(t.id) })).filter((t) => t.seats > 0);
    const rows = db.prepare(`SELECT no, car, status, transfer, trip_id, trip2_id, id FROM orders
                             WHERE status NOT IN ('draft', 'delivered') AND (trip_id IS NULL OR (transfer IS NOT NULL AND trip2_id IS NULL)) ORDER BY no`).all() as Array<
      { no: number; car: string; status: string; transfer: string | null; trip_id: string | null; trip2_id: string | null; id: string }>;
    return rows.map((o): DistributionItem => {
      const c = JSON.parse(o.car) as CarForm;
      const leg = o.trip_id ? 2 : 1;
      const atTerminal = leg === 2 && !!db.prepare("SELECT 1 FROM acts WHERE order_id = ? AND stage = 'term_in' AND closed_at IS NOT NULL").get(o.id);
      return {
        no: o.no, car: `${c.car} ${c.year}`, city: c.city, transfer: o.transfer, leg, atTerminal,
        trips: leg === 1 ? pick(null, o.transfer ?? c.city) : pick(o.transfer, c.city),
      };
    });
  });

  // --- Таблица доставок по рейсу ---
  app.get<{ Params: { id: string } }>("/api/staff/trips/:id/deliveries", { preHandler: need("reports.read") }, async (req, reply) => {
    const t = ctx.tripFor(req, reply, false);
    if (!t) return;
    const personal = can(req.staff!.role, "orders.personal");
    const events = db.prepare("SELECT at, city FROM trip_events WHERE trip_id = ? ORDER BY at").all(t.id) as Array<{ at: string; city: string }>;
    /** Первая отметка рейса не раньше km (или дальше, если strict). */
    const passed = (tripId: string, km: number, strict = false) => {
      const ev = tripId === t.id ? events : db.prepare("SELECT at, city FROM trip_events WHERE trip_id = ? ORDER BY at").all(tripId) as typeof events;
      return ev.find((e) => (strict ? kmTo(e.city) > km : kmTo(e.city) >= km))?.at ?? null;
    };
    const kmT = kmTo(TRANSFER_CITY);
    const orders = db.prepare("SELECT * FROM orders WHERE trip_id = ? OR trip2_id = ? ORDER BY no").all(t.id, t.id) as unknown as Array<
      { id: string; trip_id: string | null; trip2_id: string | null; transfer: string | null; delivered_at: string | null; policy_no: string | null; car: string }>;
    const rows = orders.map((o): DeliveryRow => {
      const r = ctx.rowView(o as never, personal);
      const city = (JSON.parse(o.car) as CarForm).city, kmC = kmTo(city);
      const first = o.trip_id === t.id;
      const termOut = o.transfer ? db.prepare("SELECT closed_at FROM acts WHERE order_id = ? AND stage = 'term_out'").get(o.id) as { closed_at: string | null } | undefined : undefined;
      const lastTrip = o.transfer ? o.trip2_id : o.trip_id;
      return {
        no: r.no, createdAt: r.createdAt, status: r.status, car: r.car, vin: r.vin, year: r.year, city,
        legNote: o.transfer ? (first ? `перегрузка в ${o.transfer}` : `с терминала ${o.transfer}`) : "",
        client: r.client, phone: r.phone, partner: r.partner,
        arrivedTransfer: kmC >= kmT && o.trip_id ? passed(o.trip_id, kmT) : null,
        leftTransfer: o.transfer ? termOut?.closed_at ?? null : kmC > kmT && o.trip_id ? passed(o.trip_id, kmT, true) : null,
        arrivedCity: lastTrip ? passed(lastTrip, kmC) : null,
        deliveredAt: o.delivered_at,
        delivery: r.delivery, cashback: r.cashback, value: r.value, insurance: r.insurance, policyNo: r.policyNo,
        paidDelivery: r.paidDelivery, paidInsurance: r.paidInsurance, payTo: r.payTo, payForm: r.payForm,
      };
    });
    const card = t.reg_driver_id ? db.prepare("SELECT phone FROM drivers WHERE id = ?").get(t.reg_driver_id) as { phone: string } | undefined : undefined;
    const result: Deliveries = {
      trip: { id: t.id, dest: t.dest, loadDate: t.load_date, truck: t.truck, trailer: t.trailer, carrier: t.carrier, driver: t.driver, driverPhone: card?.phone ?? "", formedAt: t.formed_at },
      rows, throughTransfer: rows.some((r) => kmTo(r.city) >= kmT),
      backhaul: db.prepare("SELECT id, car, vin, route, client, price FROM backhaul WHERE trip_id = ? ORDER BY id").all(t.id) as never,
    };
    return result;
  });

  // Обратка: машины, которые тот же автовоз везёт обратно
  app.post<{ Params: { id: string }; Body: { car: string; vin?: string; route?: string; client?: string; price?: number | null } }>(
    "/api/staff/trips/:id/backhaul", { preHandler: need("trips.edit") }, async (req, reply) => {
      const t = ctx.tripFor(req, reply, false);
      if (!t) return;
      const b = req.body ?? ({} as never);
      if (!str(b.car)) return reply.code(400).send({ error: "Укажите автомобиль" });
      const price = b.price === null || b.price === undefined || String(b.price) === "" ? null : Math.round(Number(b.price));
      if (price !== null && !(price >= 0)) return reply.code(400).send({ error: "Стоимость — сумма в рублях" });
      db.prepare("INSERT INTO backhaul (trip_id, car, vin, route, client, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(t.id, str(b.car), str(b.vin, 40).toUpperCase(), str(b.route), str(b.client), price, now().toISOString());
      audit(req, "backhaul.add", { id: t.id, car: b.car });
      return db.prepare("SELECT id, car, vin, route, client, price FROM backhaul WHERE trip_id = ? ORDER BY id").all(t.id);
    });

  app.delete<{ Params: { id: string; bid: string } }>("/api/staff/trips/:id/backhaul/:bid", { preHandler: need("trips.edit") }, async (req, reply) => {
    const t = ctx.tripFor(req, reply, false);
    if (!t) return;
    const r = db.prepare("DELETE FROM backhaul WHERE id = ? AND trip_id = ?").run(Number(req.params.bid), t.id);
    if (!r.changes) return reply.code(404).send({ error: "Запись не найдена" });
    audit(req, "backhaul.delete", { id: t.id, bid: req.params.bid });
    return db.prepare("SELECT id, car, vin, route, client, price FROM backhaul WHERE trip_id = ? ORDER BY id").all(t.id);
  });

  // --- Регистрация: водитель или приёмщик заводит себе вход сам, менеджер подтверждает ---
  const regLog = new Map<string, number[]>();
  app.post<{ Body: { name: string; phone: string; password: string; role: Role; site?: string } }>("/api/staff/register", async (req, reply) => {
    const t = Date.now();
    const recent = (regLog.get(req.ip) ?? []).filter((x) => x > t - 3600_000);
    if (recent.length >= 5) return reply.code(429).send({ error: "Слишком много заявок. Попробуйте через час." });
    const b = req.body ?? ({} as never);
    const name = str(b.name, 120), phone = normalizePhone(String(b.phone ?? ""));
    const errors: Record<string, string> = {};
    if (name.split(/\s+/).length < 2) errors.name = "Фамилия, имя и отчество";
    if (!phone) errors.phone = "Номер в формате +7 900 000 00 00";
    if (!b.password || String(b.password).length < 8) errors.password = "Пароль не короче 8 символов";
    if (b.role !== "driver" && b.role !== "acceptor") errors.role = "Выберите: водитель или приёмщик";
    if (b.role === "acceptor" && !isSite(b.site)) errors.site = "Выберите площадку";
    if (Object.keys(errors).length) return reply.code(400).send({ error: "Проверьте поля", errors });
    regLog.set(req.ip, [...recent, t]);
    if (db.prepare("SELECT 1 FROM staff WHERE login = ?").get(phone)) return reply.code(409).send({ error: "Этот номер уже зарегистрирован. Войдите или попросите менеджера сбросить пароль." });
    const r = db.prepare("INSERT INTO staff (name, login, pass_hash, role, active, pending, phone, created_at, site) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)")
      .run(name, phone, ctx.hashPassword(String(b.password)), b.role, phone, now().toISOString(), ctx.siteFor(b.role, b.site));
    const staffId = Number(r.lastInsertRowid);
    if (b.role === "driver") {
      // Водитель уже есть в реестре (например, из Excel) — привязываем карточку по телефону
      const card = db.prepare("SELECT id FROM drivers WHERE phone = ? AND staff_id IS NULL").get(phone) as { id: number } | undefined;
      if (card) db.prepare("UPDATE drivers SET staff_id = ? WHERE id = ?").run(staffId, card.id);
      else insertCard({ name, phone }, null, staffId);
    }
    db.prepare("INSERT INTO audit (at, staff_id, action, details) VALUES (?, ?, 'staff.register', ?)").run(now().toISOString(), staffId, JSON.stringify({ role: b.role }));
    return { ok: true };
  });

  app.get("/api/staff/registrations", { preHandler: need("staff.approve") }, async () =>
    (db.prepare("SELECT * FROM staff WHERE pending = 1 ORDER BY created_at").all() as never[]).map(ctx.staffView));

  app.post<{ Params: { id: string }; Body: { approve: boolean } }>("/api/staff/registrations/:id", { preHandler: need("staff.approve") }, async (req, reply) => {
    const id = Number(req.params.id);
    const s = db.prepare("SELECT * FROM staff WHERE id = ? AND pending = 1").get(id) as { role: Role } | undefined;
    if (!s) return reply.code(404).send({ error: "Заявка не найдена" });
    if (req.body?.approve) db.prepare("UPDATE staff SET pending = 0, active = 1 WHERE id = ?").run(id);
    else {
      // Отклонённая заявка освобождает номер; карточка в реестре остаётся без входа
      db.prepare("UPDATE drivers SET staff_id = NULL WHERE staff_id = ?").run(id);
      db.prepare("DELETE FROM staff WHERE id = ?").run(id);
    }
    audit(req, req.body?.approve ? "staff.approve" : "staff.reject", { id });
    return (db.prepare("SELECT * FROM staff WHERE pending = 1 ORDER BY created_at").all() as never[]).map(ctx.staffView);
  });
}
