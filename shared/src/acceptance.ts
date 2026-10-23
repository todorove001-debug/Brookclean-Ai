// Приёмка автомобиля: 35 фото по ячейкам, 6 видео, акт приёма-передачи по шаблону, дефекты и подписи на экране.
// Правила общие для сервера и панели, чтобы кнопка «Подписать» и проверка на сервере не расходились.

/** Коды оценки состояния кузова — как в бумажном акте. */
export const DMG_CODES = {
  A1: "Мелкая царапина",
  A2: "Средняя царапина (с ладонь)",
  A3: "Большая/глубокая царапина",
  B1: "Мелкая вмятина",
  B2: "Средняя вмятина (с ладонь)",
  B3: "Большая/глубокая вмятина",
  S: "Скол",
  SS: "Множественные сколы",
  W1: "Небольшой кузовной ремонт в хорошем состоянии",
  W2: "Элемент с кузовным ремонтом (заметно на расстоянии)",
  W3: "Требуется ремонт",
  X: "Требуется замена детали",
} as const;
export type DmgCode = keyof typeof DMG_CODES;
export const isDmgCode = (c: unknown): c is DmgCode => typeof c === "string" && c in DMG_CODES;

/** Площадки приёмщиков: приёмка во Владивостоке и терминал перегруза в Новосибирске. */
export const SITES = ["Владивосток", "Новосибирск"] as const;
export type Site = (typeof SITES)[number];
export const TRANSFER_CITY = "Новосибирск";
export const isSite = (s: unknown): s is Site => SITES.includes(s as Site);

/**
 * Передачи машины, которые оформляет приёмщик. Каждая — свой раздел сквозного акта: свои фото, видео и подписи.
 * Дефекты общие на всю цепочку: отметка с прошлой передачи уже стоит на схеме своим цветом.
 */
export const STAGES = {
  priemka: { name: "Приёмка", title: "Приёмка к перевозке", site: "Владивосток", give: "Заказчик", take: "Приёмщик площадки Владивосток", color: "#2563eb" },
  term_in: { name: "Приём на терминал", title: "Приём на терминал от водителя", site: "Новосибирск", give: "Водитель рейса", take: "Приёмщик терминала Новосибирск", color: "#d97706" },
  term_out: { name: "Погрузка с терминала", title: "Погрузка с терминала на следующий рейс", site: "Новосибирск", give: "Приёмщик терминала Новосибирск", take: "Водитель рейса", color: "#7c3aed" },
} as const satisfies Record<string, { name: string; title: string; site: Site; give: string; take: string; color: string }>;
export type StageId = keyof typeof STAGES;
export const isStage = (s: unknown): s is StageId => typeof s === "string" && s in STAGES;
/** Передачи машины по порядку: без перегруза — только приёмка. */
export const stagesFor = (transfer: string | null): StageId[] => (transfer ? ["priemka", "term_in", "term_out"] : ["priemka"]);

/** Можно ли везти машину с перегрузом: город получателя за терминалом на том же маршруте. */
export function canTransfer(city: string, route: (c: string) => string[]) {
  return city !== TRANSFER_CITY && route(city).includes(TRANSFER_CITY);
}

export const CONDITIONS = { rain: "Дождь", snow: "Снег", dark: "Тёмное время суток", other: "Иное" } as const;
export type Condition = keyof typeof CONDITIONS;

export const PTS_TYPES = ["Оригинал", "Выписка ЭПТС", "Заверенная копия"] as const;

export const PHOTO_GROUPS = {
  body: "Кузов",
  wheels: "Диски",
  doors: "Дверные проёмы",
  interior: "Салон",
  other: "Багажник, мотор, VIN",
} as const;
export type PhotoGroup = keyof typeof PHOTO_GROUPS;

/** Ячейки фото: подпись — что именно снять. ai — фото проверяет ИИ на повреждения (снаружи машины). */
export const PHOTO_SLOTS: ReadonlyArray<{ id: string; group: PhotoGroup; label: string; ai: boolean }> = [
  { id: "front", group: "body", label: "Спереди", ai: true },
  { id: "front_left", group: "body", label: "Спереди слева, 45°", ai: true },
  { id: "left", group: "body", label: "Левый бок", ai: true },
  { id: "rear_left", group: "body", label: "Сзади слева, 45°", ai: true },
  { id: "rear", group: "body", label: "Сзади", ai: true },
  { id: "rear_right", group: "body", label: "Сзади справа, 45°", ai: true },
  { id: "right", group: "body", label: "Правый бок", ai: true },
  { id: "front_right", group: "body", label: "Спереди справа, 45°", ai: true },
  { id: "roof", group: "body", label: "Крыша", ai: true },
  { id: "hood", group: "body", label: "Капот", ai: true },
  { id: "windshield", group: "body", label: "Лобовое стекло", ai: true },
  { id: "rear_glass", group: "body", label: "Заднее стекло", ai: true },
  { id: "bumper_front_low", group: "body", label: "Передний бампер снизу", ai: true },
  { id: "bumper_rear_low", group: "body", label: "Задний бампер снизу", ai: true },
  { id: "sill_left", group: "body", label: "Левые пороги", ai: true },
  { id: "sill_right", group: "body", label: "Правые пороги", ai: true },
  { id: "wheel_fl", group: "wheels", label: "Переднее левое колесо", ai: true },
  { id: "wheel_rl", group: "wheels", label: "Заднее левое колесо", ai: true },
  { id: "wheel_rr", group: "wheels", label: "Заднее правое колесо", ai: true },
  { id: "wheel_fr", group: "wheels", label: "Переднее правое колесо", ai: true },
  { id: "door_fl", group: "doors", label: "Проём передней левой двери", ai: true },
  { id: "door_rl", group: "doors", label: "Проём задней левой двери", ai: true },
  { id: "door_rr", group: "doors", label: "Проём задней правой двери", ai: true },
  { id: "door_fr", group: "doors", label: "Проём передней правой двери", ai: true },
  { id: "odometer", group: "interior", label: "Приборная панель с пробегом (зажигание включено)", ai: false },
  { id: "dashboard", group: "interior", label: "Торпедо целиком", ai: false },
  { id: "console", group: "interior", label: "Центральная консоль, мультимедиа", ai: false },
  { id: "seat_driver", group: "interior", label: "Сиденье водителя", ai: false },
  { id: "seat_passenger", group: "interior", label: "Переднее пассажирское сиденье", ai: false },
  { id: "seats_rear", group: "interior", label: "Задний ряд", ai: false },
  { id: "ceiling", group: "interior", label: "Потолок", ai: false },
  { id: "trunk", group: "other", label: "Багажник открыт", ai: false },
  { id: "engine", group: "other", label: "Моторный отсек", ai: false },
  { id: "vin_plate", group: "other", label: "VIN на кузове или табличке", ai: false },
  { id: "keys_docs", group: "other", label: "Ключи и документы", ai: false },
];

/** Видео — до минуты каждое: кузов, дверные проёмы, салон, диски. */
export const VIDEO_SLOTS: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: "v_body_1", label: "Кузов: перед и левый бок", hint: "Медленно от переднего бампера вдоль левой стороны" },
  { id: "v_body_2", label: "Кузов: зад и правый бок", hint: "От заднего бампера вдоль правой стороны до капота" },
  { id: "v_doors", label: "Дверные проёмы", hint: "Все двери по очереди: проём, порог, уплотнители" },
  { id: "v_interior", label: "Салон", hint: "Торпедо, сиденья, потолок, пробег на приборной панели" },
  { id: "v_wheels_left", label: "Диски левой стороны", hint: "Каждый диск близко, по кругу обода" },
  { id: "v_wheels_right", label: "Диски правой стороны", hint: "Каждый диск близко, по кругу обода" },
];

export const VIDEO_MAX_SECONDS = 60;
export const VIDEO_MAX_BYTES = 300 * 1024 * 1024;
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;

export const slotKind = (slot: string): "photo" | "video" | null =>
  PHOTO_SLOTS.some((s) => s.id === slot) ? "photo" : VIDEO_SLOTS.some((s) => s.id === slot) ? "video" : null;
export const slotLabel = (slot: string) => PHOTO_SLOTS.find((s) => s.id === slot)?.label ?? VIDEO_SLOTS.find((s) => s.id === slot)?.label ?? slot;

export interface ActCar { plate: string; ptsType: string; ptsNo: string; keys: string; docs: string }

export interface ActSignature {
  /** PNG подписи пальцем, data:image/png;base64. */
  img: string;
  at: string;
  name: string;
  /** Сотрудник, на чьём телефоне поставлена подпись. */
  by: string;
  device: string;
}

export interface MarkHistory {
  act: "add" | "refine" | "remove";
  stage: StageId;
  at: string;
  who: string;
  role: string;
  src?: "manual" | "ai";
  code?: DmgCode;
  from?: DmgCode;
  to?: DmgCode;
  slot?: string;
  reason?: string;
  /** Снял менеджер после подписей: подписи при этом не сбрасываются, отметка остаётся в истории. */
  manager?: boolean;
}

export interface ActMark {
  id: number;
  /** Передача, на которой отметку поставили: от неё цвет на схеме. */
  stage: StageId;
  code: DmgCode;
  part: string;
  /** Место на схеме кузова, доли ширины и высоты картинки. */
  x: number;
  y: number;
  src: "manual" | "ai";
  removed: boolean;
  history: MarkHistory[];
}

/** Находка ИИ на фото: показывается другим цветом, пока приёмщик не согласится или не отклонит. */
export interface ActSuggestion {
  id: number;
  slot: string;
  part: string;
  code: DmgCode;
  desc: string;
  confidence: "high" | "medium" | "low";
  state: "pending" | "yes" | "no";
  x: number;
  y: number;
  by: string | null;
  at: string | null;
  markId: number | null;
}

export interface ActMedia {
  slot: string;
  kind: "photo" | "video";
  /** Ссылка на файл в хранилище S3, живёт час. */
  url: string;
  size: number;
  at: string;
  by: string;
  durationSec: number | null;
  /** Проверка фото ИИ: идёт, готова, ошибка или ИИ не настроен. */
  ai: null | { status: "checking" | "done" | "error" | "off"; quality: string | null; model: string | null };
}

export interface ActSection {
  stage: StageId;
  giveName: string;
  takeName: string;
  give: ActSignature | null;
  take: ActSignature | null;
  closedAt: string | null;
}

export interface ActView {
  no: number;
  stage: StageId;
  /** Все передачи машины по порядку, для полосы этапов и сводки подписей. */
  sections: ActSection[];
  transfer: string | null;
  orderStatus: string;
  contractDate: string;
  car: { car: string; vin: string; year: string; color: string; city: string };
  client: string;
  acceptor: string;
  details: ActCar;
  cond: Condition[];
  condOther: string;
  notes: string;
  giveName: string;
  takeName: string;
  giveRole: string;
  takeRole: string;
  give: ActSignature | null;
  take: ActSignature | null;
  disagree: boolean;
  disComment: string;
  absent: boolean;
  absentReason: string;
  closedAt: string | null;
  media: ActMedia[];
  marks: ActMark[];
  suggestions: ActSuggestion[];
  /** Чего не хватает до подписи «Сдал». Пусто — можно подписывать. */
  blockers: string[];
  storage: boolean;
  ai: boolean;
}

/** Строка списка «К приёмке». group — в каком списке машина у приёмщика своей площадки. */
export interface ActRow {
  no: number;
  stage: StageId;
  group: "todo" | "incoming" | "yard" | "done";
  transfer: string | null;
  /** Перегруз: рейс до терминала и сколько ему осталось, рейс дальше. */
  trip: { id: string; truck: string; driver: string; kmLeft: number } | null;
  trip2: { id: string; truck: string; driver: string } | null;
  car: string;
  vin: string;
  year: string;
  color: string;
  city: string;
  client: string;
  orderStatus: string;
  createdAt: string;
  photos: number;
  videos: number;
  pending: number;
  closedAt: string | null;
  signed: boolean;
}

/** Что мешает подписать акт: фото, видео, непроверенные находки ИИ, обязательные поля. */
export function actBlockers(a: Pick<ActView, "media" | "suggestions" | "details" | "cond" | "condOther" | "giveName" | "takeName">): string[] {
  const have = new Set(a.media.map((m) => m.slot));
  const out: string[] = [];
  const photos = PHOTO_SLOTS.filter((s) => !have.has(s.id)).length;
  const videos = VIDEO_SLOTS.filter((s) => !have.has(s.id)).length;
  if (photos) out.push(`Фото: не хватает ${photos} из ${PHOTO_SLOTS.length}`);
  if (videos) out.push(`Видео: не хватает ${videos} из ${VIDEO_SLOTS.length}`);
  const checking = a.media.filter((m) => m.ai?.status === "checking").length;
  if (checking) out.push(`ИИ ещё проверяет фото: ${checking}`);
  const pending = a.suggestions.filter((s) => s.state === "pending").length;
  if (pending) out.push(`Находки ИИ без решения: ${pending}. Согласитесь или отклоните каждую`);
  if (!a.details.keys.trim()) out.push("Укажите, сколько ключей принято");
  if (a.cond.includes("other") && !a.condOther.trim()) out.push("Условия осмотра «Иное»: напишите, что именно");
  if (!a.giveName.trim() || !a.takeName.trim()) out.push("Укажите ФИО сдающего и принимающего");
  return out;
}

/**
 * Примерное место повреждения на схеме кузова по названию элемента из ответа ИИ.
 * Схема: сверху вид справа, по центру вид сверху, снизу вид слева, по краям перед и зад.
 */
export function partPos(part: string, slot = ""): [number, number] {
  const p = part.toLowerCase(), L = /лев/.test(p), R = /прав/.test(p), F = /передн|перед /.test(p), B = /задн|зад /.test(p);
  if (/бампер/.test(p)) return B ? [0.89, 0.5] : [0.08, 0.5];
  if (/фар/.test(p)) return [0.04, 0.38];
  if (/фонар/.test(p)) return [0.93, 0.38];
  if (/капот/.test(p)) return [0.33, 0.5];
  if (/лобов/.test(p)) return [0.45, 0.5];
  if (/крыш/.test(p)) return [0.58, 0.5];
  if (/багаж|крышк|заднее стекло/.test(p)) return [0.68, 0.5];
  if (L || R) {
    const x = /крыл/.test(p) ? (F ? 0.27 : 0.66) : /двер/.test(p) ? (B ? 0.55 : 0.42) : /порог/.test(p) ? 0.49 : /зеркал/.test(p) ? 0.37
      : /диск|колес|шин/.test(p) ? (B ? 0.62 : 0.31) : F ? 0.3 : B ? 0.62 : 0.47;
    return L ? [x, 0.83] : [1 - x + 0.04, 0.18];
  }
  const bySlot: Record<string, [number, number]> = {
    front: [0.08, 0.5], front_left: [0.2, 0.8], left: [0.47, 0.83], rear_left: [0.75, 0.8], rear: [0.89, 0.5],
    rear_right: [0.25, 0.2], right: [0.5, 0.18], front_right: [0.75, 0.2], roof: [0.58, 0.5], hood: [0.33, 0.5],
    windshield: [0.45, 0.5], rear_glass: [0.68, 0.5], bumper_front_low: [0.08, 0.6], bumper_rear_low: [0.89, 0.6],
    sill_left: [0.49, 0.9], sill_right: [0.55, 0.12], wheel_fl: [0.31, 0.88], wheel_rl: [0.62, 0.88], wheel_rr: [0.42, 0.12],
    wheel_fr: [0.73, 0.12], door_fl: [0.42, 0.83], door_rl: [0.55, 0.83], door_rr: [0.49, 0.18], door_fr: [0.62, 0.18],
  };
  return bySlot[slot] ?? [0.5, 0.5];
}

/** Код по описанию, если ИИ не вернул свой: царапина, вмятина, скол, ремонт. */
export function guessCode(desc: string): DmgCode {
  const d = desc.toLowerCase();
  const big = /глубок|больш|крупн/.test(d), mid = /средн|ладон|заметн/.test(d);
  if (/множеств|несколько скол|сколы/.test(d)) return "SS";
  if (/скол/.test(d)) return "S";
  if (/вмят/.test(d)) return big ? "B3" : mid ? "B2" : "B1";
  if (/трещ|разбит|оторван|сломан/.test(d)) return "X";
  if (/ремонт|перекрас|шпакл/.test(d)) return "W1";
  return big ? "A3" : mid ? "A2" : "A1";
}
