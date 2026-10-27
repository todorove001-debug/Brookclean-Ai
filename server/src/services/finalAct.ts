// итоговый акт приёма-передачи в PDF: собирается при выдаче получателю, хранится в S3 и уходит клиенту
import PDFDocument from "pdfkit";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Readable } from "node:stream";
import { many, one, type Db } from "../db/pool.js";
import { config } from "../config.js";
import { carFolder } from "../domain/files.js";
import { checkpointsOf, DMG_CODES, isInspStageCtx, STAGES, type OrderCtx, type Stage } from "../domain/stages.js";
import type { Storage } from "../storage/index.js";
import { loadOrder } from "./context.js";
import { marksOf } from "./handover.js";

const require = createRequire(import.meta.url);
const FONTS = path.join(path.dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");
const STAGE_COLORS = ["#6b7280", "#2563eb", "#d97706", "#7c3aed", "#dc2626"];
const DMG_NAME = Object.fromEntries(DMG_CODES);

const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("ru-RU", { timeZone: config.tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", "") : "");
// время передачи в строке акта: без года, чтобы строка помещалась
const fmtShort = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("ru-RU", { timeZone: config.tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "") : "");
const fmtDate = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString("ru-RU", { timeZone: config.tz }) : "");
const short = (n: string) => { const p = String(n ?? "").trim().split(/\s+/); return p.length >= 3 && p[1].length > 1 ? `${p[0]} ${p[1][0]}. ${p[2][0]}.` : String(n ?? ""); };
const phoneFmt = (d: string) => (/^7\d{10}$/.test(d) ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : d);
const dot = (t: string) => String(t).trim().replace(/([^.!?])$/, "$1.");

async function toBuffer(r: Readable) { const parts: Buffer[] = []; for await (const c of r) parts.push(Buffer.from(c)); return Buffer.concat(parts); }

// водитель — сторона передачи: какое плечо
function driverLeg(ctx: OrderCtx, st: Stage): 0 | 1 | null {
  if (st === "priemka") return isInspStageCtx(ctx) ? null : 0;
  if (st === "pogruzka" || st === "term_in") return 0;
  if (st === "term_out") return 1;
  return (ctx.legs.length - 1) as 0 | 1;
}

export async function buildFinalAct(db: Db, storage: Storage, no: number): Promise<Buffer> {
  const { row: o, ctx } = await loadOrder(db, no);
  const cps = checkpointsOf(ctx), secs = await many(db, "select * from act_sections where order_no = $1", [no]);
  const stages = await many(db, "select * from stages where order_no = $1", [no]);
  const marks = await marksOf(db, no);
  const drivers = await many(db, `select d.*, u.license from drivers d left join users u on u.id = d.user_id where d.id = any($1)`,
    [ctx.legs.map((l) => l.trip?.driverId).filter(Boolean)]);
  const sigImg = async (s: any) => {
    if (!s?.mediaId) return null;
    const m = await one(db, "select storage_key from media where id = $1", [s.mediaId]);
    return m ? toBuffer(await storage.get(m.storage_key)).catch(() => null) : null;
  };
  const sec = (st: Stage) => secs.find((x) => x.stage === st);
  const fin = sec("vygruzka") ?? {};
  const num = (st: string) => cps.findIndex((c) => c.id === st) + 1;
  const color = (st: string) => STAGE_COLORS[(num(st) - 1) % STAGE_COLORS.length];
  const drvLine = (st: Stage) => {
    const leg = driverLeg(ctx, st), t = leg == null ? null : ctx.legs[leg]?.trip, d = t && drivers.find((x) => x.id === t.driverId);
    if (!d) return "";
    return `водитель ${short(d.name)}: ВУ ${d.docs?.license?.number ?? d.license ?? "—"}, тягач ${d.tractor_plate ?? "—"}, прицеп ${d.trailer_plate ?? "—"}`;
  };

  // один лист A4: реквизиты, схема и журнал дефектов, передачи с подписями, получение автомобиля
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `Акт приёма-передачи № ${no}`, Author: "Brookclean" } });
  doc.registerFont("r", path.join(FONTS, "DejaVuSerifCondensed.ttf"));
  doc.registerFont("b", path.join(FONTS, "DejaVuSerifCondensed-Bold.ttf"));
  const out: Buffer[] = [];
  doc.on("data", (c: Buffer) => out.push(c));
  const done = new Promise<void>((ok) => doc.on("end", () => ok()));
  const PW = doc.page.width, PH = doc.page.height, L = 24, R = PW - 24;
  // текст с переносом по ширине; возвращает y под ним
  const t = (s: string, x: number, y: number, o: { size?: number; bold?: boolean; color?: string; width?: number; align?: "center" } = {}) => {
    doc.font(o.bold ? "b" : "r").fontSize(o.size ?? 7.5).fillColor(o.color ?? "#111");
    const width = o.width ?? R - x;
    doc.text(s, x, y, { width, lineGap: 1, align: o.align });
    return y + doc.heightOfString(s, { width, lineGap: 1 });
  };
  const line = (x1: number, y: number, x2: number, w = 0.5, c = "#999") => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(c).stroke();
  const sigCell = async (x: number, y: number, label: string, s: any, name: string) => {
    t(label, x, y, { size: 6.3, color: "#555", width: 240 });
    const img = await sigImg(s);
    if (img) doc.image(img, x, y + 8, { fit: [60, 19] });
    line(x, y + 28, x + 150);
    t(`подпись / ${short(name)}${s?.at ? " · " + fmtShort(s.at) : ""}`, x, y + 30, { size: 6.3, color: "#444", width: 250 });
  };
  const rep = fin.receiver === "rep", vyg = stages.find((x) => x.stage === "vygruzka");

  // шапка и стороны
  doc.image(path.join(ASSETS, "logo.jpg"), R - 40, 14, { width: 40 });
  t("АКТ ПРИЁМА – ПЕРЕДАЧИ АВТОМОБИЛЯ", L, 20, { size: 13, bold: true, width: R - L - 50 });
  t(`итоговый, при выдаче получателю · к договору перевозки № ${no} от ${fmtDate(o.created_at)} · ${vyg?.place ?? o.city}, ${fmtDate(vyg?.done_at)}`, L, 38, { size: 7.7, color: "#444", width: R - L - 50 });
  let y = 56;
  y = t(`Перевозчик: ${config.carrier.name}, ИНН ${config.carrier.inn}, тел. ${config.carrier.phone}.`, L, y, { width: R - L - 50 });
  y = t(`Заказчик: ${o.client_fio}, паспорт ${o.passport_series ?? ""} ${o.passport_number ?? ""}, выдан ${o.passport_issued ?? ""} ${fmtDate(o.passport_date)}, тел. ${phoneFmt(o.client_phone)}.`, L, y);
  y = t(`Автомобиль: ${o.car} · VIN / кузов ${o.vin} · ${o.year} г. · ${o.color} · гос. номер ${o.plate || "без номера"} · ключей ${o.keys_count || "—"} · ПТС ${[o.pts_type, o.pts_no].filter(Boolean).join(" ") || "—"}${o.extra_docs ? " · " + o.extra_docs : ""}. Маршрут: Владивосток → ${o.transfer_city ? o.transfer_city + " (перегрузка) → " : ""}${o.city}.`, L, y);

  // схема слева: цвет отметки — этап, на котором её поставили; справа легенда и журнал дефектов
  const dy = y + 6, dw = 250, dh = dw * 514 / 702, cx = L + dw + 16, cw = R - cx;
  doc.image(path.join(ASSETS, "diagram.jpg"), L, dy, { width: dw });
  for (const m of marks.filter((m) => !m.removed)) {
    const mx = L + m.x * dw, my = dy + m.y * dh;
    doc.circle(mx, my, 7).fill(color(m.firstStage));
    t(m.code, mx - 10, my - 3.6, { size: 6, bold: true, color: "#fff", width: 20, align: "center" });
  }
  let ry = dy + 2;
  cps.forEach((cp, i) => { doc.circle(cx + 3.5, ry + 4, 3.5).fill(color(cp.id)); t(`${i + 1} · ${STAGES[cp.id].name}`, cx + 11, ry, { size: 7.2 }); ry += 10; });
  ry = t("Журнал дефектов", cx, ry + 6, { size: 8, bold: true }) + 2;
  if (!marks.length) ry = t("Дефектов при передачах не отмечено.", cx, ry, { size: 6.9 });
  const bottom = dy + dh;
  for (const [i, m] of marks.entries()) {
    const f = m.history[0];
    const more = m.history.slice(1).map((h) => h.action === "refine" ? `эт.${num(h.stage)}: ${h.from}→${h.to}` : h.action === "remove" ? `эт.${num(h.stage)} снята: ${h.reason}` : "").filter(Boolean).join("; ");
    const s = `${m.code} ${m.part || "на схеме"} — эт.${num(m.firstStage)}, ${short(f.who)}, ${fmtShort(f.at)}${f.src === "ai" ? ", ИИ" : ""}${more ? "; " + more : ""}${m.removed ? " (снята)" : ""}`;
    if (ry + 9 > bottom) { t(`… ещё ${marks.length - i} — в системе`, cx, ry, { size: 6.5, color: "#666" }); break; }
    ry = t(s, cx, ry, { size: 6.9, color: m.removed ? "#888" : "#111", width: cw });
  }

  // передачи и подписи с расшифровкой
  y = Math.max(bottom, ry) + 10;
  y = t("Передачи и подписи", L, y, { size: 8.7, bold: true }) + 2;
  const rowH = Math.min(57, Math.floor((PH - y - 175) / cps.length));
  for (const cp of cps) {
    const s = sec(cp.id), st = stages.find((x) => x.stage === cp.id), dl = drvLine(cp.id), last = cp.id === "vygruzka";
    if (!s) continue;
    doc.rect(L, y + 3, 2.4, rowH - 6).fill(color(cp.id));
    t(`${num(cp.id)}. ${STAGES[cp.id].name} · ${st?.place ?? ""} · ${fmtShort(s.closed_at) || "не закрыт"}`, L + 7, y + 4, { size: 7.5, bold: true, width: 276 });
    if (dl) t(dl, 309, y + 5, { size: 6.3, color: "#555", width: R - 309 });
    if (s.disagree) t(`Сдающая сторона не согласна: ${s.dis_comment}`, L + 7, y + 13, { size: 6.3, color: "#9a5b00", width: 276 });
    await sigCell(L + 7, y + 17, `Сдал: ${s.give_role}`, s.give_sig, s.give_name + (s.absent ? ` (не подписал: ${s.absent_reason})` : ""));
    await sigCell(309, y + 17, `Принял: ${last && rep ? "представитель по доверенности" : s.take_role}`, s.take_sig, last && rep ? fin.rep_fio : s.take_name);
    y += rowH;
  }

  // заключение получателя
  y += 4; line(L, y, R, 0.9, "#111"); y += 8;
  y = t("Получение автомобиля", L, y, { size: 8.7, bold: true }) + 2;
  y = t(rep
    ? `Автомобиль получил представитель заказчика ${fin.rep_fio}, паспорт ${fin.rep_passport}, по доверенности № ${fin.poa_no}${fin.poa_date ? " от " + fin.poa_date : ""}.`
    : `Автомобиль получил заказчик ${o.client_fio}, паспорт ${o.passport_series ?? ""} ${o.passport_number ?? ""}, выдан ${o.passport_issued ?? ""} ${fmtDate(o.passport_date)}.`, L, y, { size: 7.7 });
  y = t(fin.outcome === "remarks" ? `Автомобиль получен с замечаниями: ${dot(fin.final_remarks)}`
    : "Автомобиль получен. Состояние соответствует отметкам в акте, комплектность проверена. Претензий к перевозчику нет.", L, y, { size: 7.7, bold: true });
  if (fin.notes) y = t(`Дополнительно: ${fin.notes}`, L, y, { size: 7.1, color: "#333" });
  y += 8;
  await sigCell(L, y, "Выдал (перевозчик)", fin.give_sig, fin.give_name ?? "");
  await sigCell(309, y, "Получил", fin.take_sig, rep ? fin.rep_fio : fin.take_name ?? "");
  t(`Сформировано в системе Brookclean · ${fmt(new Date())} · фото и видео всех передач хранятся в папке автомобиля`, L, PH - 18, { size: 6.3, color: "#777" });
  doc.end();
  await done;
  return Buffer.concat(out);
}

// акт собирается один раз и хранится рядом с фото машины; при ошибке соберётся при первом запросе
export async function ensureFinalAct(db: Db, storage: Storage, no: number): Promise<string> {
  const o = await one(db, "select no, car, vin, created_at, final_act_key from orders where no = $1", [no]);
  if (o.final_act_key) return o.final_act_key;
  const pdf = await buildFinalAct(db, storage, no);
  const key = `${carFolder(o, new Date(o.created_at).getFullYear())}/Итоговый_акт_${no}.pdf`;
  await storage.put(key, pdf, "application/pdf");
  await db.query("update orders set final_act_key = $2, final_act_at = now() where no = $1", [no, key]);
  return key;
}
