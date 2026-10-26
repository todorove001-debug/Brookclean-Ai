// состояние передачи машины на этапе и проверки: кто может снимать, отмечать дефекты и подписывать
import { many, one, type Db } from "../db/pool.js";
import { forbidden, notFound } from "../errors.js";
import {
  canEditMarks, canShoot, canSign, checkpointsOf, cpGate, isParticipant, isSide, photoSpec, sidesOf, stageMode, vidSpec,
  type OrderCtx, type Stage, type StageMode, type UserCtx,
} from "../domain/stages.js";
import { doneStages, ensureSection, ensureStage, loadOrder, type OrderRow } from "./context.js";

export const ROLE_NAME = { manager: "Менеджер", driver: "Водитель", partner: "Партнёр", terminal: "Терминал" } as const;

// посмотреть машину может менеджер и любой участник её цепочки — для спорных моментов
export function canView(u: UserCtx, ctx: OrderCtx) {
  return u.role === "manager" || checkpointsOf(ctx).some((c) => isParticipant(u, ctx, c.id));
}
export function assertStage(ctx: OrderCtx, st: string): Stage {
  const cp = checkpointsOf(ctx).find((c) => c.id === st);
  if (!cp) throw notFound("Этого этапа нет в маршруте машины");
  return cp.id;
}

export async function modeOf(db: Db, no: number, st: Stage): Promise<StageMode> {
  if (st !== "term_out") return { light: false, why: "" };
  const s = await one(db, "select mode from stages where order_no = $1 and stage = 'term_out'", [no]);
  if (s?.mode) return s.mode;
  const rule = (await one(db, "select value from settings where key = 'term_out_rule'"))?.value ?? "byStay";
  const tin = await one(db, "select done_at from stages where order_no = $1 and stage = 'term_in'", [no]);
  const hours = tin?.done_at ? (Date.now() - new Date(tin.done_at).getTime()) / 36e5 : 0;
  return stageMode(st, rule, hours);
}

export interface StageState {
  row: OrderRow; ctx: OrderCtx; st: Stage; stage: any; section: any; done: Set<Stage>; mode: StageMode;
  photos: ReturnType<typeof photoSpec>; videos: ReturnType<typeof vidSpec>; media: any[];
}

export async function loadStage(db: Db, u: UserCtx, no: number, stRaw: string): Promise<StageState> {
  const { row, ctx } = await loadOrder(db, no);
  if (!canView(u, ctx)) throw forbidden("Машина не из вашей цепочки");
  const st = assertStage(ctx, stRaw);
  const stage = await ensureStage(db, ctx, st), section = await ensureSection(db, ctx, st);
  const mode = await modeOf(db, no, st);
  const media = await many(db, `select id, kind, slot, mime, size, original_name, uploaded_as, created_at from media
    where order_no = $1 and stage = $2 and not replaced order by kind, slot, created_at`, [no, st]);
  return { row, ctx, st, stage, section, done: await doneStages(db, no), mode, photos: photoSpec(st), videos: vidSpec(st, mode), media };
}

export function missingOf(s: StageState) {
  const has = (kind: string, slot: number) => s.media.some((m) => m.kind === kind && m.slot === slot);
  const ph = s.photos.filter((p) => !has("photo", p.slot)), vi = s.videos.filter((v) => v.required && !has("video", v.slot));
  return { photos: ph.map((p) => p.slot), videos: vi.map((v) => v.slot) };
}

export function permsOf(u: UserCtx, s: StageState) {
  const dm = !!s.section.driver_mode, open = !s.section.closed_at && !s.stage.done_at;
  const give = sidesOf(s.ctx, s.st).give;
  return {
    shootTerminal: open && canShoot(u, s.ctx, s.st, "terminal", dm),
    shootDriver: open && canShoot(u, s.ctx, s.st, "driver", dm),
    marks: open && canEditMarks(u, s.ctx, s.st, dm),
    signGive: open && canSign(u, s.ctx, s.st, "give", dm),
    signTake: open && canSign(u, s.ctx, s.st, "take", dm),
    driverMode: open && s.st === "term_out" && isSide(u, s.ctx, give),
    removeAnyMark: u.role === "manager",
  };
}

// от чьего имени запись: при отгрузке с терминала водитель может работать на устройстве приёмщика
export function actorOf(u: UserCtx, s: StageState) {
  const sec = s.section;
  if (s.st === "term_out" && sec.driver_mode && u.role === "terminal") return { who: sec.take_name as string, role: `${sec.take_role} · на устройстве приёмщика` };
  return { who: u.name, role: ROLE_NAME[u.role] + (u.terminalCity ? ` · ${u.terminalCity}` : "") };
}

// любое изменение раздела после подписи сбрасывает подписи: подписывают то, что видят
export async function resetSigs(db: Db, no: number, st: Stage) {
  const r = await db.query("update act_sections set give_sig = null, take_sig = null where order_no = $1 and stage = $2 and closed_at is null and (give_sig is not null or take_sig is not null)", [no, st]);
  return (r.rowCount ?? 0) > 0;
}

export function stateOut(u: UserCtx, s: StageState, marks: any[]) {
  const sec = s.section, gate = cpGate(s.ctx, s.st, s.done);
  const sig = (g: any) => (g ? { at: g.at, deviceName: g.deviceName, mediaId: g.mediaId } : null);
  return {
    order: { no: s.row.no, car: s.row.car, vin: s.row.vin, year: s.row.year, color: s.row.color, city: s.row.city,
      carDocs: { plate: s.row.plate, ptsType: s.row.pts_type, ptsNo: s.row.pts_no, keys: s.row.keys_count, extraDocs: s.row.extra_docs } },
    stage: s.st, num: checkpointsOf(s.ctx).findIndex((c) => c.id === s.st) + 1, chain: checkpointsOf(s.ctx).map((c) => ({ stage: c.id, done: s.done.has(c.id) })),
    place: s.stage.place, startedAt: s.stage.started_at, doneAt: s.stage.done_at, mode: s.mode, gate,
    spec: { photos: s.photos, videos: s.videos },
    media: s.media.map((m) => ({ id: m.id, kind: m.kind, slot: m.slot, mime: m.mime, size: Number(m.size), uploadedAs: m.uploaded_as, at: m.created_at })),
    missing: missingOf(s),
    section: {
      giveRole: sec.give_role, giveName: sec.give_name, takeRole: sec.take_role, takeName: sec.take_name,
      give: sig(sec.give_sig), take: sig(sec.take_sig), disagree: sec.disagree, disComment: sec.dis_comment, absent: sec.absent, absentReason: sec.absent_reason,
      cond: sec.cond, condOther: sec.cond_other, notes: sec.notes, driverMode: sec.driver_mode, closedAt: sec.closed_at,
    },
    marks, perms: permsOf(u, s),
  };
}

export async function marksOf(db: Db, no: number) {
  const ms = await many(db, "select * from defect_marks where order_no = $1 order by id", [no]);
  const hist = await many(db, "select * from mark_history where mark_id = any($1) order by at, id", [ms.map((m) => m.id)]);
  return ms.map((m) => ({
    id: Number(m.id), code: m.code, part: m.part, x: m.x, y: m.y, firstStage: m.first_stage, removed: m.removed,
    history: hist.filter((h) => h.mark_id === m.id).map((h) => ({
      stage: h.stage, action: h.action, code: h.code, from: h.from_code, to: h.to_code, reason: h.reason, src: h.src, photoSlot: h.photo_slot,
      byManager: h.by_manager, who: h.who, role: h.role, userId: h.user_id, at: h.at,
    })),
  }));
}
