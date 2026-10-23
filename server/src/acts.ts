// Кабинет приёмщика: сквозной акт приёма-передачи по шаблону, фото и видео в S3, дефекты, подписи на экране.
// Раздел акта — одна передача машины: приёмка во Владивостоке, приём на терминал перегруза и погрузка с него.
// ИИ (Yandex AI Studio) только предлагает дефекты на фото; в акт они попадают, когда приёмщик согласился.
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { randomBytes } from "node:crypto";
import {
  CONDITIONS, PHOTO_MAX_BYTES, PHOTO_SLOTS, PTS_TYPES, ROLES, STAGES, VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS,
  actBlockers, can, contractDate, isDmgCode, isStage, kmTo, partPos, slotKind, stagesFor,
  type ActCar, type ActMark, type ActMedia, type ActRow, type ActSection, type ActSignature, type ActSuggestion, type ActView, type CarForm,
  type Condition, type CustomerForm, type DmgCode, type MarkHistory, type Permission, type StageId, type StaffMe,
} from "@brookclean/shared";
import type { DB } from "./db.ts";
import type { MediaStore } from "./media.ts";
import { VisionError, recognize, type Vision } from "./recognize.ts";

export function migrateActs(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS acts (
      order_id TEXT NOT NULL,
      stage TEXT NOT NULL,               -- priemka | term_in | term_out
      created_at TEXT NOT NULL,
      acceptor_id INTEGER,
      details TEXT NOT NULL,             -- JSON ActCar: госномер, ПТС, ключи, документы (заполняется при приёмке)
      cond TEXT NOT NULL DEFAULT '[]',   -- условия осмотра
      cond_other TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      give_name TEXT NOT NULL,           -- кто сдаёт
      take_name TEXT NOT NULL,           -- кто принимает
      give_sig TEXT,                     -- JSON ActSignature
      take_sig TEXT,
      disagree INTEGER NOT NULL DEFAULT 0,
      dis_comment TEXT NOT NULL DEFAULT '',
      absent INTEGER NOT NULL DEFAULT 0,
      absent_reason TEXT NOT NULL DEFAULT '',
      closed_at TEXT,
      PRIMARY KEY (order_id, stage)
    );
    CREATE TABLE IF NOT EXISTS act_media (
      order_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      slot TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,                 -- путь файла в S3
      size INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      duration REAL,
      at TEXT NOT NULL,
      staff_id INTEGER,
      ai_status TEXT,                    -- checking | done | error | off
      ai_quality TEXT,
      ai_model TEXT,
      PRIMARY KEY (order_id, stage, slot)
    );
    CREATE TABLE IF NOT EXISTS act_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      stage TEXT NOT NULL,               -- передача, на которой поставили отметку
      code TEXT NOT NULL,
      part TEXT NOT NULL DEFAULT '',
      x REAL NOT NULL,
      y REAL NOT NULL,
      src TEXT NOT NULL,
      removed INTEGER NOT NULL DEFAULT 0,
      history TEXT NOT NULL              -- JSON MarkHistory[]: кто, когда, на какой передаче, что сделал
    );
    CREATE TABLE IF NOT EXISTS act_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      slot TEXT NOT NULL,
      part TEXT NOT NULL,
      code TEXT NOT NULL,
      descr TEXT NOT NULL,
      confidence TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      x REAL NOT NULL,
      y REAL NOT NULL,
      by_name TEXT,
      at TEXT,
      mark_id INTEGER
    );
  `);
  // Перегруз: город терминала и рейс от терминала дальше; площадка приёмщика
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols("orders").includes("transfer")) db.exec("ALTER TABLE orders ADD COLUMN transfer TEXT; ALTER TABLE orders ADD COLUMN trip2_id TEXT;");
  if (!cols("staff").includes("site")) db.exec("ALTER TABLE staff ADD COLUMN site TEXT");
}

export interface ActsContext {
  db: DB;
  now: () => Date;
  store?: MediaStore;
  vision?: Vision;
  need: (...perms: Permission[]) => preHandlerHookHandler;
  audit: (req: FastifyRequest, action: string, details: unknown) => void;
}

interface OrderRow {
  id: string; no: number; created_at: string; status: string; car: string; customer: string;
  trip_id: string | null; transfer: string | null; trip2_id: string | null;
}
interface ActRowDb {
  order_id: string; stage: StageId; created_at: string; acceptor_id: number | null; details: string; cond: string; cond_other: string; notes: string;
  give_name: string; take_name: string; give_sig: string | null; take_sig: string | null; disagree: number; dis_comment: string;
  absent: number; absent_reason: string; closed_at: string | null;
}
interface MediaRow {
  order_id: string; stage: StageId; slot: string; kind: "photo" | "video"; key: string; size: number; content_type: string; duration: number | null;
  at: string; staff_id: number | null; ai_status: string | null; ai_quality: string | null; ai_model: string | null;
}
interface MarkRow { id: number; order_id: string; stage: StageId; code: DmgCode; part: string; x: number; y: number; src: "manual" | "ai"; removed: number; history: string }
interface SugRow {
  id: number; order_id: string; stage: StageId; slot: string; part: string; code: DmgCode; descr: string; confidence: ActSuggestion["confidence"];
  state: ActSuggestion["state"]; x: number; y: number; by_name: string | null; at: string | null; mark_id: number | null;
}
interface TripRow { id: string; truck: string; driver: string; km: number }

const PHOTO_TYPES = new Set(["image/jpeg"]);
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp" };
/** Проверок ИИ в час на одного сотрудника: 24 наружных фото на машину, запас на пересъёмку. */
const AI_PER_HOUR = 300;
const SIG_MAX = 300_000;
const EMPTY_CAR: ActCar = { plate: "", ptsType: "Оригинал", ptsNo: "", keys: "", docs: "" };

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const json = <T>(v: string | null): T | null => (v ? (JSON.parse(v) as T) : null);

export function registerActs(app: FastifyInstance, ctx: ActsContext) {
  const { db, now, need, audit } = ctx;
  const aiLog = new Map<number, number[]>();
  const stamp = () => now().toISOString();
  const who = (me: StaffMe, stage: StageId) => ({ stage, who: me.name, role: ROLES[me.role].name + (me.site ? ` · ${me.site}` : "") });

  const orderByNo = (no: number) => db.prepare("SELECT * FROM orders WHERE no = ?").get(no) as OrderRow | undefined;
  const actOf = (orderId: string, stage: StageId) =>
    db.prepare("SELECT * FROM acts WHERE order_id = ? AND stage = ?").get(orderId, stage) as ActRowDb | undefined;
  const tripOf = (id: string | null) => (id ? db.prepare("SELECT id, truck, driver, km FROM trips WHERE id = ?").get(id) as TripRow | undefined : undefined);
  const stagesOf = (o: OrderRow) => stagesFor(o.transfer);
  const prevStage = (o: OrderRow, stage: StageId) => stagesOf(o)[stagesOf(o).indexOf(stage) - 1] as StageId | undefined;
  /** Приёмщик работает на своей площадке; владелец и менеджер без площадки — везде. */
  const onSite = (me: StaffMe, stage: StageId) => !me.site || me.site === STAGES[stage].site;

  /** Раздел создаётся, когда приёмщик впервые открывает передачу. Стороны — из договора и рейсов, их можно поправить. */
  function ensureAct(o: OrderRow, stage: StageId, me: StaffMe | undefined): ActRowDb {
    const have = actOf(o.id, stage);
    if (have) return have;
    const mine = me && me.role !== "owner" && onSite(me, stage) ? me.name : "";
    const [give, take] = stage === "priemka" ? [(JSON.parse(o.customer) as CustomerForm).fio, mine]
      : stage === "term_in" ? [tripOf(o.trip_id)?.driver ?? "", mine]
      : [mine, tripOf(o.trip2_id)?.driver ?? ""];
    db.prepare(`INSERT INTO acts (order_id, stage, created_at, acceptor_id, details, give_name, take_name) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(o.id, stage, stamp(), me?.id || null, JSON.stringify(EMPTY_CAR), give, take);
    return actOf(o.id, stage)!;
  }

  /** Подписывают то, что видят: изменение раздела после подписи сбрасывает обе его подписи. */
  function changed(a: ActRowDb) {
    if (a.closed_at || !(a.give_sig || a.take_sig)) return;
    db.prepare("UPDATE acts SET give_sig = NULL, take_sig = NULL WHERE order_id = ? AND stage = ?").run(a.order_id, a.stage);
  }

  async function mediaView(m: MediaRow, names: Map<number, string>): Promise<ActMedia> {
    return {
      slot: m.slot, kind: m.kind, url: ctx.store ? await ctx.store.getUrl(m.key, 3600) : "", size: m.size, at: m.at,
      by: m.staff_id ? names.get(m.staff_id) ?? "" : "", durationSec: m.duration,
      ai: m.ai_status ? { status: m.ai_status as NonNullable<ActMedia["ai"]>["status"], quality: m.ai_quality, model: m.ai_model } : null,
    };
  }

  const roleFor = (o: OrderRow, stage: StageId, side: "give" | "take") => {
    const base = STAGES[stage][side];
    const t = stage === "term_in" && side === "give" ? o.trip_id : stage === "term_out" && side === "take" ? o.trip2_id : null;
    return t ? `${base} ${t}` : base;
  };

  async function view(o: OrderRow, stage: StageId): Promise<ActView> {
    const a = actOf(o.id, stage)!;
    const car = JSON.parse(o.car) as CarForm;
    const order = stagesOf(o);
    const upto = new Set(order.slice(0, order.indexOf(stage) + 1));
    const names = new Map((db.prepare("SELECT id, name FROM staff").all() as Array<{ id: number; name: string }>).map((s) => [s.id, s.name]));
    const media = await Promise.all((db.prepare("SELECT * FROM act_media WHERE order_id = ? AND stage = ?").all(o.id, stage) as unknown as MediaRow[])
      .map((m) => mediaView(m, names)));
    const marks = (db.prepare("SELECT * FROM act_marks WHERE order_id = ? ORDER BY id").all(o.id) as unknown as MarkRow[])
      .filter((m) => upto.has(m.stage))
      .map((m): ActMark => ({
        id: m.id, stage: m.stage, code: m.code, part: m.part, x: m.x, y: m.y, src: m.src, removed: !!m.removed,
        history: (JSON.parse(m.history) as MarkHistory[]).filter((h) => upto.has(h.stage)),
      }));
    const suggestions = (db.prepare("SELECT * FROM act_suggestions WHERE order_id = ? AND stage = ? ORDER BY id").all(o.id, stage) as unknown as SugRow[])
      .map((s): ActSuggestion => ({
        id: s.id, slot: s.slot, part: s.part, code: s.code, desc: s.descr, confidence: s.confidence, state: s.state, x: s.x, y: s.y,
        by: s.by_name, at: s.at, markId: s.mark_id,
      }));
    const sections = order.map((st): ActSection => {
      const x = actOf(o.id, st);
      return {
        stage: st, giveName: x?.give_name ?? "", takeName: x?.take_name ?? "",
        give: json<ActSignature>(x?.give_sig ?? null), take: json<ActSignature>(x?.take_sig ?? null), closedAt: x?.closed_at ?? null,
      };
    });
    const first = actOf(o.id, "priemka");
    const v: ActView = {
      no: o.no, stage, sections, transfer: o.transfer, orderStatus: o.status, contractDate: contractDate(new Date(o.created_at)),
      car: { car: car.car, vin: car.vin.toUpperCase(), year: car.year, color: car.color, city: car.city },
      client: (JSON.parse(o.customer) as CustomerForm).fio,
      acceptor: a.acceptor_id ? names.get(a.acceptor_id) ?? "" : "",
      details: first ? (JSON.parse(first.details) as ActCar) : EMPTY_CAR,
      cond: JSON.parse(a.cond) as Condition[], condOther: a.cond_other, notes: a.notes,
      giveName: a.give_name, takeName: a.take_name, giveRole: roleFor(o, stage, "give"), takeRole: roleFor(o, stage, "take"),
      give: json<ActSignature>(a.give_sig), take: json<ActSignature>(a.take_sig),
      disagree: !!a.disagree, disComment: a.dis_comment, absent: !!a.absent, absentReason: a.absent_reason, closedAt: a.closed_at,
      media, marks, suggestions, blockers: [], storage: !!ctx.store, ai: !!ctx.vision,
    };
    const prev = prevStage(o, stage);
    v.blockers = [
      ...(o.status === "draft" ? ["Клиент ещё не подписал договор перевозки"] : []),
      ...(prev && !actOf(o.id, prev)?.closed_at ? [`Сначала закройте раздел «${STAGES[prev].name}»`] : []),
      ...actBlockers(v),
    ];
    return v;
  }

  type Params = { no: string; stage: string };
  /** Заявка и раздел акта из адреса. edit — раздел можно менять: не закрыт, своя площадка, прошлая передача закрыта. */
  function load(req: FastifyRequest<{ Params: Params }>, reply: FastifyReply, edit: boolean) {
    const o = orderByNo(Number(req.params.no));
    const stage = req.params.stage;
    if (!o || !isStage(stage) || !stagesOf(o).includes(stage)) {
      reply.code(404).send({ error: o ? "У этой машины нет такой передачи" : "Заявка не найдена" });
      return undefined;
    }
    const me = req.staff!;
    const a = ensureAct(o, stage, can(me.role, "acts.edit") ? me : undefined);
    if (edit) {
      const prev = prevStage(o, stage);
      const why = a.closed_at ? "Раздел акта закрыт и подписан. Изменить отметку может только менеджер"
        : !onSite(me, stage) ? `Эту передачу оформляет площадка ${STAGES[stage].site}`
        : prev && !actOf(o.id, prev)?.closed_at ? `Сначала закройте раздел «${STAGES[prev].name}»` : "";
      if (why) {
        reply.code(409).send({ error: why });
        return undefined;
      }
    }
    return { o, a, stage };
  }

  // --- Списки приёмщика: Владивосток — к приёмке; терминал — прибывают, на площадке, отгружены ---
  app.get("/api/staff/acts", { preHandler: need("acts.read") }, async (req) => {
    const me = req.staff!;
    const orders = db.prepare(`SELECT o.* FROM orders o WHERE o.status IN ('draft', 'signed', 'paid', 'loading') OR o.transfer IS NOT NULL
        OR EXISTS (SELECT 1 FROM acts a WHERE a.order_id = o.id) ORDER BY o.no DESC LIMIT 300`).all() as unknown as OrderRow[];
    const count = (o: OrderRow, stage: StageId, kind: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM act_media WHERE order_id = ? AND stage = ? AND kind = ?").get(o.id, stage, kind) as { n: number }).n;
    const pending = (o: OrderRow, stage: StageId) =>
      (db.prepare("SELECT COUNT(*) AS n FROM act_suggestions WHERE order_id = ? AND stage = ? AND state = 'pending'").get(o.id, stage) as { n: number }).n;
    const out: ActRow[] = [];
    for (const o of orders) {
      const car = JSON.parse(o.car) as CarForm;
      const row = (stage: StageId, group: ActRow["group"]): ActRow => {
        const a = actOf(o.id, stage);
        const t = tripOf(o.trip_id), t2 = tripOf(o.trip2_id);
        return {
          no: o.no, stage, group, transfer: o.transfer, car: car.car, vin: car.vin.toUpperCase(), year: car.year, color: car.color, city: car.city,
          client: (JSON.parse(o.customer) as CustomerForm).fio, orderStatus: o.status, createdAt: o.created_at,
          trip: t ? { id: t.id, truck: t.truck, driver: t.driver, kmLeft: Math.max(0, kmTo(o.transfer ?? car.city) - t.km) } : null,
          trip2: t2 ? { id: t2.id, truck: t2.truck, driver: t2.driver } : null,
          photos: count(o, stage, "photo"), videos: count(o, stage, "video"), pending: pending(o, stage),
          closedAt: a?.closed_at ?? null, signed: !!(a?.give_sig || a?.take_sig),
        };
      };
      if (onSite(me, "priemka")) out.push(row("priemka", actOf(o.id, "priemka")?.closed_at ? "done" : "todo"));
      if (o.transfer && onSite(me, "term_in")) {
        if (!actOf(o.id, "term_in")?.closed_at) out.push(row("term_in", "incoming"));
        else out.push(row("term_out", actOf(o.id, "term_out")?.closed_at ? "done" : "yard"));
      }
    }
    return out;
  });

  app.get<{ Params: Params }>("/api/staff/acts/:no/:stage", { preHandler: need("acts.read") }, async (req, reply) => {
    const x = load(req, reply, false);
    return x && view(x.o, x.stage);
  });

  // --- Поля раздела ---
  type ActPatch = Partial<{
    details: Partial<ActCar>; cond: Condition[]; condOther: string; notes: string; giveName: string; takeName: string;
    disagree: boolean; disComment: string; absent: boolean; absentReason: string;
  }>;
  app.patch<{ Params: Params; Body: ActPatch }>("/api/staff/acts/:no/:stage", { preHandler: need("acts.edit") }, async (req, reply) => {
    const x = load(req, reply, true);
    if (!x) return;
    const { o, a, stage } = x;
    const b = req.body ?? {};
    // Несогласие и отказ сдающей стороны — до её подписи; остальное сбрасывает подписи
    if (("disagree" in b || "disComment" in b || "absent" in b || "absentReason" in b) && a.give_sig)
      return reply.code(409).send({ error: "Сдающая сторона уже подписала акт" });
    const set = (col: string, v: unknown) => db.prepare(`UPDATE acts SET ${col} = ? WHERE order_id = ? AND stage = ?`).run(v as never, o.id, stage);
    let touched = false;
    if (b.details) {
      if (stage !== "priemka") return reply.code(400).send({ error: "Госномер, ПТС и ключи заполняют при приёмке" });
      const d = { ...(JSON.parse(a.details) as ActCar) };
      for (const k of ["plate", "ptsNo", "keys", "docs"] as const) if (k in b.details) d[k] = clip(b.details[k], 200);
      if (b.details.ptsType !== undefined) {
        if (!PTS_TYPES.includes(b.details.ptsType as never)) return reply.code(400).send({ error: "ПТС: оригинал, выписка или заверенная копия" });
        d.ptsType = b.details.ptsType;
      }
      if (d.keys && !/^\d{1,2}$/.test(d.keys)) return reply.code(400).send({ error: "Ключей — число" });
      set("details", JSON.stringify(d));
      touched = true;
    }
    if (b.cond) {
      if (!Array.isArray(b.cond) || b.cond.some((c) => !(c in CONDITIONS))) return reply.code(400).send({ error: "Неизвестное условие осмотра" });
      set("cond", JSON.stringify([...new Set(b.cond)]));
      touched = true;
    }
    for (const [k, col, n] of [["condOther", "cond_other", 300], ["notes", "notes", 2000], ["giveName", "give_name", 200], ["takeName", "take_name", 200]] as const) {
      if (k in b) { set(col, clip(b[k], n)); touched = true; }
    }
    for (const [k, col] of [["disagree", "disagree"], ["absent", "absent"]] as const) if (k in b) set(col, b[k] ? 1 : 0);
    for (const [k, col] of [["disComment", "dis_comment"], ["absentReason", "absent_reason"]] as const) if (k in b) set(col, clip(b[k], 500));
    if (touched) changed(a);
    audit(req, "act.update", { no: o.no, stage, fields: Object.keys(b) });
    return view(o, stage);
  });

  // --- Фото и видео: телефон грузит файл прямо в S3 по подписанной ссылке ---
  app.post<{ Params: Params; Body: { slot: string; contentType: string; size: number; durationSec?: number } }>(
    "/api/staff/acts/:no/:stage/upload", { preHandler: need("acts.edit") }, async (req, reply) => {
      if (!ctx.store) return reply.code(503).send({ error: "Хранилище фото не настроено на сервере (S3)" });
      const x = load(req, reply, true);
      if (!x) return;
      const { slot, contentType } = req.body ?? ({} as never);
      const kind = slotKind(slot);
      if (!kind) return reply.code(400).send({ error: "Неизвестная ячейка" });
      const err = checkFile(kind, contentType, Number(req.body?.size), req.body?.durationSec);
      if (err) return reply.code(400).send({ error: err });
      const ext = kind === "photo" ? "jpg" : VIDEO_TYPES[contentType];
      const key = `acts/${x.o.no}/${x.stage}/${slot}-${randomBytes(6).toString("hex")}.${ext}`;
      return { key, url: await ctx.store.putUrl(key, contentType) };
    });

  function checkFile(kind: "photo" | "video", contentType: string, size: number, duration?: number) {
    if (kind === "photo") {
      if (!PHOTO_TYPES.has(contentType)) return "Фото — в JPEG";
      if (!(size > 0 && size <= PHOTO_MAX_BYTES)) return "Фото больше 15 МБ";
    } else {
      if (!(contentType in VIDEO_TYPES)) return "Видео — MP4, MOV или WebM";
      if (!(size > 0 && size <= VIDEO_MAX_BYTES)) return "Видео больше 300 МБ: снимите короче";
      if (duration !== undefined && duration !== null && !(Number(duration) <= VIDEO_MAX_SECONDS + 2)) return `Видео не длиннее ${VIDEO_MAX_SECONDS} секунд`;
    }
    return "";
  }

  app.post<{ Params: Params; Body: { slot: string; key: string; contentType: string; durationSec?: number } }>(
    "/api/staff/acts/:no/:stage/media", { preHandler: need("acts.edit") }, async (req, reply) => {
      if (!ctx.store) return reply.code(503).send({ error: "Хранилище фото не настроено на сервере (S3)" });
      const x = load(req, reply, true);
      if (!x) return;
      const { o, a, stage } = x;
      const { slot, key, contentType } = req.body ?? ({} as never);
      const kind = slotKind(slot);
      if (!kind || typeof key !== "string" || !key.startsWith(`acts/${o.no}/${stage}/${slot}-`)) return reply.code(400).send({ error: "Файл не от этой ячейки" });
      const size = await ctx.store.size(key);
      if (size === null) return reply.code(409).send({ error: "Файл не дошёл до хранилища. Попробуйте ещё раз" });
      const err = checkFile(kind, contentType, size, req.body?.durationSec);
      if (err) {
        await ctx.store.remove(key).catch(() => {});
        return reply.code(400).send({ error: err });
      }
      const old = db.prepare("SELECT key FROM act_media WHERE order_id = ? AND stage = ? AND slot = ?").get(o.id, stage, slot) as { key: string } | undefined;
      const slotAi = kind === "photo" && PHOTO_SLOTS.find((s) => s.id === slot)!.ai;
      db.prepare(`INSERT INTO act_media (order_id, stage, slot, kind, key, size, content_type, duration, at, staff_id, ai_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(order_id, stage, slot) DO UPDATE SET key = excluded.key, size = excluded.size, content_type = excluded.content_type,
                  duration = excluded.duration, at = excluded.at, staff_id = excluded.staff_id, ai_status = excluded.ai_status, ai_quality = NULL, ai_model = NULL`)
        .run(o.id, stage, slot, kind, key, size, contentType, req.body?.durationSec ? Number(req.body.durationSec) : null, stamp(), req.staff!.id || null,
          slotAi ? (ctx.vision ? "checking" : "off") : null);
      // Переснятое фото: находки ИИ, по которым ещё нет решения, больше не про это фото
      db.prepare("DELETE FROM act_suggestions WHERE order_id = ? AND stage = ? AND slot = ? AND state != 'yes'").run(o.id, stage, slot);
      if (old && old.key !== key) await ctx.store.remove(old.key).catch((e) => req.log.warn(e));
      changed(a);
      audit(req, "act.media", { no: o.no, stage, slot, size });
      if (slotAi && ctx.vision) {
        if (aiAllowed(req.staff!.id)) checkPhoto(o, stage, slot, key, req.log).catch((e) => req.log.error(e));
        else db.prepare("UPDATE act_media SET ai_status = 'error' WHERE order_id = ? AND stage = ? AND slot = ?").run(o.id, stage, slot);
      }
      return view(o, stage);
    });

  app.delete<{ Params: Params & { slot: string } }>("/api/staff/acts/:no/:stage/media/:slot", { preHandler: need("acts.edit") }, async (req, reply) => {
    const x = load(req, reply, true);
    if (!x) return;
    const { o, stage } = x;
    const m = db.prepare("SELECT key FROM act_media WHERE order_id = ? AND stage = ? AND slot = ?").get(o.id, stage, req.params.slot) as { key: string } | undefined;
    if (!m) return reply.code(404).send({ error: "Файла нет" });
    db.prepare("DELETE FROM act_media WHERE order_id = ? AND stage = ? AND slot = ?").run(o.id, stage, req.params.slot);
    db.prepare("DELETE FROM act_suggestions WHERE order_id = ? AND stage = ? AND slot = ? AND state != 'yes'").run(o.id, stage, req.params.slot);
    await ctx.store?.remove(m.key).catch((e) => req.log.warn(e));
    changed(x.a);
    audit(req, "act.media.delete", { no: o.no, stage, slot: req.params.slot });
    return view(o, stage);
  });

  // --- ИИ: ищет повреждения на наружных фото; на перегрузе сравнивает с тем же ракурсом прошлой передачи ---
  function aiAllowed(staffId: number) {
    const t = Date.now();
    const recent = (aiLog.get(staffId) ?? []).filter((x) => x > t - 3600_000);
    if (recent.length >= AI_PER_HOUR) return false;
    aiLog.set(staffId, [...recent, t]);
    return true;
  }

  async function checkPhoto(o: OrderRow, stage: StageId, slot: string, key: string, log: { warn: (o: unknown, m?: string) => void }) {
    const done = (status: string, quality: string | null, model: string | null) =>
      db.prepare("UPDATE act_media SET ai_status = ?, ai_quality = ?, ai_model = ? WHERE order_id = ? AND stage = ? AND slot = ? AND key = ?")
        .run(status, quality, model, o.id, stage, slot, key);
    try {
      const order = stagesOf(o);
      const prevKey = order.slice(0, order.indexOf(stage)).reverse()
        .map((st) => db.prepare("SELECT key FROM act_media WHERE order_id = ? AND stage = ? AND slot = ?").get(o.id, st, slot) as { key: string } | undefined)
        .find(Boolean)?.key;
      const [img, prev] = await Promise.all([ctx.store!.get(key), prevKey ? ctx.store!.get(prevKey).catch(() => undefined) : undefined]);
      const r = await recognize(ctx.vision!, "damage", img, { prev, now: now() });
      // Пока ИИ думал, фото могли переснять: тогда ответ уже не про него
      const cur = db.prepare("SELECT key FROM act_media WHERE order_id = ? AND stage = ? AND slot = ?").get(o.id, stage, slot) as { key: string } | undefined;
      if (cur?.key !== key) return;
      const known = db.prepare("SELECT part, code FROM act_marks WHERE order_id = ? AND removed = 0").all(o.id) as Array<{ part: string; code: string }>;
      const ins = db.prepare(`INSERT INTO act_suggestions (order_id, stage, slot, part, code, descr, confidence, x, y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let added = 0;
      for (const d of r.damages ?? []) {
        const code = isDmgCode(d.code) ? d.code : "A1";
        if (known.some((k) => k.code === code && k.part.toLowerCase() === d.part.toLowerCase())) continue;
        const [x, y] = partPos(d.part, slot);
        ins.run(o.id, stage, slot, d.part.slice(0, 200), code, d.desc.slice(0, 500), d.confidence, x, y);
        added++;
      }
      done("done", r.quality ?? "ok", r.model);
      // Новые находки после подписи — подписи сбрасываются, как при любом изменении
      if (added) { const a = actOf(o.id, stage); if (a) changed(a); }
    } catch (e) {
      if (!(e instanceof VisionError)) log.warn(e, "act ai");
      done("error", null, null);
    }
  }

  app.post<{ Params: Params & { slot: string } }>("/api/staff/acts/:no/:stage/ai/:slot", { preHandler: need("acts.edit") }, async (req, reply) => {
    if (!ctx.vision || !ctx.store) return reply.code(503).send({ error: "ИИ-проверка не настроена на сервере" });
    const x = load(req, reply, true);
    if (!x) return;
    const { o, stage } = x;
    const m = db.prepare("SELECT * FROM act_media WHERE order_id = ? AND stage = ? AND slot = ?").get(o.id, stage, req.params.slot) as MediaRow | undefined;
    if (!m || m.kind !== "photo") return reply.code(404).send({ error: "Сначала сделайте фото" });
    if (!aiAllowed(req.staff!.id)) return reply.code(429).send({ error: "Слишком много проверок за час. Осмотрите фото сами" });
    db.prepare("UPDATE act_media SET ai_status = 'checking' WHERE order_id = ? AND stage = ? AND slot = ?").run(o.id, stage, m.slot);
    checkPhoto(o, stage, m.slot, m.key, req.log).catch((e) => req.log.error(e));
    return view(o, stage);
  });

  // --- Решение приёмщика по находке ИИ: согласен — дефект в акте, нет — отклонено; передумать можно до подписи ---
  app.post<{ Params: Params & { id: string }; Body: { state: "yes" | "no" | "pending"; code?: string } }>(
    "/api/staff/acts/:no/:stage/suggestions/:id", { preHandler: need("acts.edit") }, async (req, reply) => {
      const x = load(req, reply, true);
      if (!x) return;
      const { o, stage } = x;
      const s = db.prepare("SELECT * FROM act_suggestions WHERE id = ? AND order_id = ? AND stage = ?").get(Number(req.params.id), o.id, stage) as SugRow | undefined;
      if (!s) return reply.code(404).send({ error: "Находка не найдена" });
      const state = req.body?.state;
      if (!["yes", "no", "pending"].includes(state)) return reply.code(400).send({ error: "Согласен или нет" });
      const code = req.body?.code !== undefined ? req.body.code : s.code;
      if (!isDmgCode(code)) return reply.code(400).send({ error: "Неизвестный код дефекта" });
      if (s.mark_id) db.prepare("DELETE FROM act_marks WHERE id = ?").run(s.mark_id);
      let markId: number | null = null;
      if (state === "yes") {
        const h: MarkHistory = { act: "add", at: stamp(), ...who(req.staff!, stage), src: "ai", code, slot: s.slot };
        markId = Number(db.prepare(`INSERT INTO act_marks (order_id, stage, code, part, x, y, src, history) VALUES (?, ?, ?, ?, ?, ?, 'ai', ?)`)
          .run(o.id, stage, code, s.part, s.x, s.y, JSON.stringify([h])).lastInsertRowid);
      }
      db.prepare("UPDATE act_suggestions SET state = ?, code = ?, by_name = ?, at = ?, mark_id = ? WHERE id = ?")
        .run(state, code, state === "pending" ? null : req.staff!.name, state === "pending" ? null : stamp(), markId, s.id);
      changed(x.a);
      audit(req, "act.ai", { no: o.no, stage, id: s.id, state, code });
      return view(o, stage);
    });

  // --- Дефекты, отмеченные вручную на схеме ---
  app.post<{ Params: Params; Body: { code: string; part?: string; x: number; y: number } }>(
    "/api/staff/acts/:no/:stage/marks", { preHandler: need("acts.edit") }, async (req, reply) => {
      const x = load(req, reply, true);
      if (!x) return;
      const { o, stage } = x;
      const { code } = req.body ?? ({} as never);
      const px = Number(req.body?.x), py = Number(req.body?.y);
      if (!isDmgCode(code)) return reply.code(400).send({ error: "Выберите код дефекта" });
      if (!(px >= 0 && px <= 1 && py >= 0 && py <= 1)) return reply.code(400).send({ error: "Нажмите на место на схеме" });
      const h: MarkHistory = { act: "add", at: stamp(), ...who(req.staff!, stage), src: "manual", code };
      db.prepare(`INSERT INTO act_marks (order_id, stage, code, part, x, y, src, history) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`)
        .run(o.id, stage, code, clip(req.body?.part, 200), px, py, JSON.stringify([h]));
      changed(x.a);
      audit(req, "act.mark", { no: o.no, stage, code });
      return view(o, stage);
    });

  app.patch<{ Params: Params & { id: string }; Body: { code?: string; part?: string } }>(
    "/api/staff/acts/:no/:stage/marks/:id", { preHandler: need("acts.edit") }, async (req, reply) => {
      const x = load(req, reply, true);
      if (!x) return;
      const { o, stage } = x;
      const m = db.prepare("SELECT * FROM act_marks WHERE id = ? AND order_id = ? AND removed = 0").get(Number(req.params.id), o.id) as MarkRow | undefined;
      if (!m) return reply.code(404).send({ error: "Отметка не найдена" });
      const hist = JSON.parse(m.history) as MarkHistory[];
      if (req.body?.code !== undefined && req.body.code !== m.code) {
        if (!isDmgCode(req.body.code)) return reply.code(400).send({ error: "Неизвестный код дефекта" });
        hist.push({ act: "refine", at: stamp(), ...who(req.staff!, stage), from: m.code, to: req.body.code });
        db.prepare("UPDATE act_marks SET code = ?, history = ? WHERE id = ?").run(req.body.code, JSON.stringify(hist), m.id);
      }
      if (req.body?.part !== undefined && m.stage === stage) db.prepare("UPDATE act_marks SET part = ? WHERE id = ?").run(clip(req.body.part, 200), m.id);
      changed(x.a);
      audit(req, "act.mark.update", { no: o.no, stage, id: m.id, ...req.body });
      return view(o, stage);
    });

  /**
   * Снять отметку. В открытом разделе — приёмщик, с причиной; подписи раздела сбрасываются.
   * В подписанном разделе — только менеджер с комментарием: подписи остаются, отметка видна в истории как снятая.
   */
  app.post<{ Params: Params & { id: string }; Body: { reason: string } }>(
    "/api/staff/acts/:no/:stage/marks/:id/remove", { preHandler: need("acts.read") }, async (req, reply) => {
      const x = load(req, reply, false);
      if (!x) return;
      const { o, a, stage } = x;
      const reason = clip(req.body?.reason, 300);
      if (!reason) return reply.code(400).send({ error: "Напишите причину" });
      const m = db.prepare("SELECT * FROM act_marks WHERE id = ? AND order_id = ? AND removed = 0").get(Number(req.params.id), o.id) as MarkRow | undefined;
      if (!m) return reply.code(404).send({ error: "Отметка не найдена" });
      const manager = !!a.closed_at;
      if (manager && !can(req.staff!.role, "acts.manage")) return reply.code(403).send({ error: "Акт подписан. Снять отметку может менеджер" });
      if (!manager) {
        if (!load(req, reply, true)) return;
        if (!can(req.staff!.role, "acts.edit")) return reply.code(403).send({ error: "Нет доступа" });
      }
      const hist = JSON.parse(m.history) as MarkHistory[];
      hist.push({ act: "remove", at: stamp(), ...who(req.staff!, stage), reason, manager });
      db.prepare("UPDATE act_marks SET removed = 1, history = ? WHERE id = ?").run(JSON.stringify(hist), m.id);
      if (!manager) changed(a);
      audit(req, "act.mark.remove", { no: o.no, stage, id: m.id, reason, manager });
      return view(o, stage);
    });

  // --- Подписи пальцем на экране: сначала «Сдал», потом «Принял» — раздел закрывается ---
  app.post<{ Params: Params; Body: { who: "give" | "take"; img: string; device?: string } }>(
    "/api/staff/acts/:no/:stage/sign", { preHandler: need("acts.edit"), bodyLimit: 1024 * 1024 }, async (req, reply) => {
      const x = load(req, reply, true);
      if (!x) return;
      const { o, a, stage } = x;
      const side = req.body?.who;
      const img = String(req.body?.img ?? "");
      if (side !== "give" && side !== "take") return reply.code(400).send({ error: "Кто подписывает?" });
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > SIG_MAX) return reply.code(400).send({ error: "Подпись не получилась, распишитесь ещё раз" });
      const v = await view(o, stage);
      if (v.blockers.length) return reply.code(409).send({ error: v.blockers.join(". ") });
      if (side === "give") {
        if (a.absent) return reply.code(409).send({ error: "Отмечено, что сдающая сторона не подписывает" });
        if (a.disagree && !a.dis_comment.trim()) return reply.code(400).send({ error: "Напишите, с чем не согласна сдающая сторона" });
      } else if (!a.give_sig && !(a.absent && a.absent_reason.trim())) {
        return reply.code(409).send({ error: "Сначала подпись сдающей стороны" });
      }
      const sig: ActSignature = {
        img, at: stamp(), name: side === "give" ? a.give_name : a.take_name, by: req.staff!.name, device: clip(req.body?.device, 200),
      };
      db.prepare(`UPDATE acts SET ${side === "give" ? "give_sig" : "take_sig"} = ? WHERE order_id = ? AND stage = ?`).run(JSON.stringify(sig), o.id, stage);
      if (side === "take") db.prepare("UPDATE acts SET closed_at = ? WHERE order_id = ? AND stage = ?").run(sig.at, o.id, stage);
      audit(req, side === "give" ? "act.sign.give" : "act.sign.take", { no: o.no, stage });
      return view(o, stage);
    });

  // Разработка без S3: файлы в памяти, их принимает сам сервер
  if (ctx.store && "files" in ctx.store) {
    const mem = ctx.store as unknown as { files: Map<string, { type: string; data: Buffer }> };
    app.addContentTypeParser(/^(image|video)\//, { parseAs: "buffer", bodyLimit: VIDEO_MAX_BYTES }, (_req, body, done) => done(null, body));
    app.put<{ Params: { key: string } }>("/api/staff/dev-media/:key", { preHandler: need("acts.edit") }, async (req) => {
      mem.files.set(req.params.key, { type: String(req.headers["content-type"]), data: req.body as Buffer });
      return { ok: true };
    });
    app.get<{ Params: { key: string } }>("/api/staff/dev-media/:key", { preHandler: need("acts.read") }, async (req, reply) => {
      const f = mem.files.get(req.params.key);
      if (!f) return reply.code(404).send({ error: "Нет файла" });
      return reply.type(f.type).send(f.data);
    });
  }
}
