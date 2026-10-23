// Распознавание фото (документы, чеки, повреждения): поля, проверки и то, что видит человек перед подтверждением.
// ИИ путает отдельные цифры, поэтому каждое поле проверяется здесь, а сохраняет данные только человек.

export const DOC_KINDS = {
  p1: { label: "Паспорт · разворот с фото", fields: [["last_name", "Фамилия"], ["first_name", "Имя"], ["middle_name", "Отчество"], ["birth_date", "Дата рождения"], ["birth_place", "Место рождения"], ["series", "Серия"], ["number", "Номер"], ["issued_by", "Кем выдан"], ["issue_date", "Дата выдачи"], ["code", "Код подразделения"]] },
  p2: { label: "Паспорт · страница с пропиской", fields: [["address", "Адрес регистрации"], ["reg_date", "Дата регистрации"]] },
  lic: { label: "Водительское удостоверение", fields: [["number", "Номер ВУ"], ["categories", "Категории"], ["issue_date", "Дата выдачи"], ["valid_until", "Действует до"], ["birth_date", "Дата рождения"]] },
  t1f: { label: "СТС тягача · лицевая сторона", fields: [["plate", "Госномер"], ["model", "Марка, модель"], ["vin", "VIN"], ["year", "Год выпуска"], ["color", "Цвет"], ["category", "Категория"]] },
  t1b: { label: "СТС тягача · оборотная сторона", fields: [["owner", "Собственник"], ["owner_address", "Адрес собственника"], ["sts_number", "Серия и номер СТС"]] },
  t2f: { label: "СТС прицепа · лицевая сторона", fields: [["plate", "Госномер"], ["model", "Марка, модель"], ["vin", "VIN"], ["year", "Год выпуска"], ["category", "Категория"]] },
  t2b: { label: "СТС прицепа · оборотная сторона", fields: [["owner", "Собственник"], ["owner_address", "Адрес собственника"], ["sts_number", "Серия и номер СТС"]] },
} as const satisfies Record<string, { label: string; fields: ReadonlyArray<readonly [string, string]> }>;
export type DocKind = keyof typeof DOC_KINDS;
export const isDocKind = (k: unknown): k is DocKind => typeof k === "string" && k in DOC_KINDS;

export const RECEIPT_FIELDS = [
  ["date", "Дата"], ["time", "Время"], ["seller", "Продавец, АЗС"], ["city", "Город"], ["category", "Вид расхода"],
  ["description", "Что куплено"], ["liters", "Литры"], ["amount", "Сумма, ₽"], ["fn", "ФН"], ["fd", "ФД"], ["fp", "ФП"],
] as const;
export const RECEIPT_CATEGORIES = ["fuel", "toll", "parking", "food", "lodging", "repair", "wash", "other"] as const;

export type RecognizeKind = DocKind | "receipt" | "damage";

/** ok — проверка прошла; warn — сверьте с фото; error — так быть не может, поле нужно исправить. */
export type CheckLevel = "ok" | "warn" | "error";
export interface FieldCheck { field: string; level: CheckLevel; msg: string; suggest?: string }

export interface DamageSuggestion {
  part: string;
  desc: string;
  confidence: "high" | "medium" | "low";
  /** Код из акта приёма (A1…X): ИИ предлагает, приёмщик может уточнить. */
  code?: string;
  /** Где на фото: весь кадр или его часть (фото режется на части, чтобы мелкие сколы были видны). */
  where: string;
}

export interface RecognizeResult {
  kind: RecognizeKind;
  fields: Record<string, string>;
  checks: FieldCheck[];
  /** Повреждения — только предложения; водитель подтверждает или отклоняет каждое. */
  damages?: DamageSuggestion[];
  quality?: "ok" | "blurry" | "dark" | "partial";
  /** Поля, взятые из QR-кода чека, а не прочитанные моделью. */
  fromQr?: string[];
  error?: "wrong_doc" | "not_receipt" | "unreadable";
  model: string;
  ms: number;
}

// --- Нормализация ---

const LAT2CYR: Record<string, string> = { A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", Y: "У", X: "Х" };
const CYR2LAT: Record<string, string> = Object.fromEntries(Object.entries(LAT2CYR).map(([l, c]) => [c, l]));
const PLATE_LETTERS = "АВЕКМНОРСТУХ";
const digitsOf = (v: string) => v.replace(/\D/g, "");
const compact = (v: string) => v.toUpperCase().replace(/[\s\-–—]/g, "");

/** «23.09.26», «23/09/2026», «2026-09-23» → «23.09.2026»; неразборчивое — как есть. */
export function normDate(v: string): string {
  const s = v.trim();
  let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? (Number(m[3]) > 50 ? "19" : "20") + m[3] : m[3];
    return `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${y}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

/** ДД.ММ.ГГГГ → Date (UTC, полночь) или null, если такой даты нет. */
export function parseRuDate(v: string): Date | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return d.getUTCDate() === +m[1] && d.getUTCMonth() === +m[2] - 1 ? d : null;
}
const addYears = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate()));

/** Госномер: латиница, похожая на кириллицу, → кириллица, пробелы как на номере: «А 482 КР 125», «АА 1234 25». */
export function normPlate(v: string): string {
  const s = [...compact(v)].map((c) => LAT2CYR[c] ?? c).join("");
  let m = /^([А-Я])(\d{3})([А-Я]{2})(\d{2,3})$/.exec(s);
  if (m) return `${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  m = /^([А-Я]{2})(\d{4})(\d{2,3})$/.exec(s);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : v.trim();
}

export function normVin(v: string): string {
  return [...compact(v)].map((c) => CYR2LAT[c] ?? c).join("");
}

// --- Отдельные проверки ---

const VIN_VAL: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Контрольная цифра VIN (9-й знак). Обязательна для машин из США и Китая; европейские часто без неё. */
export function vinCheckDigit(vin: string): string {
  const sum = [...vin].reduce((s, c, i) => s + (/\d/.test(c) ? +c : VIN_VAL[c] ?? 0) * VIN_W[i], 0);
  const r = sum % 11;
  return r === 10 ? "X" : String(r);
}

export function checkVin(raw: string): FieldCheck {
  const vin = normVin(raw);
  if (vin.length !== 17) return { field: "vin", level: "error", msg: `В VIN должно быть 17 знаков, прочитано ${vin.length}` };
  if (/[IOQ]/.test(vin)) return { field: "vin", level: "error", msg: "В VIN не бывает букв I, O и Q: скорее всего, это 1 или 0", suggest: vin.replace(/[IQ]/g, (c) => (c === "I" ? "1" : "0")).replace(/O/g, "0") };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return { field: "vin", level: "error", msg: "В VIN только латинские буквы и цифры" };
  if (vinCheckDigit(vin) === vin[8]) return { field: "vin", level: "ok", msg: "Контрольная цифра VIN сошлась" };
  return { field: "vin", level: "warn", msg: "Контрольная цифра VIN не сошлась. Сверьте каждый знак с фото (у европейских машин контрольной цифры может не быть)" };
}

export function checkPlate(raw: string, trailer: boolean): FieldCheck {
  const p = normPlate(raw);
  const L = `[${PLATE_LETTERS}]`;
  const ok = trailer ? new RegExp(`^${L}{2} \\d{4} \\d{2,3}$`).test(p) : new RegExp(`^${L} \\d{3} ${L}{2} \\d{2,3}$`).test(p);
  if (ok) return { field: "plate", level: "ok", msg: "Формат российского номера", suggest: p !== raw ? p : undefined };
  return { field: "plate", level: "warn", msg: trailer ? "Не похоже на номер прицепа РФ (АА 1234 25). Если номер иностранный, сверьте с фото" : "Не похоже на номер РФ (А 123 ВС 125). Если номер иностранный, сверьте с фото" };
}

/** ВУ: 10 цифр «99 19 942400» (с 2011 года) или старый формат «25 АВ 123456». */
export function checkLicenseNo(raw: string): FieldCheck {
  const s = compact(raw);
  const m = /^(\d{2})(\d{2}|[А-Я]{2})(\d{6})$/.exec([...s].map((c) => LAT2CYR[c] ?? c).join(""));
  if (m) return { field: "number", level: "warn", msg: "Формат верный. Контрольной цифры у ВУ нет: сверьте цифры с фото", suggest: `${m[1]} ${m[2]} ${m[3]}` };
  return { field: "number", level: "error", msg: "Номер ВУ: 10 цифр, например 99 19 942400" };
}

/** СТС: «99 65 921907» или «25 ХК 123456». Иностранные СТС не проверяем, только просим сверить. */
export function checkStsNo(raw: string): FieldCheck {
  const s = [...compact(raw)].map((c) => LAT2CYR[c] ?? c).join("");
  const m = /^(\d{2})(\d{2}|[А-Я]{2})(\d{6})$/.exec(s);
  if (m) return { field: "sts_number", level: "warn", msg: "Формат верный. Сверьте цифры с фото", suggest: `${m[1]} ${m[2]} ${m[3]}` };
  return { field: "sts_number", level: "warn", msg: "Не похоже на российский СТС (99 65 921907). Если документ иностранный, сверьте с фото" };
}

// --- Машиночитаемая строка паспорта РФ: у неё свои контрольные цифры ---

const mrzVal = (c: string) => (/\d/.test(c) ? +c : c === "<" ? 0 : c.charCodeAt(0) - 55);
const mrzCheck = (s: string) => String([...s].reduce((a, c, i) => a + mrzVal(c) * [7, 3, 1][i % 3], 0) % 10);

export interface PassportMrz { series: string; number: string; birth_date: string; issue_date: string; code: string }

/**
 * Вторая строка MRZ паспорта РФ (44 знака): серия (3 первые цифры) и номер, дата рождения,
 * последняя цифра серии, дата выдачи, код подразделения. Возвращает null, если контрольные цифры не сходятся.
 */
export function parseRuPassportMrz(line: string): PassportMrz | null {
  const s = line.toUpperCase().replace(/[\s«]/g, "<").replace(/[^A-Z0-9<]/g, "");
  if (s.length !== 44) return null;
  const doc = s.slice(0, 9), birth = s.slice(13, 19), opt = s.slice(28, 42);
  if (mrzCheck(doc) !== s[9] || mrzCheck(birth) !== s[19] || mrzCheck(opt) !== s[42]) return null;
  const final = s.slice(0, 10) + s.slice(13, 20) + s.slice(21, 43);
  if (mrzCheck(final) !== s[43]) return null;
  const ymd = (v: string, past: boolean) => {
    const yy = +v.slice(0, 2), now = new Date().getUTCFullYear() % 100;
    const century = past && yy > now ? 1900 : 2000;
    return `${v.slice(4, 6)}.${v.slice(2, 4)}.${century + yy}`;
  };
  const series = doc.slice(0, 3) + opt[0];
  return {
    series: `${series.slice(0, 2)} ${series.slice(2)}`, number: doc.slice(3, 9),
    birth_date: ymd(birth, true), issue_date: ymd(opt.slice(1, 7), true), code: `${opt.slice(7, 10)}-${opt.slice(10, 13)}`,
  };
}

// --- Проверки целиком по документу и чеку ---

const today = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

function dateCheck(out: FieldCheck[], f: Record<string, string>, key: string, now: Date, opts: { past?: boolean; future?: boolean } = {}) {
  const v = f[key];
  if (!v) return null;
  f[key] = normDate(v);
  const d = parseRuDate(f[key]);
  if (!d) { out.push({ field: key, level: "error", msg: "Нет такой даты. Нужен формат ДД.ММ.ГГГГ" }); return null; }
  if (opts.past && d > today(now)) { out.push({ field: key, level: "error", msg: "Дата в будущем: скорее всего, перепутана цифра" }); return null; }
  if (opts.future && d < today(now)) out.push({ field: key, level: "warn", msg: "Срок уже истёк" });
  return d;
}

/** Проверяет и нормализует поля документа. Меняет f: даты, госномер, VIN приводятся к одному виду. */
export function checkDocument(kind: DocKind, f: Record<string, string>, now = new Date(), mrz?: string): FieldCheck[] {
  const out: FieldCheck[] = [];
  for (const [key, label] of DOC_KINDS[kind].fields) if (!f[key]) out.push({ field: key, level: "warn", msg: `${label}: не прочитано, впишите с фото` });

  if (kind === "p1") {
    const birth = dateCheck(out, f, "birth_date", now, { past: true });
    const issue = dateCheck(out, f, "issue_date", now, { past: true });
    if (birth && issue && issue < addYears(birth, 14)) out.push({ field: "issue_date", level: "error", msg: "Паспорт выдают с 14 лет: проверьте даты" });
    if (f.series) {
      const s = digitsOf(f.series);
      if (s.length === 4) f.series = `${s.slice(0, 2)} ${s.slice(2)}`;
      else out.push({ field: "series", level: "error", msg: "Серия паспорта — 4 цифры" });
    }
    if (f.number && !/^\d{6}$/.test(digitsOf(f.number))) out.push({ field: "number", level: "error", msg: "Номер паспорта — 6 цифр" });
    else if (f.number) f.number = digitsOf(f.number);
    if (f.code) {
      const c = digitsOf(f.code);
      if (c.length === 6) f.code = `${c.slice(0, 3)}-${c.slice(3)}`;
      else out.push({ field: "code", level: "error", msg: "Код подразделения — 6 цифр, 770-125" });
    }
    const m = mrz ? parseRuPassportMrz(mrz) : null;
    if (m) {
      for (const key of ["series", "number", "birth_date", "issue_date", "code"] as const) {
        if (!f[key]) { f[key] = m[key]; out.push({ field: key, level: "ok", msg: "Взято из нижней строки паспорта" }); }
        else if (f[key] === m[key]) out.push({ field: key, level: "ok", msg: "Совпало с нижней строкой паспорта" });
        else out.push({ field: key, level: "error", msg: `В нижней строке паспорта ${m[key]}. Сверьте с фото`, suggest: m[key] });
      }
    }
  }
  if (kind === "p2") dateCheck(out, f, "reg_date", now, { past: true });
  if (kind === "lic") {
    const birth = dateCheck(out, f, "birth_date", now, { past: true });
    const issue = dateCheck(out, f, "issue_date", now, { past: true });
    const until = dateCheck(out, f, "valid_until", now, { future: true });
    if (f.number) out.push(checkLicenseNo(f.number));
    if (issue && until && until.getTime() !== addYears(issue, 10).getTime())
      out.push({ field: "valid_until", level: "warn", msg: "ВУ обычно действует 10 лет от даты выдачи: проверьте обе даты" });
    if (birth && issue && issue < addYears(birth, 16)) out.push({ field: "issue_date", level: "error", msg: "ВУ не выдают раньше 16 лет: проверьте даты" });
  }
  if (kind === "t1f" || kind === "t2f") {
    if (f.vin) {
      const c = checkVin(f.vin);
      f.vin = normVin(f.vin);
      out.push(c);
    }
    if (f.plate) {
      const c = checkPlate(f.plate, kind === "t2f");
      if (c.level === "ok") f.plate = normPlate(f.plate);
      out.push(c);
    }
    if (f.year) {
      const y = Number(digitsOf(f.year));
      if (!(y >= 1970 && y <= now.getUTCFullYear() + 1)) out.push({ field: "year", level: "error", msg: "Год выпуска вне разумных пределов" });
    }
  }
  if ((kind === "t1b" || kind === "t2b") && f.sts_number) out.push(checkStsNo(f.sts_number));
  return out;
}

/** Номер фискального документа и ФП — целые от 1 до 4 294 967 295 (32 бита). */
const FISCAL_MAX = 4_294_967_295;

export function checkReceipt(f: Record<string, string>, now = new Date(), fromQr: string[] = []): FieldCheck[] {
  const out: FieldCheck[] = [];
  const qr = (k: string) => fromQr.includes(k);
  for (const k of fromQr) out.push({ field: k, level: "ok", msg: "Взято из QR-кода чека" });

  const amount = Number(String(f.amount ?? "").replace(/\s/g, "").replace(",", "."));
  if (!(amount > 0)) out.push({ field: "amount", level: "error", msg: "Сумма чека не прочитана" });
  else if (!qr("amount")) out.push({ field: "amount", level: "warn", msg: "Сверьте итог с чеком" });

  if (!f.date) out.push({ field: "date", level: "warn", msg: "Дата не прочитана" });
  else {
    const d = dateCheck(out, f, "date", now, { past: true });
    if (d && d < new Date(today(now).getTime() - 90 * 86_400_000)) out.push({ field: "date", level: "warn", msg: "Чеку больше 90 дней: проверьте год" });
  }
  if (f.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time)) out.push({ field: "time", level: "warn", msg: "Время в формате ЧЧ:ММ" });

  if (f.fn && !qr("fn") && digitsOf(f.fn).length !== 16) out.push({ field: "fn", level: "error", msg: "Номер ФН — 16 цифр" });
  const fd = digitsOf(f.fd ?? ""), fp = digitsOf(f.fp ?? "");
  if (fd && !qr("fd") && !(+fd >= 1 && +fd <= FISCAL_MAX)) out.push({ field: "fd", level: "error", msg: "ФД — число не больше 4 294 967 295" });
  if (fp && !qr("fp") && !(+fp >= 1 && +fp <= FISCAL_MAX)) out.push({ field: "fp", level: "error", msg: "ФП — число не больше 4 294 967 295" });
  if (fd && fp && !qr("fd") && fd.replace(/^0+/, "").length >= 9 && fp.replace(/^0+/, "").length <= 7)
    out.push({ field: "fd", level: "error", msg: "Похоже, ФД и ФП перепутаны: ФП обычно длиннее", suggest: fp });
  if ((fd || fp) && !qr("fp")) out.push({ field: "fp", level: "warn", msg: "Контрольной цифры у ФП нет: сверьте с чеком (QR-код не прочитался)" });

  if (f.category === "fuel") {
    const liters = Number(String(f.liters ?? "").replace(",", "."));
    if (!(liters > 0)) out.push({ field: "liters", level: "warn", msg: "Для топлива укажите литры" });
    else if (amount > 0) {
      const price = amount / liters;
      if (price < 30 || price > 200) out.push({ field: "liters", level: "error", msg: `Получается ${price.toFixed(2)} ₽ за литр: проверьте литры и сумму` });
    }
  }
  return out;
}

/** Можно ли сохранять: ошибок не осталось. Предупреждения человек снимает, сверив поле с фото. */
export const hasErrors = (checks: FieldCheck[]) => checks.some((c) => c.level === "error");
