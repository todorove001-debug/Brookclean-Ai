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

  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true, info: { Title: `Акт приёма-передачи № ${no}`, Author: "Brookclean" } });
  doc.registerFont("r", path.join(FONTS, "DejaVuSerif.ttf"));
  doc.registerFont("b", path.join(FONTS, "DejaVuSerif-Bold.ttf"));
  const out: Buffer[] = [];
  doc.on("data", (c: Buffer) => out.push(c));
  const done = new Promise<void>((ok) => doc.on("end", () => ok()));
  const W = doc.page.width - 80;
  const h2 = (t: string) => { doc.moveDown(0.6).font("b").fontSize(12).fillColor("#111").text(t); doc.moveDown(0.2).font("r").fontSize(10); };
  const room = (h: number) => { if (doc.y + h > doc.page.height - 50) doc.addPage(); };

  // шапка
  doc.image(path.join(ASSETS, "logo.jpg"), doc.page.width - 40 - 60, 36, { width: 60 });
  doc.font("b").fontSize(16).text("АКТ ПРИЁМА – ПЕРЕДАЧИ АВТОМОБИЛЯ", 40, 42, { width: W - 70 });
  doc.font("r").fontSize(10).fillColor("#444").text("итоговый, при выдаче получателю");
  const vyg = stages.find((x) => x.stage === "vygruzka");
  doc.fillColor("#111").text(`к договору перевозки № ${no} от ${fmtDate(o.created_at)} · ${vyg?.place ?? o.city}, ${fmtDate(vyg?.done_at)}`);

  h2("Стороны");
  doc.text(`Перевозчик: ${config.carrier.name}, ИНН ${config.carrier.inn}, тел. ${config.carrier.phone}.`);
  doc.text(`Заказчик: ${o.client_fio}, паспорт ${o.passport_series ?? ""} ${o.passport_number ?? ""}, выдан ${o.passport_issued ?? ""} ${fmtDate(o.passport_date)}, тел. ${phoneFmt(o.client_phone)}.`);

  h2("Автомобиль");
  doc.text(`${o.car} · VIN / кузов ${o.vin} · ${o.year} г. · цвет ${o.color} · гос. номер ${o.plate || "без номера"} · ключей ${o.keys_count || "—"} · ПТС ${o.pts_type || "—"} ${o.pts_no || ""}${o.extra_docs ? " · " + o.extra_docs : ""}`);
  doc.text(`Маршрут: Владивосток → ${o.transfer_city ? o.transfer_city + " (перегрузка на терминале) → " : ""}${o.city}.`);

  // схема кузова с отметками: цвет — этап, на котором отметку поставили
  doc.moveDown(0.6);
  const dx = 40, dy = doc.y, dw = 300, dh = dw * 514 / 702;
  doc.image(path.join(ASSETS, "diagram.jpg"), dx, dy, { width: dw });
  for (const m of marks.filter((m) => !m.removed)) {
    const mx = dx + m.x * dw, my = dy + m.y * dh;
    doc.circle(mx, my, 8).fill(color(m.firstStage));
    doc.font("b").fontSize(7).fillColor("#fff").text(m.code, mx - 8, my - 3.5, { width: 16, align: "center" });
  }
  cps.forEach((cp, i) => {
    doc.circle(dx + dw + 30, dy + 10 + i * 16, 4).fill(color(cp.id));
    doc.font("r").fontSize(9).fillColor("#111").text(`${i + 1} · ${STAGES[cp.id].name}`, dx + dw + 40, dy + 5 + i * 16);
  });
  doc.x = 40; doc.y = dy + dh + 6;

  h2("Журнал дефектов");
  if (!marks.length) doc.text("Дефектов при передачах не отмечено.");
  for (const m of marks) {
    const f = m.history[0];
    const more = m.history.slice(1).map((h) => h.action === "refine" ? `эт.${num(h.stage)} ${short(h.who)}: ${h.from}→${h.to}` : h.action === "remove" ? `эт.${num(h.stage)} ${short(h.who)}: снята («${h.reason}»)` : "").filter(Boolean).join("; ");
    room(30);
    doc.fontSize(9).fillColor(m.removed ? "#888" : "#111").text(`${m.code} (${DMG_NAME[m.code]}) — ${m.part || "отмечено на схеме"}. Этап ${num(m.firstStage)} «${STAGES[m.firstStage as Stage].name}», ${short(f.who)}, ${fmt(f.at)}${f.src === "ai" ? ", по находке ИИ" : ""}${more ? ". " + more : ""}${m.removed ? ". СНЯТА" : ""}`);
  }

  // передачи и подписи с расшифровкой
  doc.addPage();
  doc.font("b").fontSize(13).fillColor("#111").text(`Акт № ${no} · передачи и подписи`);
  const sigCell = async (x: number, y: number, label: string, s: any, name: string) => {
    doc.font("r").fontSize(8).fillColor("#555").text(label, x, y, { width: 240 });
    const img = await sigImg(s);
    if (img) doc.image(img, x, y + 12, { fit: [120, 36] });
    doc.moveTo(x, y + 52).lineTo(x + 220, y + 52).lineWidth(0.5).strokeColor("#999").stroke();
    doc.fontSize(8).fillColor("#555").text(`подпись / ${short(name)}${s?.at ? " · " + fmt(s.at) : ""}`, x, y + 55, { width: 240 });
  };
  for (const cp of cps) {
    const s = sec(cp.id), st = stages.find((x) => x.stage === cp.id), dl = drvLine(cp.id);
    if (!s) continue;
    const h = dl ? 98 : 86;
    room(h + 8);
    const y = doc.y + 8;
    doc.rect(40, y, 3, h - 6).fill(color(cp.id));
    doc.font("b").fontSize(10).fillColor("#111").text(`${num(cp.id)}. ${STAGES[cp.id].name} · ${st?.place ?? ""} · ${fmt(s.closed_at) || "не закрыт"}`, 50, y);
    if (dl) doc.font("r").fontSize(8).fillColor("#444").text(dl, 50, y + 13);
    const yy = y + (dl ? 26 : 14);
    const rep = cp.id === "vygruzka" && fin.receiver === "rep";
    await sigCell(50, yy, `Сдал: ${s.give_role}`, s.give_sig, s.give_name + (s.absent ? ` (не подписал: ${s.absent_reason})` : ""));
    await sigCell(310, yy, `Принял: ${rep ? "представитель по доверенности" : s.take_role}`, s.take_sig, rep ? fin.rep_fio : s.take_name);
    doc.x = 40; doc.y = y + h;
    if (s.disagree) doc.font("r").fontSize(8).fillColor("#9a5b00").text(`Сдающая сторона не согласна: ${s.dis_comment}`, 50);
  }

  // заключение получателя
  room(200);
  doc.moveDown(0.8).moveTo(40, doc.y).lineTo(40 + W, doc.y).lineWidth(1).strokeColor("#111").stroke();
  doc.x = 40; h2("Получение автомобиля");
  doc.fontSize(10.5).fillColor("#111").text(fin.receiver === "rep"
    ? `Автомобиль получил представитель заказчика ${fin.rep_fio}, паспорт ${fin.rep_passport}, по доверенности № ${fin.poa_no}${fin.poa_date ? " от " + fin.poa_date : ""}.`
    : `Автомобиль получил заказчик ${o.client_fio}, паспорт ${o.passport_series ?? ""} ${o.passport_number ?? ""}, выдан ${o.passport_issued ?? ""} ${fmtDate(o.passport_date)}.`, { width: W });
  doc.moveDown(0.3).text(fin.outcome === "remarks"
    ? `Автомобиль получен с замечаниями: ${dot(fin.final_remarks)}`
    : "Автомобиль получен. Состояние соответствует отметкам в акте, комплектность проверена. Претензий к перевозчику нет.", { width: W });
  if (fin.notes) doc.moveDown(0.3).fontSize(9.5).text(`Дополнительно: ${fin.notes}`, { width: W });
  doc.moveDown(1);
  const y = doc.y;
  await sigCell(40, y, "Выдал (перевозчик)", fin.give_sig, fin.give_name ?? "");
  await sigCell(310, y, "Получил", fin.take_sig, fin.receiver === "rep" ? fin.rep_fio : fin.take_name ?? "");
  doc.x = 40; doc.y = y + 80;
  doc.font("r").fontSize(7.5).fillColor("#666").text(`Сформировано в системе Brookclean · ${fmt(new Date())} · фото и видео всех передач хранятся в папке автомобиля`, { width: W });

  // номера страниц
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;   // иначе подпись страницы внизу листа переносится на новую страницу
    doc.font("r").fontSize(7.5).fillColor("#666").text(`стр. ${i + 1} из ${range.count}`, 40, doc.page.height - 32, { width: W, align: "right", lineBreak: false });
  }
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
