// Передачи машины по цепочке и правила, кто что делает на каждой. Перенесено из прототипа.
import { kmOf, ORIGIN_CITY } from "./route.js";

export type Stage = "priemka" | "pogruzka" | "term_in" | "term_out" | "vygruzka";
export const STAGE_IDS: Stage[] = ["priemka", "pogruzka", "term_in", "term_out", "vygruzka"];

export const STAGES: Record<Stage, { name: string; folder: string; title: string }> = {
  priemka: { name: "Приёмка", folder: "Приемка", title: "Приёмка к перевозке" },
  pogruzka: { name: "Погрузка в автовоз", folder: "Погрузка", title: "Передача водителю для погрузки" },
  term_in: { name: "Приём на терминал", folder: "Терминал-прием", title: "Приём на терминал от водителя" },
  term_out: { name: "Погрузка с терминала", folder: "Терминал-отгрузка", title: "Погрузка с терминала на рейс 2" },
  vygruzka: { name: "Выгрузка", folder: "Выгрузка", title: "Сдача получателю" },
};

export interface TripInfo {
  id: string; code: string; status: "forming" | "formed"; origin: string; loadCity: string; dest: string;
  currentCity: string | null; driverId: string | null; driverUserId: string | null; driverName: string | null;
}
export interface LegInfo { idx: 0 | 1; from: string; to: string; trip: TripInfo | null }
export interface OrderCtx { no: number; city: string; clientFio: string; transferCity: string | null; legs: LegInfo[] }
export interface UserCtx { id: string; role: "manager" | "driver" | "partner" | "terminal"; name: string; terminalCity: string | null }

// сторона передачи: приёмщик площадки или терминала, водитель плеча, клиент
export type Side = { kind: "terminal"; city: string } | { kind: "driver"; leg: 0 | 1 } | { kind: "client" };

export const loadCityOf = (o: OrderCtx) => o.legs[0]?.trip?.loadCity ?? ORIGIN_CITY;
const lastLeg = (o: OrderCtx) => (o.legs.length - 1) as 0 | 1;
// во Владивостоке машину принимает приёмщик площадки, в другом городе погрузки — водитель
const inspAtLoad = (o: OrderCtx) => loadCityOf(o) === ORIGIN_CITY;

export function checkpointsOf(o: OrderCtx): { id: Stage; leg: 0 | 1 }[] {
  const head: { id: Stage; leg: 0 | 1 }[] = [{ id: "priemka", leg: 0 }];
  if (inspAtLoad(o)) head.push({ id: "pogruzka", leg: 0 });
  return o.legs.length > 1
    ? [...head, { id: "term_in", leg: 0 }, { id: "term_out", leg: 1 }, { id: "vygruzka", leg: 1 }]
    : [...head, { id: "vygruzka", leg: 0 }];
}

export function sidesOf(o: OrderCtx, st: Stage): { give: Side; take: Side } {
  const t = o.transferCity ?? "";
  switch (st) {
    case "priemka": return { give: { kind: "client" }, take: inspAtLoad(o) ? { kind: "terminal", city: loadCityOf(o) } : { kind: "driver", leg: 0 } };
    case "pogruzka": return { give: { kind: "terminal", city: loadCityOf(o) }, take: { kind: "driver", leg: 0 } };
    case "term_in": return { give: { kind: "driver", leg: 0 }, take: { kind: "terminal", city: t } };
    case "term_out": return { give: { kind: "terminal", city: t }, take: { kind: "driver", leg: 1 } };
    case "vygruzka": return { give: { kind: "driver", leg: lastLeg(o) }, take: { kind: "client" } };
  }
}

// кто осматривает машину: принимающая сторона, а если принимает клиент — водитель
export function inspectorSide(o: OrderCtx, st: Stage): Side {
  const s = sidesOf(o, st);
  return s.take.kind === "client" ? s.give : s.take;
}

export function isSide(u: UserCtx, o: OrderCtx, side: Side): boolean {
  if (side.kind === "terminal") return u.role === "terminal" && u.terminalCity === side.city;
  if (side.kind === "driver") return u.role === "driver" && !!o.legs[side.leg]?.trip && o.legs[side.leg].trip!.driverUserId === u.id;
  return false;
}
export const isParticipant = (u: UserCtx, o: OrderCtx, st: Stage) => {
  const s = sidesOf(o, st);
  return isSide(u, o, s.give) || isSide(u, o, s.take);
};

// при погрузке с терминала у каждого своё: приёмщик — 2 фото на автовозе и «Сдал»,
// водитель — приёмка (фото, видео, дефекты) и «Принял»: в своём кабинете или на экране приёмщика
export function termOutSide(u: UserCtx, o: OrderCtx, side: "terminal" | "driver", driverMode: boolean): boolean {
  const s = sidesOf(o, "term_out");
  if (side === "driver") return isSide(u, o, s.take) || (isSide(u, o, s.give) && driverMode);
  return isSide(u, o, s.give) && !driverMode;
}

export function canShoot(u: UserCtx, o: OrderCtx, st: Stage, by: "terminal" | "driver" | undefined, driverMode: boolean) {
  if (st === "term_out") return termOutSide(u, o, by ?? "driver", driverMode);
  return isSide(u, o, inspectorSide(o, st));
}
export function canEditMarks(u: UserCtx, o: OrderCtx, st: Stage, driverMode: boolean) {
  if (st === "term_out") return termOutSide(u, o, "driver", driverMode);
  return isSide(u, o, inspectorSide(o, st));
}
// подписи на экране: обе стороны расписываются на устройстве участника; при отгрузке с терминала — каждая у себя
export function canSign(u: UserCtx, o: OrderCtx, st: Stage, k: "give" | "take", driverMode: boolean) {
  if (st === "term_out") return termOutSide(u, o, k === "give" ? "terminal" : "driver", driverMode);
  return isParticipant(u, o, st);
}

/* --- что снимать --- */
export const HO_PHOTOS: [string, string][] = [
  ["Перед, левый угол 45°", "С 2–3 м, машина целиком: фара, бампер, левое крыло"],
  ["Перед, правый угол 45°", "Фара, бампер, правое крыло"],
  ["Зад, левый угол 45°", "Фонарь, бампер, левое заднее крыло"],
  ["Зад, правый угол 45°", "Фонарь, бампер, правое заднее крыло"],
  ["Левый борт целиком", "Сбоку, все двери и колёса в кадре"],
  ["Правый борт целиком", "Сбоку, все двери и колёса в кадре"],
  ["Крыша и лобовое стекло", "Сверху, с площадки автовоза: сколы, трещины"],
  ["Приборная панель", "Зажигание включено: пробег и ошибки видны"],
  ["VIN / номер кузова", "Табличка или номер на кузове, цифры читаются"],
  ["Салон", "Торпедо и передние сиденья с открытой двери"],
];
export interface Shot { slot: number; title: string; hint: string; by?: "terminal" | "driver" }

export function photoSpec(st: Stage): Shot[] {
  if (st === "term_out") return [
    { slot: 0, title: "Авто на автовозе · общий вид", hint: "Машина на своём месте в автовозе, видна целиком", by: "terminal" },
    { slot: 1, title: "Крепление на автовозе", hint: "Колёса закреплены: видны ремни и упоры", by: "terminal" },
    ...HO_PHOTOS.map(([title, hint], k) => ({ slot: 10 + k, title, hint, by: "driver" as const })),
  ];
  const idx = st === "pogruzka" ? [0, 1, 2, 3] : HO_PHOTOS.map((_, i) => i);
  return idx.map((i) => ({ slot: i, title: HO_PHOTOS[i][0], hint: HO_PHOTOS[i][1] }));
}
// ракурс фото (0–9); у снимков приёмщика на автовозе ракурса нет
export const angleOf = (st: Stage, slot: number) => (st === "term_out" ? (slot >= 10 ? slot - 10 : null) : slot);
export const angleSlot = (st: Stage, angle: number) => (st === "term_out" ? angle + 10 : angle);

export function hoVideos(st: Stage): [string, string, boolean][] {
  return [
    ["Круговой обход снаружи", "Медленно по часовой стрелке, 1–2 минуты", true],
    ["Кузов вблизи", "По кругу с 50 см: сколы, царапины, вмятины", true],
    ["Запуск двигателя", "Приборная панель, звук мотора, ошибки", true],
    ["Салон и багажник", "Комплектность: ключи, запаска, коврики, домкрат", true],
    st === "priemka" || st === "term_out" ? ["Погрузка на автовоз", "Заезд на площадку и крепление колёс", true] : ["Выгрузка с автовоза", "Съезд с площадки до полной остановки", true],
    ["Днище и колёсные арки", "Если есть повреждения или подтёки", false],
    st === "vygruzka" ? ["Передача ключей и документов", "Получатель берёт ключи и документы", false] : ["Приём ключей и документов", "Сколько ключей и какие документы переданы", false],
  ];
}
export interface StageMode { light: boolean; why: string }
// объём съёмки на погрузке с терминала: облегчённая (2 видео) или полная
export function stageMode(st: Stage, rule: string, yardHours: number): StageMode {
  if (st !== "term_out") return { light: false, why: "" };
  if (rule === "light") return { light: true, why: "облегчённая погрузка всегда" };
  if (rule === "full") return { light: false, why: "полная съёмка всегда" };
  return yardHours < 24 ? { light: true, why: "стоянка на терминале меньше суток" } : { light: false, why: "стоянка на терминале больше суток" };
}
export function vidSpec(st: Stage, mode: StageMode): { slot: number; title: string; required: boolean }[] {
  if (st === "pogruzka") return [];
  const v = hoVideos(st);
  return mode.light ? [0, 4].map((i) => ({ slot: i, title: v[i][0], required: true })) : v.map((x, i) => ({ slot: i, title: x[0], required: x[2] }));
}

/* --- можно ли завершать этап --- */
export function cpGate(o: OrderCtx, st: Stage, done: Set<Stage>): { ok: true } | { ok: false; why: string } {
  const cps = checkpointsOf(o), i = cps.findIndex((c) => c.id === st);
  if (i < 0) return { ok: false, why: "Этого этапа нет в маршруте машины." };
  const prev = cps[i - 1];
  if (prev && !done.has(prev.id)) return { ok: false, why: `Сначала нужен этап «${STAGES[prev.id].name}».` };
  const t = o.legs[cps[i].leg]?.trip ?? null;
  if (!t) return st === "priemka" ? { ok: true } : { ok: false, why: "Рейс для этого плеча ещё не назначен." };
  if (st === "term_in" && kmOf(t.currentCity) < kmOf(o.transferCity)) return { ok: false, why: `Автовоз ${t.code} ещё не на терминале ${o.transferCity}.` };
  if (st === "term_out" && t.status !== "formed") return { ok: false, why: `Рейс ${t.code} ещё не сформирован.` };
  if (st === "vygruzka" && kmOf(t.currentCity) < kmOf(o.city)) return { ok: false, why: `Автовоз ещё не в городе ${o.city}.` };
  return { ok: true };
}

/* --- стороны в акте --- */
export function partyLabel(o: OrderCtx, st: Stage, side: Side, inspName: (city: string) => string): [role: string, name: string] {
  if (side.kind === "client") return [st === "vygruzka" ? "Грузополучатель" : "Заказчик", o.clientFio];
  if (side.kind === "terminal") return [`Приёмщик ${side.city === ORIGIN_CITY ? "площадки" : "терминала"} ${side.city}`, inspName(side.city)];
  const t = o.legs[side.leg]?.trip;
  return [t ? `Водитель рейса ${t.code}` : "Водитель", t?.driverName ?? "водитель не назначен"];
}

/* --- акт: коды повреждений и условия осмотра --- */
export const DMG_CODES: [string, string][] = [
  ["A1", "Мелкая царапина"], ["A2", "Средняя царапина (с ладонь)"], ["A3", "Большая/глубокая царапина"],
  ["B1", "Мелкая вмятина"], ["B2", "Средняя вмятина (с ладонь)"], ["B3", "Большая/глубокая вмятина"],
  ["S", "Скол"], ["SS", "Множественные сколы"], ["W1", "Небольшой кузовной ремонт в хорошем состоянии"],
  ["W2", "Элемент с кузовным ремонтом (заметно на расстоянии)"], ["W3", "Требуется ремонт"], ["X", "Требуется замена детали"],
];
export const COND_KEYS = ["rain", "snow", "dark", "other"] as const;
