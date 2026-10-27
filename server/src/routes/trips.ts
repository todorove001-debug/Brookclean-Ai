// рейсы: менеджер ведёт все, приёмщик терминала формирует рейсы со своей площадки, водитель отмечает позицию
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { many, one, tx } from "../db/pool.js";
import { bad, conflict, forbidden, notFound } from "../errors.js";
import { ORIGIN_CITY, routeFor, NET } from "../domain/route.js";
import { requireUser, type AuthUser } from "../services/auth.js";
import { audit } from "../services/audit.js";
import { clientOf, doneStages } from "../services/context.js";
import { CAPACITY } from "./orders.js";

const myBase = (u: AuthUser) => (u.role === "terminal" && u.terminalCity !== ORIGIN_CITY ? u.terminalCity! : "common");
const canManage = (u: AuthUser, t: any) => u.role === "manager" || (u.role === "terminal" && u.terminalCity !== ORIGIN_CITY && t.origin === u.terminalCity);

const tripOut = (t: any) => ({
  id: t.id, code: t.code, origin: t.origin, loadCity: t.load_city, dest: t.dest, status: t.status, driverId: t.driver_id, driverName: t.driver_name ?? null,
  truck: t.truck, trailer: t.trailer, carrier: t.carrier, loadDate: t.load_date, currentCity: t.current_city, advance: t.advance, cars: t.cars ?? undefined,
});
const TripIn = z.object({
  origin: z.string().refine((c) => !!NET[c], "Неизвестный город").optional(),
  dest: z.string().refine((c) => !!NET[c], "Неизвестный город"),
  loadDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  truck: z.string().max(120).nullable().optional(),
  trailer: z.string().max(120).nullable().optional(),
  carrier: z.string().max(160).nullable().optional(),
  advance: z.number().int().min(0).optional(),
});

export default async function (app: FastifyInstance) {
  const { pool } = app.deps;

  const load = async (id: string) => {
    const t = await one(pool, "select t.*, d.name driver_name from trips t left join drivers d on d.id = t.driver_id where t.id = $1", [id]);
    if (!t) throw notFound("Рейс не найден");
    return t;
  };
  // водителя берут из своей базы: менеджер — общая, терминал Новосибирск — своя
  const checkDriver = async (u: AuthUser, driverId: string | null | undefined) => {
    if (!driverId) return;
    const d = await one(pool, "select base from drivers where id = $1", [driverId]);
    if (!d) throw notFound("Водитель не найден");
    if (u.role !== "manager" && d.base !== myBase(u)) throw forbidden("Водитель не из вашей базы");
  };

  app.get("/trips", async (req) => {
    const u = await requireUser(pool, req, "manager", "terminal", "driver");
    const where = u.role === "manager" ? "" : u.role === "driver" ? "where d.user_id = $1" : "where t.origin = $1 or t.dest = $1";
    const rows = await many(pool, `select t.*, d.name driver_name, (select count(*)::int from order_legs l where l.trip_id = t.id) cars
      from trips t left join drivers d on d.id = t.driver_id ${where} order by t.created_at desc`, u.role === "manager" ? [] : [u.role === "driver" ? u.id : u.terminalCity]);
    return { trips: rows.map(tripOut) };
  });

  app.get("/trips/:id", async (req) => {
    const u = await requireUser(pool, req, "manager", "terminal", "driver");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await load(id);
    const drv = t.driver_id ? await one(pool, "select user_id from drivers where id = $1", [t.driver_id]) : null;
    if (!(u.role === "manager" || (u.role === "terminal" && (t.origin === u.terminalCity || t.dest === u.terminalCity)) || drv?.user_id === u.id)) throw forbidden();
    const rows = await many(pool, `select o.*, l.idx leg, (select count(*)::int from order_legs x where x.order_no = o.no) legs
      from order_legs l join orders o on o.no = l.order_no where l.trip_id = $1 order by o.no`, [id]);
    // паспорт и телефон клиента — водителю, который принимает машину у клиента или выдаёт её получателю, и менеджеру
    const meets = (r: any) => r.leg === r.legs - 1 || (r.leg === 0 && t.load_city !== ORIGIN_CITY);
    const cars = rows.map((r) => ({
      no: r.no, car: r.car, vin: r.vin, color: r.color, city: r.city, leg: r.leg, client_fio: r.client_fio,
      client: u.role === "manager" || (drv?.user_id === u.id && meets(r)) ? clientOf(r) : null,
    }));
    const events = await many(pool, "select at, city, note from trip_events where trip_id = $1 order by at", [id]);
    return { trip: tripOut(t), cars, events };
  });

  app.post("/trips", async (req, reply) => {
    const u = await requireUser(pool, req, "manager", "terminal");
    const b = TripIn.parse(req.body);
    if (u.role === "terminal" && u.terminalCity === ORIGIN_CITY) throw forbidden("Рейсы из Владивостока формирует менеджер");
    const origin = u.role === "terminal" ? u.terminalCity! : b.origin ?? ORIGIN_CITY;
    if (!routeFor(b.dest).includes(origin) || origin === b.dest) throw bad(`Маршрут ${origin} → ${b.dest} не по схеме`);
    await checkDriver(u, b.driverId);
    const t = await one(pool, `insert into trips(code, origin, load_city, dest, load_date, driver_id, truck, trailer, carrier, advance)
      values ('R-' || lpad(nextval('trip_no_seq')::text, 2, '0'), $1, $1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [origin, b.dest, b.loadDate ?? null, b.driverId ?? null, b.truck ?? null, b.trailer ?? null, b.carrier ?? null, b.advance ?? 0]);
    await audit(pool, u.id, "trip_create", "trip", t.id, b);
    return reply.status(201).send({ trip: tripOut(t) });
  });

  app.patch("/trips/:id", async (req) => {
    const u = await requireUser(pool, req, "manager", "terminal");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = TripIn.omit({ origin: true, dest: true }).extend({ loadCity: z.string().optional() }).parse(req.body);
    const t = await load(id);
    if (!canManage(u, t)) throw forbidden();
    await checkDriver(u, b.driverId);
    if (b.loadCity && (!routeFor(t.dest).includes(b.loadCity) || b.loadCity === t.dest || !routeFor(b.loadCity).includes(t.origin))) throw bad("Город погрузки не на маршруте рейса");
    const map: Record<string, string> = { loadDate: "load_date", driverId: "driver_id", truck: "truck", trailer: "trailer", carrier: "carrier", advance: "advance", loadCity: "load_city" };
    const keys = Object.keys(b).filter((k) => map[k]);
    if (!keys.length) throw bad("Нечего менять");
    await pool.query(`update trips set ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(", ")} where id = $1`, [id, ...keys.map((k) => (b as any)[k])]);
    await audit(pool, u.id, "trip_update", "trip", id, b);
    return { trip: tripOut(await load(id)) };
  });

  // рейс сформирован: машины можно отгружать
  app.post("/trips/:id/status", async (req) => {
    const u = await requireUser(pool, req, "manager", "terminal");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.enum(["forming", "formed"]) }).parse(req.body);
    const t = await load(id);
    if (!canManage(u, t)) throw forbidden();
    const n = (await one(pool, "select count(*)::int n from order_legs where trip_id = $1", [id]))!.n;
    if (status === "formed" && !t.driver_id) throw bad("Укажите водителя рейса");
    if (status === "formed" && !n) throw bad("В рейсе нет машин");
    if (status === "forming") {
      const loaded = await one(pool, `select 1 from order_legs l join stages s on s.order_no = l.order_no and s.done_at is not null
        and ((l.idx = 0 and s.stage = 'pogruzka') or (l.idx = 1 and s.stage = 'term_out')) where l.trip_id = $1 limit 1`, [id]);
      if (loaded) throw conflict("В рейс уже погружены машины");
    }
    await pool.query("update trips set status = $2 where id = $1", [id, status]);
    await audit(pool, u.id, "trip_status", "trip", id, { status });
    return { trip: tripOut(await load(id)) };
  });

  // отметка позиции: клиенты видят её в трекинге
  app.post("/trips/:id/position", async (req) => {
    const u = await requireUser(pool, req, "manager", "driver");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { city } = z.object({ city: z.string() }).parse(req.body);
    const t = await load(id);
    if (u.role === "driver") {
      const d = t.driver_id ? await one(pool, "select user_id from drivers where id = $1", [t.driver_id]) : null;
      if (d?.user_id !== u.id) throw forbidden("Это не ваш рейс");
    }
    const r = routeFor(t.dest);
    if (!r.includes(city) || r.indexOf(city) < r.indexOf(t.origin)) throw bad("Город не на маршруте рейса");
    await tx(pool, async (c) => {
      await c.query("update trips set current_city = $2 where id = $1", [id, city]);
      await c.query("insert into trip_events(trip_id, city, note) values ($1,$2,$3)", [id, city, u.role === "driver" ? "Отметка водителя" : "Отметка менеджера"]);
      await audit(c, u.id, "trip_position", "trip", id, { city });
    });
    return { trip: tripOut(await load(id)) };
  });

  // приёмщик ставит машину со своей площадки в рейс дальше
  app.post("/trips/:id/cars", async (req) => {
    const u = await requireUser(pool, req, "manager", "terminal");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { orderNo } = z.object({ orderNo: z.number().int() }).parse(req.body);
    const t = await load(id);
    if (!canManage(u, t)) throw forbidden();
    return tx(pool, async (c) => {
      const o = await one(c, "select * from orders where no = $1 for update", [orderNo]);
      if (!o || o.transfer_city !== t.origin) throw bad(`Машина №${orderNo} не идёт через ${t.origin}`);
      if (!routeFor(t.dest).includes(o.city)) throw bad(`Рейс ${t.code} не идёт до ${o.city}`);
      const done = await doneStages(c, orderNo);
      if (!done.has("term_in")) throw bad("Машина ещё не принята на терминал");
      if (done.has("term_out")) throw conflict("Машина уже отгружена");
      const n = (await one(c, "select count(*)::int n from order_legs where trip_id = $1 and order_no <> $2", [id, orderNo]))!.n;
      if (n >= CAPACITY) throw conflict(`В рейсе нет мест: ${CAPACITY} из ${CAPACITY}`);
      await c.query("update order_legs set trip_id = $2 where order_no = $1 and idx = 1", [orderNo, id]);
      await audit(c, u.id, "trip_add_car", "trip", id, { orderNo });
      return { ok: true };
    });
  });

  app.delete("/trips/:id/cars/:no", async (req) => {
    const u = await requireUser(pool, req, "manager", "terminal");
    const p = z.object({ id: z.string().uuid(), no: z.coerce.number().int() }).parse(req.params);
    const t = await load(p.id);
    if (!canManage(u, t)) throw forbidden();
    const started = await one(pool, "select 1 from media where order_no = $1 and stage = 'term_out' limit 1", [p.no]);
    if (started) throw conflict("Отгрузка машины уже начата");
    const r = await pool.query("update order_legs set trip_id = null where order_no = $1 and idx = 1 and trip_id = $2", [p.no, p.id]);
    if (!r.rowCount) throw notFound("Машины нет в этом рейсе");
    await audit(pool, u.id, "trip_remove_car", "trip", p.id, { orderNo: p.no });
    return { ok: true };
  });
}
