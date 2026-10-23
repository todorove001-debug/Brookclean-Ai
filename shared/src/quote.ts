import type { BodyType } from "./tariffs.ts";

export interface QuoteInput {
  city: string;
  body: BodyType;
  value: number;
  /** Кэшбэк партнёра: прибавляется к перевозке, в договоре отдельно не показывается. */
  cashback?: number;
}

export interface Quote {
  tariff: number;
  cashback: number;
  delivery: number;
  insurance: number;
  total: number;
  /** Минивены и джипы считаются по габаритам: цена «от», подтверждает менеджер. */
  needsManager: boolean;
}

export const rub = (n: number) => new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽";

const ONES = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", ...ONES.slice(3)];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
const SCALES: Array<[string[], boolean] | null> = [
  null,
  [["тысяча", "тысячи", "тысяч"], true],
  [["миллион", "миллиона", "миллионов"], false],
  [["миллиард", "миллиарда", "миллиардов"], false],
];

export function plural(n: number, forms: string[]): string {
  const x = n % 100;
  if (x > 10 && x < 20) return forms[2];
  const y = n % 10;
  return y === 1 ? forms[0] : y >= 2 && y <= 4 ? forms[1] : forms[2];
}

/** Число прописью: 215000 → «двести пятнадцать тысяч». */
export function words(n: number): string {
  n = Math.floor(n);
  if (!n) return "ноль";
  const parts: string[] = [];
  let i = 0;
  while (n > 0) {
    const t = n % 1000;
    if (t) {
      const scale = SCALES[i];
      const w = [HUNDREDS[Math.floor(t / 100)]];
      const d = t % 100;
      if (d >= 10 && d < 20) w.push(TEENS[d - 10]);
      else {
        w.push(TENS[Math.floor(d / 10)]);
        w.push((scale?.[1] ? ONES_F : ONES)[d % 10]);
      }
      if (scale) w.push(plural(t, scale[0]));
      parts.unshift(w.filter(Boolean).join(" "));
    }
    n = Math.floor(n / 1000);
    i++;
  }
  return parts.join(" ");
}

/** 215000 → «215 000 (двести пятнадцать тысяч) рублей». */
export function rubWords(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(n) + " (" + words(n) + ") " + plural(n, ["рубль", "рубля", "рублей"]);
}
