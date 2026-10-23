// Защита цен от сбора конкурентами: вход клиента по SMS, лимиты, капча, журнал и чёрный список.
import type { SecurityKind, SecurityReport } from "@brookclean/shared";
import type { DB } from "./db.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Лимиты. Обычный клиент считает 1–3 варианта и получает 2 SMS (вход и подпись). */
export const LIMITS = {
  smsPerPhoneHour: 3,
  smsPerPhoneDay: 8,
  loginSmsPerIpHour: 5,
  loginSmsPerIpDay: 15,
  /** Разных пар «город + кузов» за сутки. Повторный расчёт того же варианта не считается. */
  quotesPerPhoneDay: 6,
  quotesPerIpDay: 12,
  /** С этого числа разных городов за сутки номер попадает в журнал как подозрительный. */
  suspiciousCities: 4,
};

export interface CaptchaVerifier {
  siteKey: string;
  verify(token: string, ip: string): Promise<boolean>;
}

/** Яндекс SmartCaptcha: ключи в консоли Yandex Cloud → SmartCaptcha. */
export class YandexCaptcha implements CaptchaVerifier {
  constructor(public siteKey: string, private serverKey: string) {}

  async verify(token: string, ip: string) {
    if (!token) return false;
    try {
      const res = await fetch("https://smartcaptcha.yandexcloud.net/validate", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: this.serverKey, token, ip }),
        signal: AbortSignal.timeout(5000),
      });
      // Если сервис капчи недоступен, клиента не блокируем: лимиты всё равно действуют
      if (!res.ok) return true;
      return ((await res.json()) as { status?: string }).status === "ok";
    } catch {
      return true;
    }
  }
}

export function captchaFromEnv(): CaptchaVerifier | undefined {
  const { SMARTCAPTCHA_CLIENT_KEY: site, SMARTCAPTCHA_SERVER_KEY: server } = process.env;
  return site && server ? new YandexCaptcha(site, server) : undefined;
}

export function migrateGuard(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_sessions (
      token_hash TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      phone TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sms_log (at INTEGER NOT NULL, phone TEXT NOT NULL, ip TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sms_log_phone ON sms_log (phone, at);
    CREATE INDEX IF NOT EXISTS sms_log_ip ON sms_log (ip, at);
    CREATE TABLE IF NOT EXISTS quote_log (at INTEGER NOT NULL, phone TEXT NOT NULL, ip TEXT NOT NULL, city TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS quote_log_phone ON quote_log (phone, at);
    CREATE INDEX IF NOT EXISTS quote_log_ip ON quote_log (ip, at);
    CREATE TABLE IF NOT EXISTS security_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      ip TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS blocklist (
      value TEXT PRIMARY KEY,            -- телефон +7… или IP
      at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      staff_id INTEGER
    );
  `);
}

type Count = { n: number };

export class Guard {
  constructor(private db: DB, private now: () => Date) {}

  private t() {
    return this.now().getTime();
  }

  isBlocked(...values: Array<string | undefined>) {
    return values.some((v) => v && this.db.prepare("SELECT 1 FROM blocklist WHERE value = ?").get(v));
  }

  log(kind: SecurityKind, ip: string, phone = "", detail = "") {
    this.db.prepare("INSERT INTO security_log (at, ip, phone, kind, detail) VALUES (?, ?, ?, ?, ?)").run(this.t(), ip, phone, kind, detail);
  }

  private recent(table: "sms_log" | "quote_log" | "security_log", col: "phone" | "ip", value: string, ms: number, where = "") {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ? AND at > ? ${where}`).get(value, this.t() - ms) as Count).n;
  }

  /** Проверка перед любой SMS клиенту. Возвращает текст ошибки или undefined. */
  /** partner: проверенный партнёр оформляет много машин, лимит SMS на номер к нему не применяется. */
  smsDenied(phone: string, ip: string, login: boolean, partner = false): string | undefined {
    const tooMany =
      (!partner && this.recent("sms_log", "phone", phone, HOUR) >= LIMITS.smsPerPhoneHour) ||
      (!partner && this.recent("sms_log", "phone", phone, DAY) >= LIMITS.smsPerPhoneDay) ||
      (login && (this.recent("sms_log", "ip", ip, HOUR, "AND kind = 'login'") >= LIMITS.loginSmsPerIpHour ||
        this.recent("sms_log", "ip", ip, DAY, "AND kind = 'login'") >= LIMITS.loginSmsPerIpDay));
    if (!tooMany) return undefined;
    this.log("sms_limit", ip, phone);
    return "Слишком много SMS. Попробуйте позже или позвоните нам.";
  }

  recordSms(phone: string, ip: string, kind: "login" | "sign") {
    this.db.prepare("INSERT INTO sms_log (at, phone, ip, kind) VALUES (?, ?, ?, ?)").run(this.t(), phone, ip, kind);
  }

  /** Капчу показываем только при подозрительной активности: много входов с одного адреса или записи в журнале. */
  captchaNeeded(phone: string, ip: string) {
    return (
      this.recent("sms_log", "ip", ip, HOUR, "AND kind = 'login'") >= 2 ||
      this.recent("sms_log", "ip", ip, DAY, "AND kind = 'login'") >= 4 ||
      this.recent("security_log", "ip", ip, DAY) > 0 ||
      (!!phone && this.recent("security_log", "phone", phone, DAY) > 0)
    );
  }

  private pairs(col: "phone" | "ip", value: string, extra?: { city: string; body: string }) {
    const rows = this.db.prepare(`SELECT DISTINCT city, body FROM quote_log WHERE ${col} = ? AND at > ?`).all(value, this.t() - DAY) as Array<{ city: string; body: string }>;
    const set = new Set(rows.map((r) => r.city + "|" + r.body));
    if (extra) set.add(extra.city + "|" + extra.body);
    return { pairs: set.size, cities: new Set([...set].map((k) => k.split("|")[0])).size };
  }

  /** Расчёт цены: лимит на разные варианты за сутки. Возвращает текст ошибки или undefined. */
  quoteDenied(phone: string, ip: string, city: string, body: string): string | undefined {
    const byPhone = this.pairs("phone", phone, { city, body });
    const byIp = this.pairs("ip", ip, { city, body });
    if (byPhone.pairs > LIMITS.quotesPerPhoneDay || byIp.pairs > LIMITS.quotesPerIpDay) {
      this.log("quote_limit", ip, phone, `${city}, ${body}`);
      return "Лимит расчётов на сегодня исчерпан. Для других вариантов позвоните менеджеру.";
    }
    this.db.prepare("INSERT INTO quote_log (at, phone, ip, city, body) VALUES (?, ?, ?, ?, ?)").run(this.t(), phone, ip, city, body);
    const { cities } = this.pairs("phone", phone);
    if (cities === LIMITS.suspiciousCities && this.recent("security_log", "phone", phone, DAY, "AND kind = 'many_cities'") === 0)
      this.log("many_cities", ip, phone, `${cities} города за сутки`);
    return undefined;
  }

  block(value: string, note: string, staffId: number | null) {
    this.db.prepare(`INSERT INTO blocklist (value, at, note, staff_id) VALUES (?, ?, ?, ?)
                     ON CONFLICT(value) DO UPDATE SET note = excluded.note`).run(value, this.now().toISOString(), note, staffId);
  }

  unblock(value: string) {
    this.db.prepare("DELETE FROM blocklist WHERE value = ?").run(value);
  }

  /** Для раздела «Защита» в панели: последние события, подозрительные номера и адреса за 7 дней, чёрный список. */
  report(): SecurityReport {
    const since = this.t() - 7 * DAY;
    const events = this.db.prepare("SELECT id, at, ip, phone, kind, detail FROM security_log WHERE at > ? ORDER BY at DESC LIMIT 300")
      .all(since) as unknown as SecurityReport["events"];
    const blocked = this.db.prepare("SELECT value, at, note FROM blocklist ORDER BY at DESC").all() as unknown as SecurityReport["blocked"];
    const blockedSet = new Set(blocked.map((b) => b.value));
    const suspects: SecurityReport["suspects"] = [];
    for (const col of ["phone", "ip"] as const) {
      const rows = this.db.prepare(`
        SELECT v, SUM(e) AS events, SUM(q) AS quotes, MAX(at) AS last FROM (
          SELECT ${col} AS v, 1 AS e, 0 AS q, at FROM security_log WHERE at > ? AND ${col} != ''
          UNION ALL SELECT ${col}, 0, 1, at FROM quote_log WHERE at > ?
        ) GROUP BY v HAVING SUM(e) > 0 ORDER BY last DESC LIMIT 100`).all(since, since) as Array<{ v: string; events: number; quotes: number; last: number }>;
      for (const r of rows) {
        const cities = (this.db.prepare(`SELECT COUNT(DISTINCT city) AS n FROM quote_log WHERE ${col} = ? AND at > ?`).get(r.v, since) as Count).n;
        suspects.push({ kind: col, value: r.v, events: r.events, quotes: r.quotes, cities, last: r.last, blocked: blockedSet.has(r.v) });
      }
    }
    suspects.sort((a, b) => b.last - a.last);
    return { events, suspects, blocked };
  }
}
