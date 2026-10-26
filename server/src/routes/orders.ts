// заказы для менеджера: стоянка, оплата, назначение на рейсы (прямой или через терминал)
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { many, one, tx, type Db } from "../db/pool.js";
import { bad, conflict, notFound } from "../errors.js";
import { canTransfer, ORIGIN_CITY, routeFor, TRANSFER_CITY } from "../domain/route.js";
import { requireUser } from "../services/auth.js";
import { audit } from "../services/audit.js";
import { doneStages, loadOrder } from "../services/context.js";

export const CAPACITY = 8;

const orderOut = (o: any, legs: any[], done: string[]) => ({
  no: o.no, createdAt: o.created_at, car: o.car, vin: o.vin, year: o.year, color: o.color, body: o.body, value: o.value, city: o.city,
  client: { fio: o.client_fio, phone: o.client_phone }, tariff: o.tariff, cashback: o.cashback, insurance: o.insurance, partnerCode: o.partner_code,
  transferCity: o.transfer_city, trackToken: o.track_token, signedAt: o.signed_at, docHash: o.doc_hash,
  carDocs: { plate: o.plate, ptsType: o.pts_type, ptsNo: o.pts_no, keys: o.keys_count, extraDocs: o.extra_docs },
  payment: { delivery: o.pay_delivery, insurance: o.pay_insurance, payTo: o.pay_to, payForm: o.pay_form, policyNo: o.policy_no },
  deliveredAt: o.delivered_at,
  legs: legs.filter((l) => l.order_no === o.no).map((l) => ({ idx: l.idx, from: l.from_city, to: l.to_city, tripId: l.trip_id, tripCode: l.code })),
  stagesDone: done,
});

async function tripLoad(db: Db, tripId: string, exceptNo: number) {
  const r = await one(db, "select count(*)::int n from order_legs where trip_id = $1 and order_no <> $2", [tripId, exceptNo]);
  return r!.n as number;
}

export default async function (app: FastifyInstance) {
  const { pool } = app.deps;

  app.get("/orders", async (req) => {
    await requireUser(pool, req, "manager");
    const rows = await many(pool, "select * from orders order by no desc limit 500");
    const nos = rows.map((r) => r.no);
    const legs = await many(pool, "select l.*, t.code from order_legs l left join trips t on t.id = l.trip_id where l.order_no = any($1) order by l.idx", [nos]);
    const st = await many(pool, "select order_no, stage from stages where order_no = any($1) and done_at is not null", [nos]);
    return { orders: rows.map((o) => orderOut(o, legs, st.filter((s) => s.order_no === o.no).map((s) => s.stage))) };
  });

  app.get("/orders/:no", async (req) => {
    await requireUser(pool, req, "manager");
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const o = await one(pool, "select * from orders where no = $1", [no]);
    if (!o) throw notFound(`Заказ №${no} не найден`);
    const legs = await many(pool, "select l.*, t.code from order_legs l left join trips t on t.id = l.trip_id where l.order_no = $1 order by l.idx", [no]);
    return { order: orderOut(o, legs, [...(await doneStages(pool, no))]) };
  });

  const Patch = z.object({
    payDelivery: z.boolean(), payInsurance: z.boolean(), payTo: z.string().max(80).nullable(), payForm: z.string().max(20).nullable(),
    policyNo: z.string().max(40).nullable(),
  }).partial();
  const COLS: Record<string, string> = { payDelivery: "pay_delivery", payInsurance: "pay_insurance", payTo: "pay_to", payForm: "pay_form", policyNo: "policy_no" };

  app.patch("/orders/:no", async (req) => {
    const m = await requireUser(pool, req, "manager");
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const b = Patch.parse(req.body);
    const keys = Object.keys(b);
    if (!keys.length) throw bad("Нечего менять");
    const o = await one(pool, `update orders set ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(", ")} where no = $1 returning no`,
      [no, ...keys.map((k) => (b as any)[k])]);
    if (!o) throw notFound(`Заказ №${no} не найден`);
    await audit(pool, m.id, "order_update", "order", no, b);
    return { ok: true };
  });

  // маршрут машины: прямой рейс или через терминал Новосибирск
  const Route = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("direct"), tripId: z.string().uuid() }),
    z.object({ mode: z.literal("terminal"), trip1Id: z.string().uuid().nullable(), trip2Id: z.string().uuid().nullable().optional() }),
  ]);

  app.post("/orders/:no/route", async (req) => {
    const m = await requireUser(pool, req, "manager");
    const { no } = z.object({ no: z.coerce.number().int() }).parse(req.params);
    const b = Route.parse(req.body);
    return tx(pool, async (c) => {
      const { row, ctx } = await loadOrder(c, no);
      const done = await doneStages(c, no);
      const trip = async (id: string) => {
        const t = await one(c, "select * from trips where id = $1", [id]);
        if (!t) throw notFound("Рейс не найден");
        if ((await tripLoad(c, id, no)) >= CAPACITY) throw conflict(`В рейсе ${t.code} нет мест: ${CAPACITY} из ${CAPACITY}`);
        return t;
      };
      const leg0Locked = done.has("pogruzka") || done.has("term_in");
      if (b.mode === "direct") {
        if (ctx.legs.length > 1 && done.has("term_in")) throw conflict("Машина уже на терминале — маршрут через терминал не меняется");
        const t = await trip(b.tripId);
        if (t.origin !== ORIGIN_CITY || !routeFor(t.dest).includes(row.city)) throw bad(`Рейс ${t.code} не проходит через ${row.city}`);
        if (leg0Locked && ctx.legs[0]?.trip?.id !== t.id) throw conflict("Машина уже погружена — рейс не меняется");
        await c.query("delete from order_legs where order_no = $1 and idx = 1", [no]);
        await c.query("update order_legs set trip_id = $2, to_city = $3 where order_no = $1 and idx = 0", [no, t.id, row.city]);
        await c.query("update orders set transfer_city = null where no = $1", [no]);
      } else {
        if (!canTransfer(row.city)) throw bad(`Город ${row.city} не идёт через терминал ${TRANSFER_CITY}`);
        if (ctx.legs.length === 1 && leg0Locked) throw conflict("Машина уже погружена в прямой рейс");
        if (leg0Locked && ctx.legs[0]?.trip?.id !== b.trip1Id) throw conflict("Машина уже погружена — первый рейс не меняется");
        if (b.trip1Id) {
          const t1 = await trip(b.trip1Id);
          if (t1.origin !== ORIGIN_CITY || t1.dest !== TRANSFER_CITY) throw bad(`Рейс ${t1.code} не идёт до терминала ${TRANSFER_CITY}`);
        }
        if (b.trip2Id) {
          const t2 = await trip(b.trip2Id);
          if (t2.origin !== TRANSFER_CITY || !routeFor(t2.dest).includes(row.city)) throw bad(`Рейс ${t2.code} не идёт с терминала до ${row.city}`);
        }
        if (done.has("term_out") && b.trip2Id !== undefined && b.trip2Id !== ctx.legs[1]?.trip?.id) throw conflict("Машина уже отгружена с терминала");
        await c.query("update orders set transfer_city = $2 where no = $1", [no, TRANSFER_CITY]);
        await c.query("update order_legs set trip_id = $2, to_city = $3 where order_no = $1 and idx = 0", [no, b.trip1Id, TRANSFER_CITY]);
        await c.query(`insert into order_legs(order_no, idx, trip_id, from_city, to_city) values ($1, 1, $2, $3, $4)
          on conflict (order_no, idx) do update set trip_id = case when $5::boolean then order_legs.trip_id else excluded.trip_id end, to_city = excluded.to_city`,
          [no, b.trip2Id ?? null, TRANSFER_CITY, row.city, b.trip2Id === undefined]);
      }
      await audit(c, m.id, "order_route", "order", no, b);
      return { ok: true };
    });
  });
}
