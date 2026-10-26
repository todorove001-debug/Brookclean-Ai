// сборка контекста заказа: плечи, рейсы, водители — то, на чём работают правила из domain/stages
import { many, one, type Db } from "../db/pool.js";
import { notFound } from "../errors.js";
import { ORIGIN_CITY } from "../domain/route.js";
import { checkpointsOf, loadCityOf, partyLabel, sidesOf, type OrderCtx, type Stage, type TripInfo } from "../domain/stages.js";

export const TRIP_SQL = `select t.id, t.code, t.status, t.origin, t.load_city, t.dest, t.current_city, t.driver_id, d.user_id as driver_user_id, d.name as driver_name
  from trips t left join drivers d on d.id = t.driver_id`;
export const tripInfo = (r: any): TripInfo => ({
  id: r.id, code: r.code, status: r.status, origin: r.origin, loadCity: r.load_city, dest: r.dest,
  currentCity: r.current_city, driverId: r.driver_id, driverUserId: r.driver_user_id, driverName: r.driver_name,
});

export interface OrderRow { no: number; car: string; vin: string; city: string; client_fio: string; transfer_city: string | null; created_at: Date; [k: string]: any }

export async function loadOrder(db: Db, no: number): Promise<{ row: OrderRow; ctx: OrderCtx }> {
  const row = await one<OrderRow>(db, "select * from orders where no = $1", [no]);
  if (!row) throw notFound(`Заказ №${no} не найден`);
  const legs = await many(db, `select l.idx, l.from_city, l.to_city, t.* from order_legs l left join (${TRIP_SQL}) t on t.id = l.trip_id
    where l.order_no = $1 order by l.idx`, [no]);
  const ctx: OrderCtx = {
    no, city: row.city, clientFio: row.client_fio, transferCity: row.transfer_city,
    legs: legs.map((l) => ({ idx: l.idx, from: l.from_city, to: l.to_city, trip: l.id ? tripInfo(l) : null })),
  };
  return { row, ctx };
}

export async function inspNameFn(db: Db) {
  const rows = await many(db, "select terminal_city, name from users where role = 'terminal' and status = 'active' order by created_at");
  return (city: string) => rows.find((r) => r.terminal_city === city)?.name ?? `приёмщик, ${city}`;
}

export function placeOf(ctx: OrderCtx, st: Stage) {
  return st === "priemka" || st === "pogruzka" ? loadCityOf(ctx) : st === "vygruzka" ? ctx.city : ctx.transferCity ?? ORIGIN_CITY;
}

export async function ensureStage(db: Db, ctx: OrderCtx, st: Stage) {
  await db.query("insert into stages(order_no, stage, place) values ($1,$2,$3) on conflict do nothing", [ctx.no, st, placeOf(ctx, st)]);
  return (await one(db, "select * from stages where order_no = $1 and stage = $2", [ctx.no, st]))!;
}

// раздел акта: ФИО сторон подтягиваются из рейса, пока их не правили вручную и никто не подписал
export async function ensureSection(db: Db, ctx: OrderCtx, st: Stage) {
  const insp = await inspNameFn(db), s = sidesOf(ctx, st);
  const [gr, gn] = partyLabel(ctx, st, s.give, insp), [tr, tn] = partyLabel(ctx, st, s.take, insp);
  await db.query(`insert into act_sections(order_no, stage, give_role, give_name, take_role, take_name) values ($1,$2,$3,$4,$5,$6)
    on conflict (order_no, stage) do update set give_role = excluded.give_role, give_name = excluded.give_name, take_role = excluded.take_role, take_name = excluded.take_name
    where not act_sections.named and act_sections.give_sig is null and act_sections.take_sig is null and act_sections.closed_at is null`,
    [ctx.no, st, gr, gn, tr, tn]);
  return (await one(db, "select * from act_sections where order_no = $1 and stage = $2", [ctx.no, st]))!;
}

export async function doneStages(db: Db, no: number) {
  const r = await many(db, "select stage from stages where order_no = $1 and done_at is not null", [no]);
  return new Set(r.map((x) => x.stage as Stage));
}

export const stageNum = (ctx: OrderCtx, st: Stage) => checkpointsOf(ctx).findIndex((c) => c.id === st) + 1;
