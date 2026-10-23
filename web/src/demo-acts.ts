// Демо кабинета приёмщика: акты в памяти браузера, фото остаются на телефоне, ИИ отвечает заготовками.
// На сервере то же самое делают server/src/acts.ts, хранилище S3 и Yandex AI Studio.
import {
  PHOTO_SLOTS, ROLES, STAGES, actBlockers, can, isDmgCode, isStage, kmTo, partPos, photoSlotsFor, slotKind, stageLeg, stagePlace, stagesFor, videoSlotsFor,
  type ActCar, type ActMark, type ActMedia, type ActRow, type ActSection, type ActSignature, type ActSuggestion, type ActView,
  type Condition, type DmgCode, type MarkHistory, type StageId, type StaffMe,
} from "@brookclean/shared";

type Res = { status: number; data: unknown };
const ok = (data: unknown): Res => ({ status: 200, data });
const fail = (status: number, error: string): Res => ({ status, data: { error } });

export interface DemoOrder {
  no: number; createdAt: string; status: string; car: string; vin: string; year: string; color: string; city: string; fio: string;
  tripId: string | null; transfer: string | null; trip2Id: string | null; note: string;
}
export interface DemoTripRef { id: string; truck: string; driver: string; km: number; driverId: number | null; trailer?: string; carrier?: string; phone?: string }

interface Sec {
  details: ActCar; cond: Condition[]; condOther: string; notes: string; giveName: string; takeName: string;
  give: ActSignature | null; take: ActSignature | null; disagree: boolean; disComment: string; absent: boolean; absentReason: string;
  closedAt: string | null; media: Map<string, ActMedia & { readyAt?: number }>; suggestions: ActSuggestion[];
}
const acts = new Map<string, Sec>();
const marks = new Map<number, ActMark[]>();
let seq = 100;

/** Находки ИИ-заготовки: что «видит» модель на демо-фото. */
const DEMO_AI: Record<StageId, Record<string, Array<[string, DmgCode, string, ActSuggestion["confidence"]]>>> = {
  priemka: {
    front: [["передний бампер, левая часть", "A1", "царапина около 5 см у противотуманной фары", "medium"]],
    rear_left: [["левая задняя дверь", "B1", "небольшая вмятина без повреждения краски", "low"]],
    windshield: [["лобовое стекло", "S", "скол в правой нижней части", "high"]],
    wheel_fl: [["переднее левое колесо, диск", "A2", "потёртость обода о бордюр", "high"]],
  },
  pogruzka: {},
  term_in: { hood: [["капот, передняя кромка", "S", "новый скол: на фото приёмки во Владивостоке его нет", "high"]] },
  term_out: {},
  vygruzka: { front_right: [["правое переднее крыло", "A2", "царапина с ладонь, на фото погрузки её нет", "medium"]] },
};
const legTrip = (o: DemoOrder, st: StageId) => (stageLeg(st, o.transfer) === 2 ? o.trip2Id : o.tripId);

const placeholders = new Map<string, string>();
/** Демо-фото: рисунок вместо снимка, с подписью ракурса. */
function placeholder(label: string, stage: StageId) {
  const k = label + stage;
  if (!placeholders.has(k)) {
    const c = document.createElement("canvas");
    c.width = 480;
    c.height = 360;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 480, 360);
    grad.addColorStop(0, "#c9d3de");
    grad.addColorStop(1, "#8796a8");
    g.fillStyle = grad;
    g.fillRect(0, 0, 480, 360);
    g.fillStyle = "#2b3a4c";
    g.beginPath();
    g.roundRect(70, 170, 340, 90, 30);
    g.roundRect(140, 115, 190, 80, 30);
    g.fill();
    g.fillStyle = "#1a1a1a";
    for (const x of [140, 340]) { g.beginPath(); g.arc(x, 262, 34, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = "#fff";
    g.font = "600 22px sans-serif";
    g.textAlign = "center";
    g.fillText(label, 240, 50, 440);
    g.font = "15px sans-serif";
    g.fillText(`демо-фото · ${STAGES[stage].name}`, 240, 330);
    placeholders.set(k, c.toDataURL("image/jpeg", 0.8));
  }
  return placeholders.get(k)!;
}

const key = (no: number, st: StageId) => `${no}/${st}`;
const blankCar: ActCar = { plate: "", ptsType: "Оригинал", ptsNo: "", keys: "", docs: "" };

function sec(o: DemoOrder, st: StageId, me: StaffMe | null, trips: DemoTripRef[]): Sec {
  const k = key(o.no, st);
  if (!acts.has(k)) {
    const mine = me && me.role !== "owner" && (!me.site || me.site === STAGES[st].site) ? me.name : "";
    const drv = trips.find((t) => t.id === legTrip(o, st))?.driver ?? "";
    const [giveName, takeName] = ({
      priemka: [o.fio, mine], pogruzka: [acts.get(key(o.no, "priemka"))?.takeName || mine, drv],
      term_in: [drv, mine], term_out: [mine, drv], vygruzka: [drv, o.fio],
    } as Record<StageId, [string, string]>)[st];
    acts.set(k, { details: { ...blankCar }, cond: [], condOther: "", notes: "", giveName, takeName, give: null, take: null, disagree: false, disComment: "",
      absent: false, absentReason: "", closedAt: null, media: new Map(), suggestions: [] });
  }
  return acts.get(k)!;
}

const who = (me: StaffMe, stage: StageId) => ({ stage, who: me.name, role: ROLES[me.role].name + (me.site ? ` · ${me.site}` : "") });
const reset = (s: Sec) => { if (!s.closedAt && (s.give || s.take)) { s.give = null; s.take = null; } };

function finishAi(o: DemoOrder, st: StageId, s: Sec) {
  for (const m of s.media.values()) {
    if (m.ai?.status !== "checking" || (m.readyAt ?? 0) > Date.now()) continue;
    m.ai = { status: "done", quality: "ok", model: "демо" };
    for (const [part, code, desc, confidence] of DEMO_AI[st][m.slot] ?? []) {
      const [x, y] = partPos(part, m.slot);
      s.suggestions.push({ id: ++seq, slot: m.slot, part, code, desc, confidence, state: "pending", x, y, by: null, at: null, markId: null });
    }
    if (DEMO_AI[st][m.slot]?.length) reset(s);
  }
  void o;
}

function view(o: DemoOrder, st: StageId, me: StaffMe | null, trips: DemoTripRef[]): ActView {
  const s = sec(o, st, me, trips);
  finishAi(o, st, s);
  const order = stagesFor(o.transfer);
  const upto = new Set(order.slice(0, order.indexOf(st) + 1));
  const sections = order.map((x): ActSection => {
    const a = acts.get(key(o.no, x));
    return { stage: x, giveName: a?.giveName ?? "", takeName: a?.takeName ?? "", give: a?.give ?? null, take: a?.take ?? null, closedAt: a?.closedAt ?? null };
  });
  const role = (side: "give" | "take") => {
    const base: string = STAGES[st][side];
    const t = base === "Водитель рейса" ? legTrip(o, st) : null;
    return t ? `${base} ${t}` : base;
  };
  const trip = trips.find((t) => t.id === legTrip(o, st));
  const v: ActView = {
    no: o.no, stage: st, sections, transfer: o.transfer, orderStatus: o.status, contractDate: o.createdAt.slice(0, 10),
    car: { car: o.car, vin: o.vin, year: o.year, color: o.color, city: o.city }, note: o.note, client: o.fio, acceptor: s.takeName,
    details: acts.get(key(o.no, "priemka"))?.details ?? blankCar, cond: s.cond, condOther: s.condOther, notes: s.notes,
    giveName: s.giveName, takeName: s.takeName, giveRole: role("give"), takeRole: role("take"), give: s.give, take: s.take,
    disagree: s.disagree, disComment: s.disComment, absent: s.absent, absentReason: s.absentReason, closedAt: s.closedAt,
    media: [...s.media.values()].map(({ readyAt: _r, ...m }) => m),
    marks: (marks.get(o.no) ?? []).filter((m) => upto.has(m.stage)).map((m) => ({ ...m, history: m.history.filter((h) => upto.has(h.stage)) })),
    suggestions: s.suggestions, blockers: [], storage: true, ai: true,
    place: stagePlace(st, o.city), canEdit: !!me && !editWhy(o, st, me, trips),
  };
  const prev = order[order.indexOf(st) - 1];
  v.blockers = [
    ...(o.status === "draft" ? ["Клиент ещё не подписал договор перевозки"] : []),
    ...(st !== "priemka" && !trip ? ["Рейс для этой передачи ещё не назначен. Его назначает менеджер"] : []),
    ...(prev && !acts.get(key(o.no, prev))?.closedAt ? [`Сначала закройте раздел «${STAGES[prev].name}»`] : []),
    ...(st === "vygruzka" && trip && trip.km < kmTo(o.city) ? [`Автовоз ещё не в городе ${o.city}. Отметьтесь в рейсе по прибытии`] : []),
    ...actBlockers(v),
  ];
  return v;
}

const driverOf = (o: DemoOrder, st: StageId, me: StaffMe, trips: DemoTripRef[]) =>
  can(me.role, "acts.driver") && trips.find((t) => t.id === legTrip(o, st))?.driverId === me.id;

/** Как на сервере: раздел открыт, оформляет своя площадка или водитель рейса, рейс назначен, прошлая передача закрыта. */
function editWhy(o: DemoOrder, st: StageId, me: StaffMe, trips: DemoTripRef[]) {
  const order = stagesFor(o.transfer);
  const prev = order[order.indexOf(st) - 1];
  const s = acts.get(key(o.no, st));
  const mine = (STAGES[st].by === "driver" && driverOf(o, st, me, trips)) || (can(me.role, "acts.edit") && (!me.site || me.site === STAGES[st].site));
  return s?.closedAt ? "Раздел акта закрыт и подписан. Изменить отметку может только менеджер"
    : !mine ? (STAGES[st].by === "driver" ? "Эту передачу оформляет водитель рейса на своём телефоне" : `Эту передачу оформляет площадка ${STAGES[st].site}`)
    : st !== "priemka" && !legTrip(o, st) ? "Рейс для этой передачи ещё не назначен. Его назначает менеджер"
    : prev && !acts.get(key(o.no, prev))?.closedAt ? `Сначала закройте раздел «${STAGES[prev].name}»` : "";
}

function addMedia(s: Sec, st: StageId, slot: string, me: StaffMe, url: string, durationSec: number | null, aiDelay: number) {
  const kind = slotKind(slot)!;
  const ai = kind === "photo" && PHOTO_SLOTS.find((p) => p.id === slot)!.ai;
  s.media.set(slot, {
    slot, kind, url, size: kind === "photo" ? 380_000 : 42_000_000, at: new Date().toISOString(), by: me.name, durationSec,
    ai: ai ? { status: "checking", quality: null, model: null } : null, readyAt: Date.now() + aiDelay,
  });
  s.suggestions = s.suggestions.filter((x) => x.slot !== slot || x.state === "yes");
  void st;
}

/** Готовые этапы для показа: машина на терминале и машина, которую уже приняли. */
export function seedActs(orders: DemoOrder[], trips: DemoTripRef[]) {
  const sig = (name: string): ActSignature => ({ img: demoSig(name), at: "2026-10-20T03:30:00Z", name, by: "Ольга", device: "демо" });
  const full = (o: DemoOrder, st: StageId, giver: string, taker: string, at: string) => {
    const s = sec(o, st, null, trips);
    s.giveName = giver; s.takeName = taker;
    for (const p of photoSlotsFor(st)) s.media.set(p.id, { slot: p.id, kind: "photo", url: "", size: 380_000, at, by: taker, durationSec: null, ai: p.ai ? { status: "done", quality: "ok", model: "демо" } : null });
    for (const v of videoSlotsFor(st)) s.media.set(v.id, { slot: v.id, kind: "video", url: "", size: 40_000_000, at, by: taker, durationSec: 52, ai: null });
    s.details = { plate: "без номера", ptsType: "Выписка ЭПТС", ptsNo: "164302044817201", keys: "2", docs: "" };
    s.give = { ...sig(giver), at }; s.take = { ...sig(taker), at }; s.closedAt = at;
  };
  const drv = (id: string | null) => trips.find((t) => t.id === id)?.driver ?? "";
  // Машины рейса R-01 приняты и погружены; №680 принят и ждёт погрузки на R-03
  for (const o of orders.filter((x) => x.tripId === "R-01" || x.tripId === "R-03")) {
    full(o, "priemka", o.fio, "Ольга", "2026-10-19T02:10:00Z");
    if (o.tripId === "R-01") full(o, "pogruzka", "Ольга", drv(o.tripId), "2026-10-20T19:40:00Z");
  }
  for (const o of orders.filter((x) => x.transfer)) {
    marks.set(o.no, [{ id: ++seq, stage: "priemka", code: "S", part: "капот", x: 0.33, y: 0.5, src: "ai", removed: false,
      history: [{ act: "add", stage: "priemka", at: "2026-10-19T02:00:00Z", who: "Ольга", role: "Приёмщик · Владивосток", src: "ai", code: "S", slot: "hood" }] }]);
  }
  const yard = orders.find((x) => x.transfer && x.no === 682);
  if (yard) full(yard, "term_in", "Сергей", "Андрей", "2026-10-22T09:40:00Z");
}

/** Подпись-пример для демо: волнистая линия по имени. */
export function demoSig(name: string) {
  if (typeof document === "undefined") return "";
  const c = document.createElement("canvas");
  c.width = 600; c.height = 200;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#1d3fa0"; g.lineWidth = 3; g.lineCap = "round";
  let x = 40, seed = [...(name || "x")].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  g.beginPath(); g.moveTo(x, 120);
  for (let i = 0; i < 14; i++) { seed = (seed * 9301 + 49297) % 233280; x += 28 + (seed % 14); g.quadraticCurveTo(x - 14, 40 + (seed % 110), x, 95 + (seed % 50)); }
  g.stroke();
  return c.toDataURL("image/png");
}

export function demoActsFetch(path: string, method: string, body: any, me: StaffMe | null, orders: DemoOrder[], trips: DemoTripRef[]): Res {
  const onSite = (st: StageId) => !me!.site || me!.site === STAGES[st].site;

  if (path === "/api/staff/acts") {
    if (!me) return fail(401, "Войдите в панель");
    if (!can(me.role, "acts.read") && !can(me.role, "acts.driver")) return fail(403, "Нет доступа к этому разделу");
    const closed = (o: DemoOrder, st: StageId) => !!acts.get(key(o.no, st))?.closedAt;
    const out: ActRow[] = [];
    for (const o of [...orders].sort((a, b) => b.no - a.no)) {
      const row = (st: StageId, group: ActRow["group"]): ActRow => {
        const s = acts.get(key(o.no, st));
        const t = trips.find((x) => x.id === legTrip(o, st)), t2 = trips.find((x) => x.id === o.trip2Id);
        const end = stageLeg(st, o.transfer) === 1 ? o.transfer ?? o.city : o.city;
        const count = (k: string) => (s ? [...s.media.values()].filter((m) => m.kind === k).length : 0);
        return {
          no: o.no, stage: st, group, transfer: o.transfer, car: o.car, vin: o.vin, year: o.year, color: o.color, city: o.city, client: o.fio,
          orderStatus: o.status, createdAt: o.createdAt,
          trip: t ? { id: t.id, truck: t.truck, driver: t.driver, kmLeft: Math.max(0, kmTo(end) - t.km), phone: t.phone ?? "", trailer: t.trailer ?? "", carrier: t.carrier ?? "" } : null,
          trip2: t2 ? { id: t2.id, truck: t2.truck, driver: t2.driver } : null,
          photos: count("photo"), videos: count("video"), pending: s?.suggestions.filter((x) => x.state === "pending").length ?? 0,
          closedAt: s?.closedAt ?? null, signed: !!(s?.give || s?.take), note: o.note,
        };
      };
      const last = stagesFor(o.transfer).at(-1)!;
      if (can(me.role, "acts.read")) {
        if (onSite("priemka")) out.push(!closed(o, "priemka") ? row("priemka", "todo") : row("pogruzka", closed(o, "pogruzka") ? "done" : "load"));
        if (o.transfer && onSite("term_in") && closed(o, "pogruzka")) {
          if (!closed(o, "term_in")) out.push(row("term_in", "incoming"));
          else out.push(row("term_out", closed(o, "term_out") ? "done" : "yard"));
        }
        if (!me.site && closed(o, stagesFor(o.transfer).at(-2)!)) out.push(row(last, closed(o, last) ? "done" : "deliver"));
      } else {
        if (driverOf(o, "pogruzka", me, trips) && !closed(o, "pogruzka")) out.push(row("pogruzka", "load"));
        if (driverOf(o, last, me, trips)) out.push(row(last, closed(o, last) ? "done" : "deliver"));
      }
    }
    return ok(out.sort((a, b) => Number(!!a.closedAt) - Number(!!b.closedAt)));
  }

  const m = /^\/api\/staff\/acts\/(\d+)\/(\w+)(?:\/(.*))?$/.exec(path);
  if (!m) return fail(404, "Не найдено");
  if (!me) return fail(401, "Войдите в панель");
  const o = orders.find((x) => x.no === Number(m[1]));
  const st = m[2];
  if (!o || !isStage(st) || !stagesFor(o.transfer).includes(st)) return fail(404, "Нет такой передачи");
  if (!can(me.role, "acts.read") && !stagesFor(o.transfer).some((x) => driverOf(o, x, me!, trips))) return fail(403, "Эта машина не на вашем рейсе");
  const rest = m[3] ?? "";
  const s = sec(o, st, can(me!.role, "acts.edit") ? me : null, trips);
  const v = () => ok(view(o, st, me, trips));
  if (method === "GET" && !rest) return v();

  // Изменения: как на сервере — своя площадка, раздел открыт, прошлая передача закрыта
  const isManagerRemove = /^marks\/\d+\/remove$/.test(rest) && s.closedAt;
  if (!isManagerRemove) {
    const why = editWhy(o, st, me, trips);
    if (why) return fail(409, why);
  }
  const list = marks.get(o.no) ?? [];
  marks.set(o.no, list);

  if (!rest && method === "PATCH") {
    const b = body ?? {};
    if (b.details) Object.assign(acts.get(key(o.no, "priemka"))!.details, b.details);
    for (const k of ["cond", "condOther", "notes", "giveName", "takeName", "disagree", "disComment", "absent", "absentReason"] as const)
      if (k in b) (s as any)[k] = b[k];
    if (["details", "cond", "condOther", "notes", "giveName", "takeName"].some((k) => k in b)) reset(s);
    return v();
  }
  if (rest === "upload") return ok({ key: `acts/${o.no}/${st}/${body.slot}-demo`, url: "demo:" });
  if (rest === "media") {
    addMedia(s, st, body.slot, me!, body.preview ?? "", body.durationSec ?? null, 1800);
    reset(s);
    return v();
  }
  if (rest === "demo-fill") {
    for (const p of photoSlotsFor(st)) if (!s.media.has(p.id)) addMedia(s, st, p.id, me!, placeholder(p.label, st), null, 1500 + Math.random() * 2500);
    for (const x of videoSlotsFor(st)) if (!s.media.has(x.id)) addMedia(s, st, x.id, me!, "", 48 + Math.round(Math.random() * 10), 0);
    if (st === "priemka") Object.assign(acts.get(key(o.no, "priemka"))!.details, { keys: "2", plate: "без номера", ptsType: "Выписка ЭПТС" });
    reset(s);
    return v();
  }
  let x: RegExpExecArray | null;
  if ((x = /^media\/(\w+)$/.exec(rest)) && method === "DELETE") {
    s.media.delete(x[1]);
    s.suggestions = s.suggestions.filter((y) => y.slot !== x![1] || y.state === "yes");
    reset(s);
    return v();
  }
  if ((x = /^ai\/(\w+)$/.exec(rest))) {
    const md = s.media.get(x[1]);
    if (md) { md.ai = { status: "checking", quality: null, model: null }; md.readyAt = Date.now() + 1500; }
    return v();
  }
  if ((x = /^suggestions\/(\d+)$/.exec(rest))) {
    const sg = s.suggestions.find((y) => y.id === Number(x![1]));
    if (!sg) return fail(404, "Находка не найдена");
    const code = body.code ?? sg.code;
    if (!isDmgCode(code)) return fail(400, "Неизвестный код");
    if (sg.markId) marks.set(o.no, list.filter((mk) => mk.id !== sg.markId));
    sg.markId = null;
    if (body.state === "yes") {
      const h: MarkHistory = { act: "add", at: new Date().toISOString(), ...who(me!, st), src: "ai", code, slot: sg.slot };
      const mk: ActMark = { id: ++seq, stage: st, code, part: sg.part, x: sg.x, y: sg.y, src: "ai", removed: false, history: [h] };
      marks.get(o.no)!.push(mk);
      sg.markId = mk.id;
    }
    Object.assign(sg, { state: body.state, code, by: body.state === "pending" ? null : me!.name, at: body.state === "pending" ? null : new Date().toISOString() });
    reset(s);
    return v();
  }
  if (rest === "marks") {
    if (!isDmgCode(body.code)) return fail(400, "Выберите код дефекта");
    list.push({ id: ++seq, stage: st, code: body.code, part: body.part ?? "", x: body.x, y: body.y, src: "manual", removed: false,
      history: [{ act: "add", at: new Date().toISOString(), ...who(me!, st), src: "manual", code: body.code }] });
    reset(s);
    return v();
  }
  if ((x = /^marks\/(\d+)$/.exec(rest))) {
    const mk = list.find((y) => y.id === Number(x![1]));
    if (!mk) return fail(404, "Отметка не найдена");
    if (body.code && body.code !== mk.code) { mk.history.push({ act: "refine", at: new Date().toISOString(), ...who(me!, st), from: mk.code, to: body.code }); mk.code = body.code; }
    reset(s);
    return v();
  }
  if ((x = /^marks\/(\d+)\/remove$/.exec(rest))) {
    const mk = list.find((y) => y.id === Number(x![1]));
    if (!mk) return fail(404, "Отметка не найдена");
    if (!String(body.reason ?? "").trim()) return fail(400, "Напишите причину");
    const manager = !!s.closedAt;
    if (manager && !can(me!.role, "acts.manage")) return fail(403, "Акт подписан. Снять отметку может менеджер");
    mk.removed = true;
    mk.history.push({ act: "remove", at: new Date().toISOString(), ...who(me!, st), reason: body.reason, manager });
    if (!manager) reset(s);
    return v();
  }
  if (rest === "sign") {
    const cur = view(o, st, me, trips);
    if (cur.blockers.length) return fail(409, cur.blockers.join(". "));
    if (body.who === "take" && !s.give && !(s.absent && s.absentReason)) return fail(409, "Сначала подпись сдающей стороны");
    const sig: ActSignature = { img: body.img, at: new Date().toISOString(), name: body.who === "give" ? s.giveName : s.takeName, by: me!.name, device: "демо" };
    if (body.who === "give") s.give = sig;
    else {
      s.take = sig; s.closedAt = sig.at;
      if (st === "vygruzka") o.status = "delivered";
    }
    return v();
  }
  return fail(404, "В демо это не работает");
}

/** Раздел акта закрыт (для распределения и таблицы доставок в демо). */
export const demoActClosedAt = (no: number, st: StageId) => acts.get(key(no, st))?.closedAt ?? null;
