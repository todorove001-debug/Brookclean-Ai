// где машина сейчас: статус для клиента, трекинга и кабинета партнёра — без персональных данных
import { many, type Db } from "../db/pool.js";
import { kmOf, routeFor } from "../domain/route.js";
import { loadOrder } from "./context.js";

export async function trackInfo(db: Db, no: number) {
  const { row, ctx } = await loadOrder(db, no);
  const done = new Set((await many(db, "select stage from stages where order_no = $1 and done_at is not null", [no])).map((x) => x.stage));
  const leg = ctx.legs.length > 1 && done.has("term_out") ? ctx.legs[1] : ctx.legs[0];
  const trip = leg?.trip ?? null;
  let status = row.delivered_at ? "Выдан" : !row.signed_at ? "Ждёт подписания" : !trip ? "Оплачен, ждёт рейса" : "В пути";
  if (!row.delivered_at && ctx.legs.length > 1 && done.has("term_in") && !done.has("term_out")) status = `На терминале ${ctx.transferCity}`;
  const km = row.delivered_at ? kmOf(row.city) : Math.min(kmOf(trip?.currentCity), kmOf(row.city));
  if (status === "В пути" && km === 0) status = "Погрузка";
  if (status === "В пути" && km >= kmOf(row.city)) status = "Прибыл";
  return { row, trip, status, km, stops: routeFor(row.city).map((c) => ({ city: c, km: kmOf(c), passed: km > 0 && kmOf(c) <= km })) };
}
