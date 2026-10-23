// Автопарк: реестр водителей, формирование рейса, сдача рейсового отчёта, таблица доставок и обратка.
import { DOC_KINDS, type DocKind } from "./recognize.ts";

/** Мест в автовозе. */
export const CAPACITY = 8;
/** Доля страховки Спасских Ворот; остальное — ИП. */
export const SV_SHARE = 0.4;

// --- Реестр водителей ---
export const DOC_KEYS = Object.keys(DOC_KINDS) as DocKind[];
/** Данные документов: поля как в DOC_KINDS, заполняются по фото или вручную. */
export type DriverDocs = Partial<Record<DocKind, Record<string, string>>>;

export interface DriverInput {
  name: string;
  phone: string;
  own: boolean;
  /** Строка-группа из Excel: «Наёмники», название компании и т. п. */
  group: string;
  tractorModel: string;
  tractorPlate: string;
  trailerModel: string;
  trailerPlate: string;
  companyName: string;
  companyInn: string;
  companyPhone: string;
  docs: DriverDocs;
}

export interface DriverCard extends DriverInput {
  id: number;
  /** Учётная запись водителя в панели, если он входит сам. */
  staffId: number | null;
  /** Учётная запись ждёт подтверждения менеджером. */
  pending: boolean;
  active: boolean;
  fromExcel: boolean;
  createdAt: string;
  /** Открытый рейс водителя. */
  tripId: string | null;
  /** Документы, по которым есть хотя бы одно поле. */
  docsFilled: number;
  licExpired: boolean;
}

export const emptyDriver = (own = true): DriverInput => ({
  name: "", phone: "", own, group: "", tractorModel: "", tractorPlate: "", trailerModel: "", trailerPlate: "",
  companyName: "", companyInn: "", companyPhone: "", docs: {},
});

export const docsFilled = (docs: DriverDocs) => DOC_KEYS.filter((k) => Object.values(docs[k] ?? {}).some((v) => String(v).trim())).length;

/** ДД.ММ.ГГГГ → Date (полночь UTC) или null. */
export function ruDate(s: string | undefined): Date | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(s ?? "").trim());
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : null;
}
export function licExpired(docs: DriverDocs, now: Date) {
  const d = ruDate(docs.lic?.valid_until);
  return !!d && d.getTime() < now.getTime();
}

export const truckLine = (d: Pick<DriverInput, "tractorModel" | "tractorPlate">) => [d.tractorModel, d.tractorPlate].filter(Boolean).join(" · ");
export const trailerLine = (d: Pick<DriverInput, "trailerModel" | "trailerPlate">) => [d.trailerModel, d.trailerPlate].filter(Boolean).join(" · ");

// Импорт из Excel. Формат листа: «Транспортное средство | … | Водители | Дата рождения | Паспорт | Дата выдачи | Телефон».
// Строки без водителя — заголовки групп: «Наёмники», «Транзит» или компания с ИНН.
const PLATE_L = "АВЕКМНОРСТУХABEKMHOPCTYX";
const toCyr = (s: string) => s.toUpperCase().replace(/[ABEKMHOPCTYX]/g, (c) => "АВЕКМНОРСТУХ"["ABEKMHOPCTYX".indexOf(c)]);

function splitPlate(part: string, trailer: boolean): { model: string; plate: string } {
  const re = trailer
    ? new RegExp(`([${PLATE_L}]{2})\\s?(\\d{4})\\s?(\\d{2,3})`, "i")
    : new RegExp(`([${PLATE_L}])\\s?(\\d{3})\\s?([${PLATE_L}]{2})\\s?(\\d{2,3})`, "i");
  if (trailer) part = part.replace(new RegExp(`([${PLATE_L}])0(?=\\d{6,7}\\b)`, "gi"), "$1О"); // «A0214325» → «АО 2143 25»
  const m = re.exec(part);
  if (!m) {
    const toks = part.replace(/[,.:]+/g, " ").trim().split(/\s+/);
    const last = toks.at(-1) ?? "";
    // иностранный номер (транзит): последний токен из букв и цифр
    if (toks.length > 1 && /\d/.test(last) && /[A-ZА-Я]/i.test(last) && last.length >= 5) return { model: toks.slice(0, -1).join(" "), plate: last.toUpperCase() };
    return { model: part.replace(/[,.:]+$/, "").trim(), plate: "" };
  }
  const plate = trailer ? `${toCyr(m[1])} ${m[2]} ${m[3]}` : `${toCyr(m[1])} ${m[2]} ${toCyr(m[3])} ${m[4]}`;
  return { model: part.replace(m[0], "").replace(/[,.:]+/g, " ").replace(/\s+/g, " ").trim(), plate };
}

export function parseVehicle(s: string) {
  let [a = "", b] = String(s ?? "").split(/прицеп[:\s]*/i);
  if (!b) {
    const m = new RegExp(`[${PLATE_L}]\\s?\\d{3}\\s?[${PLATE_L}]{2}\\s?\\d{2,3}`, "i").exec(a);
    if (m) {
      b = a.slice(m.index + m[0].length);
      a = a.slice(0, m.index + m[0].length);
    }
  }
  return { tractor: splitPlate(a, false), trailer: splitPlate(b ?? "", true) };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const cellDate = (v: unknown) => (v instanceof Date ? `${pad2(v.getDate())}.${pad2(v.getMonth() + 1)}.${v.getFullYear()}` : String(v ?? "").trim());
function cellPhone(v: unknown) {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length === 10 ? "+7" + d : d.length === 11 ? "+7" + d.slice(1) : String(v ?? "").trim();
}

/** Строки первого листа → водители. Ключ importKey защищает от повторного импорта того же файла. */
export function parseDriverSheet(rows: unknown[][]): { drivers: Array<DriverInput & { importKey: string }>; companies: number } | { error: string } {
  const hi = rows.findIndex((r) => Array.isArray(r) && String(r[2] ?? "").trim() === "Водители");
  if (hi < 0) return { error: "Не найден столбец «Водители». Проверьте формат файла" };
  let group = { own: true, label: "", company: "", inn: "" };
  let veh: ReturnType<typeof parseVehicle> | null = null;
  const drivers: Array<DriverInput & { importKey: string }> = [];
  const companies = new Set<string>();
  for (const r of rows.slice(hi + 1)) {
    if (!Array.isArray(r)) continue;
    const a = r[0] != null ? String(r[0]).trim() : "", c = r[2] != null ? String(r[2]).trim() : "";
    if (!c) {
      if (!a) continue;
      if (/^наемник|^наёмник|^транзит$/i.test(a)) group = { own: false, label: a, company: "", inn: "" };
      else {
        const inn = /ИНН[:\s]*(\d{10,12})/i.exec(a)?.[1] ?? "";
        group = { own: group.own && !inn && !/^(ИП|ООО|OOO)/i.test(a), label: a, company: a.replace(/\(.*$/, "").replace(/,?\s*ИНН.*$/i, "").replace(/\s+/g, " ").trim(), inn };
      }
      veh = null;
      continue;
    }
    if (a) veh = parseVehicle(a);
    const pass = String(r[4] ?? "").trim().split(/\s+/).filter(Boolean), nm = c.split(/\s+/);
    if (!group.own && group.company) companies.add(group.company);
    drivers.push({
      ...emptyDriver(group.own),
      importKey: [c, String(r[4] ?? "").trim(), veh?.tractor.plate ?? ""].join("|"),
      name: c, phone: cellPhone(r[6]), group: group.label,
      companyName: group.own ? "" : group.company, companyInn: group.inn,
      tractorModel: veh?.tractor.model ?? "", tractorPlate: veh?.tractor.plate ?? "",
      trailerModel: veh?.trailer.model ?? "", trailerPlate: veh?.trailer.plate ?? "",
      docs: {
        p1: {
          last_name: nm[0] ?? "", first_name: nm[1] ?? "", middle_name: nm.slice(2).join(" "), birth_date: cellDate(r[3]),
          series: pass.length > 1 ? pass[0] : "", number: pass.length > 1 ? pass.slice(1).join(" ") : pass[0] ?? "", issue_date: cellDate(r[5]),
        },
      },
    });
  }
  return { drivers, companies: companies.size };
}

// --- Рейсовый отчёт: водитель сдаёт, менеджер принимает или возвращает ---
export const REPORT_STATUS = {
  draft: ["Заполняется", "gray"],
  submitted: ["На проверке", "warn"],
  returned: ["Возвращён на доработку", "err"],
  accepted: ["Принят", "ok"],
} as const;
export type ReportStatus = keyof typeof REPORT_STATUS;

/** Доля выручки машины, которая приходится на рейс: при перегрузе — по километрам плеча. */
export function legShare(leg: 1 | 2 | null, kmTransfer: number, kmCity: number) {
  if (!leg || !kmCity) return 1;
  const first = Math.min(1, kmTransfer / kmCity);
  return leg === 1 ? first : 1 - first;
}

// --- Распределение машин по рейсам ---
export interface DistributionTrip { id: string; dest: string; loadDate: string | null; seats: number }
export interface DistributionItem {
  no: number; car: string; city: string; transfer: string | null;
  /** 1 — ждёт первого рейса, 2 — стоит на терминале и ждёт рейса дальше. */
  leg: 1 | 2;
  /** Для второго плеча: машина уже принята на терминал. */
  atTerminal: boolean;
  trips: DistributionTrip[];
}

// --- Таблица доставок по рейсу (как лист «Рейс» в Google Таблице) ---
export interface DeliveryRow {
  no: number; createdAt: string; status: string; car: string; vin: string; year: string; city: string;
  /** «перегрузка в Новосибирске» / «с терминала Новосибирск». */
  legNote: string;
  client: string; phone: string; partner: string | null;
  arrivedTransfer: string | null; leftTransfer: string | null; arrivedCity: string | null; deliveredAt: string | null;
  delivery: number; cashback: number; value: number; insurance: number;
  policyNo: string; paidDelivery: boolean; paidInsurance: boolean; payTo: string; payForm: string;
}
export interface BackhaulRow { id: number; car: string; vin: string; route: string; client: string; price: number | null }
export interface Deliveries {
  trip: { id: string; dest: string; loadDate: string | null; truck: string; trailer: string; carrier: string; driver: string; driverPhone: string; formedAt: string | null };
  rows: DeliveryRow[];
  /** Колонки «Прибыл Нск / Убыл Нск»: рейс идёт через терминал. */
  throughTransfer: boolean;
  backhaul: BackhaulRow[];
}
