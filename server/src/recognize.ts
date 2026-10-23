// Распознавание фото через Yandex AI Studio: документы водителя, чеки, повреждения при приёмке.
// Модель только предлагает поля. Проверки — в shared/recognize.ts, сохраняет человек после сверки с фото.
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import {
  DMG_CODES, DOC_KINDS, RECEIPT_CATEGORIES, guessCode, isDmgCode, checkDocument, checkReceipt, normDate,
  type DamageSuggestion, type DocKind, type FieldCheck, type RecognizeKind, type RecognizeResult,
} from "@brookclean/shared";

export interface Vision {
  /** Отправляет фото и промпт, возвращает текст ответа и модель, которая ответила. */
  ask(prompt: string, images: Buffer[]): Promise<{ text: string; model: string }>;
}

export class VisionError extends Error {}

export interface YandexOptions {
  apiKey: string;
  folderId: string;
  /** Модели по порядку: следующая — если предыдущая вернула пустой ответ, ошибку или не уложилась во время. */
  models: string[];
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Yandex AI Studio, OpenAI-совместимый API. Сервер и данные остаются в России. */
export class YandexVision implements Vision {
  constructor(private o: YandexOptions) {}

  async ask(prompt: string, images: Buffer[]) {
    const content = [
      { type: "text", text: prompt },
      ...images.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` } })),
    ];
    const errors: string[] = [];
    for (const model of this.o.models) {
      try {
        const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl ?? "https://llm.api.cloud.yandex.net"}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Api-Key ${this.o.apiKey}`, "x-folder-id": this.o.folderId },
          body: JSON.stringify({ model: `gpt://${this.o.folderId}/${model}`, temperature: 0, max_tokens: 2000, messages: [{ role: "user", content }] }),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        if (!res.ok) { errors.push(`${model}: HTTP ${res.status}`); continue; }
        const text = ((await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> }).choices?.[0]?.message?.content;
        if (text && text.trim()) return { text, model };
        errors.push(`${model}: пустой ответ`);
      } catch (e) {
        errors.push(`${model}: ${(e as Error).name === "TimeoutError" ? "нет ответа" : (e as Error).message}`);
      }
    }
    throw new VisionError(errors.join("; "));
  }
}

export function yandexFromEnv(env = process.env): YandexVision | undefined {
  if (!env.YANDEX_API_KEY || !env.YANDEX_FOLDER_ID) return undefined;
  return new YandexVision({
    apiKey: env.YANDEX_API_KEY,
    folderId: env.YANDEX_FOLDER_ID,
    models: (env.YANDEX_VISION_MODELS ?? "qwen3.6-35b-a3b/latest,deepseek-v4.1-flash/latest").split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMs: Number(env.YANDEX_TIMEOUT_MS ?? 60_000),
  });
}

// --- Промпты ---

function docPrompt(kind: DocKind) {
  const d = DOC_KINDS[kind];
  const mrz = kind === "p1"
    ? ` Ещё верни поле "mrz": нижнюю из двух строк машиночитаемой зоны внизу страницы (44 знака из латинских букв, цифр и «<»), посимвольно как напечатано, или null.`
    : "";
  return `На фото — ${d.label} (Россия). Прочитай документ и верни только JSON-объект с полями: ${d.fields.map(([k, l]) => `"${k}" (${l})`).join(", ")}.${mrz}`
    + ` Даты в формате ДД.ММ.ГГГГ. Госномер — как на документе, например «А 482 КР 125». Цифры переписывай по одной, не угадывай.`
    + ` Если поле не видно — null. Если на фото не этот документ — {"error":"wrong_doc"}.`;
}

const RECEIPT_PROMPT = `На фото кассовый чек водителя автовоза (Россия, расходы в рейсе). Прочитай его и верни только JSON-объект:
{"date":"ДД.ММ.ГГГГ или null","time":"ЧЧ:ММ или null","seller":"название продавца (ООО, ИП) или АЗС с номером","city":"город, если указан, иначе null","category":"одно из: ${RECEIPT_CATEGORIES.join(", ")}","description":"коротко, что куплено, например «ДТ, 160 л × 72,10»","liters":число литров для топлива или null,"amount":итоговая сумма чека числом,"fn":"номер ФН (16 цифр) или null","fd":"номер ФД или null","fp":"ФП или ФПД или null","notes":"что не удалось прочитать, иначе пустая строка"}
ФД — короткий номер документа, ФП — длинный фискальный признак (до 10 цифр), не перепутай. Цифры переписывай по одной.
Топливо (ДТ, АИ-92/95, газ, AdBlue) — fuel. Платон и платные трассы — toll. Кафе и магазины еды — food. Если на фото не кассовый чек, верни {"error":"not_receipt"}.`;

const DAMAGE_PROMPT = (part: string, compare: boolean) =>
  `${compare ? "Первое фото — этот же автомобиль на прошлом этапе, второе — сейчас. Найди только новые повреждения, которых нет на первом фото." : "Фото автомобиля при передаче. Найди видимые повреждения."}`
  + `${part ? ` Это ${part} кадра, увеличено: смотри мелкие детали.` : ""}`
  + ` Ищи царапины, вмятины, сколы, трещины, следы ремонта на кузове, стёклах, фарах и дисках.`
  + ` Подсказки: рыжая или светлая точка на тёмной краске — скол до металла; светлые полосы и потёртости по кромке обода — удар о бордюр.`
  + ` Грязь, пыль, блики, отражения, листья и капли воды — не повреждения.`
  + ` Верни только JSON: {"quality":"ok|blurry|dark|partial","damages":[{"part":"элемент по-русски","code":"код","desc":"что видно и где именно","confidence":"high|medium|low"}]}. Нет повреждений — "damages": [].`
  + ` Коды как в акте приёма: ${Object.entries(DMG_CODES).map(([k, v]) => `${k} — ${v.toLowerCase()}`).join("; ")}.`;

/** Поля без контрольной цифры, где ошибка в одной цифре дорого стоит: их модель читает второй раз отдельным вопросом. */
const KEY_FIELDS: Partial<Record<RecognizeKind, string[]>> = {
  p1: ["series", "number"], lic: ["number"], t1f: ["vin", "plate"], t2f: ["vin", "plate"], t1b: ["sts_number"], t2b: ["sts_number"],
  receipt: ["amount", "fd", "fp"],
};
const RECEIPT_LABELS: Record<string, string> = { amount: "итоговая сумма чека числом", fd: "ФД — номер фискального документа", fp: "ФП (ФПД) — фискальный признак" };

function recheckPrompt(kind: RecognizeKind, keys: string[]) {
  const label = kind === "receipt" ? "кассовый чек" : DOC_KINDS[kind as DocKind].label;
  const names = kind === "receipt" ? RECEIPT_LABELS : Object.fromEntries(DOC_KINDS[kind as DocKind].fields);
  return `На фото — ${label}. Найди и перепиши посимвольно, по одной цифре, только эти поля: ${keys.map((k) => `"${k}" (${names[k]})`).join(", ")}.`
    + ` Верни только JSON-объект с этими полями. Если поле не видно — null.`;
}

/** Для сравнения двух прочтений: только буквы и цифры, кириллица похожая на латиницу — латиницей. */
const sameText = (v: string) => [...v.toUpperCase().replace(/[^0-9A-ZА-ЯЁ.,]/g, "").replace(",", ".")]
  .map((c) => ({ А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X" } as Record<string, string>)[c] ?? c)
  .join("").replace(/^0+(?=\d)/, "").replace(/\.0+$/, "");

/** «ФН: 7380…, ФД: 84827, ФП: 1455…» одной строкой → отдельные поля (на случай, если модель сложила их вместе). */
export function splitFiscal(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, re] of [["fn", /ФН\D{0,3}(\d{16})/i], ["fd", /ФД\D{0,3}(\d{1,10})/i], ["fp", /ФПД?\D{0,3}(\d{1,10})/i]] as const) {
    const m = re.exec(v);
    if (m) out[k] = m[1];
  }
  return out;
}

/** Ответ модели → объект: снимает ```json, берёт первый {...}. */
export function parseJson(text: string): Record<string, unknown> | null {
  const s = text.replace(/```(?:json)?/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const RECEIPT_KEYS = ["date", "time", "seller", "city", "category", "description", "liters", "amount", "fn", "fd", "fp"];
const str = (v: unknown) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v).trim());

// --- Работа с JPEG: QR-код чека и нарезка фото на части ---

function decode(img: Buffer) {
  return jpeg.decode(img, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 400 });
}

/** QR-код на чеке: t=20260923T1508&s=25566.00&fn=…&i=…&fp=…&n=1. Цифры из него точнее, чем прочитанные моделью. */
export function receiptQr(img: Buffer): Record<string, string> | null {
  let raw: ReturnType<typeof decode>;
  try { raw = decode(img); } catch { return null; }
  const code = jsQR(new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), raw.width, raw.height);
  return code ? parseReceiptQr(code.data) : null;
}

export function parseReceiptQr(data: string): Record<string, string> | null {
  const p = new URLSearchParams(data.trim());
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(p.get("t") ?? "");
  const fn = p.get("fn"), fd = p.get("i"), fp = p.get("fp"), s = p.get("s");
  if (!fn || !fd || !fp) return null;
  const out: Record<string, string> = { fn, fd, fp };
  if (s && Number(s) > 0) out.amount = String(Number(s));
  if (t) { out.date = `${t[3]}.${t[2]}.${t[1]}`; out.time = `${t[4]}:${t[5]}`; }
  return out;
}

const TILES = [
  ["левая верхняя часть", 0, 0], ["правая верхняя часть", 0.4, 0], ["левая нижняя часть", 0, 0.4], ["правая нижняя часть", 0.4, 0.4],
] as const;

/** Четыре части кадра по 60% с перекрытием: на целом кадре модель не видит мелкие сколы и бордюр на диске. */
export function tiles(img: Buffer): Array<{ where: string; jpeg: Buffer }> {
  let raw: ReturnType<typeof decode>;
  try { raw = decode(img); } catch { return []; }
  const tw = Math.round(raw.width * 0.6), th = Math.round(raw.height * 0.6);
  return TILES.map(([where, fx, fy]) => {
    const x0 = Math.round(raw.width * fx), y0 = Math.round(raw.height * fy);
    const data = Buffer.alloc(tw * th * 4);
    for (let y = 0; y < th; y++) {
      const from = ((y0 + y) * raw.width + x0) * 4;
      data.set(raw.data.subarray(from, from + tw * 4), y * tw * 4);
    }
    return { where, jpeg: Buffer.from(jpeg.encode({ data, width: tw, height: th }, 90).data) };
  });
}

// --- Распознавание ---

export async function recognize(vision: Vision, kind: RecognizeKind, img: Buffer, opts: { prev?: Buffer; now?: Date } = {}): Promise<RecognizeResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  if (kind === "damage") return damages(vision, img, opts.prev, started);

  const prompt = kind === "receipt" ? RECEIPT_PROMPT : docPrompt(kind);
  const keys = KEY_FIELDS[kind] ?? [];
  const [answer, second, qr] = await Promise.all([
    vision.ask(prompt, [img]),
    keys.length ? vision.ask(recheckPrompt(kind, keys), [img]).then((a) => parseJson(a.text)).catch(() => null) : null,
    kind === "receipt" ? receiptQr(img) : null,
  ]);
  const ms = Date.now() - started;
  const r = parseJson(answer.text);
  const base = { kind, model: answer.model, ms };
  if (!r) return { ...base, fields: {}, checks: [], error: "unreadable" };
  if (r.error === "wrong_doc" || r.error === "not_receipt") return { ...base, fields: {}, checks: [], error: r.error };

  if (kind === "receipt") {
    const fields: Record<string, string> = { ...splitFiscal(str(r.fiscal)), ...Object.fromEntries(RECEIPT_KEYS.map((k) => [k, str(r[k])]).filter(([, v]) => v)) };
    if (fields.date) fields.date = normDate(fields.date);
    if (!RECEIPT_CATEGORIES.includes(fields.category as never)) fields.category = "other";
    const fromQr = qr ? Object.keys(qr) : [];
    Object.assign(fields, qr ?? {});
    const checks = [...compareReads(fields, second, keys.filter((k) => !fromQr.includes(k))), ...checkReceipt(fields, now, fromQr)];
    if (str(r.notes)) checks.push({ field: "notes", level: "warn", msg: str(r.notes) });
    return { ...base, fields, checks, fromQr };
  }

  const fields = Object.fromEntries(DOC_KINDS[kind].fields.map(([k]) => [k, str(r[k])]).filter(([, v]) => v));
  const reads = compareReads(fields, second, keys);
  return { ...base, fields, checks: [...reads, ...checkDocument(kind, fields, now, str(r.mrz) || undefined)] };
}

/** Сверяет основное прочтение с повторным. Разошлись — ошибка с обоим вариантами; поле не прочитано — берём второе. */
function compareReads(fields: Record<string, string>, second: Record<string, unknown> | null, keys: string[]): FieldCheck[] {
  if (!second) return [];
  return keys.flatMap((k): FieldCheck[] => {
    const a = fields[k] ?? "", b = str(second[k]);
    if (!b) return [];
    if (!a) { fields[k] = b; return [{ field: k, level: "warn", msg: "Прочитано со второго раза: сверьте с фото" }]; }
    if (sameText(a) === sameText(b)) return [{ field: k, level: "ok", msg: "Два прочтения совпали" }];
    return [{ field: k, level: "error", msg: `Два прочтения разошлись: «${a}» и «${b}». Сверьте с фото`, suggest: b }];
  });
}

async function damages(vision: Vision, img: Buffer, prev: Buffer | undefined, started: number): Promise<RecognizeResult> {
  const parts = [{ where: "весь кадр", jpeg: img }, ...tiles(img)];
  const answers = await Promise.allSettled(parts.map((p, i) =>
    vision.ask(DAMAGE_PROMPT(i ? p.where : "", !!prev && i === 0), prev && i === 0 ? [prev, p.jpeg] : [p.jpeg])));
  const ok = answers.flatMap((a, i) => (a.status === "fulfilled" ? [{ where: parts[i].where, model: a.value.model, r: parseJson(a.value.text) }] : []));
  if (!ok.length) throw new VisionError((answers[0] as PromiseRejectedResult).reason?.message ?? "нет ответа");

  const seen = new Set<string>();
  const found: DamageSuggestion[] = [];
  for (const { where, r } of ok) {
    for (const d of Array.isArray(r?.damages) ? r.damages : []) {
      const part = str(d?.part), desc = str(d?.desc);
      const key = `${part.toLowerCase()}|${desc.toLowerCase()}`;
      if (!part || seen.has(key)) continue;
      seen.add(key);
      const code = str(d?.code).toUpperCase();
      found.push({ part, desc, where, code: isDmgCode(code) ? code : guessCode(desc), confidence: ["high", "medium", "low"].includes(d?.confidence) ? d.confidence : "medium" });
    }
  }
  const full = ok.find((x) => x.where === "весь кадр");
  const q = str(full?.r?.quality);
  return {
    kind: "damage", fields: {}, checks: [], damages: found,
    quality: (["ok", "blurry", "dark", "partial"].includes(q) ? q : "ok") as RecognizeResult["quality"],
    model: [...new Set(ok.map((x) => x.model))].join(", "), ms: Date.now() - started,
  };
}
