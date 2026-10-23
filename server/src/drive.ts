// Google Диск: рейсовые отчёты как Google Таблицы.
// Владелец один раз нажимает в панели «Подключить Google Диск» и входит в свой Google-аккаунт;
// сервер хранит refresh-токен и дальше сам создаёт и обновляет таблицы.
// Доступ drive.file: приложение видит только файлы, которые создало само.
import type { DB } from "./db.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Brookclean · рейсовые отчёты";

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const getSetting = (db: DB, key: string) =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
export const setSetting = (db: DB, key: string, value: string | null) =>
  value === null
    ? db.prepare("DELETE FROM settings WHERE key = ?").run(key)
    : db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export class GoogleDrive {
  private token: { value: string; expires: number } | null = null;

  constructor(private db: DB, private cfg: DriveConfig, private http: typeof fetch = fetch) {}

  get connected() {
    return !!getSetting(this.db, "google_refresh_token");
  }

  authUrl(state: string) {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, response_type: "code", scope: SCOPE,
      access_type: "offline", prompt: "consent", state,
    });
    return `${AUTH_URL}?${q}`;
  }

  async finishAuth(code: string) {
    const r = await this.tokenRequest({ code, grant_type: "authorization_code", redirect_uri: this.cfg.redirectUri });
    if (!r.refresh_token) throw new Error("Google не вернул refresh_token");
    setSetting(this.db, "google_refresh_token", r.refresh_token);
    setSetting(this.db, "google_folder_id", null);
    this.token = { value: r.access_token, expires: Date.now() + (r.expires_in - 60) * 1000 };
  }

  disconnect() {
    setSetting(this.db, "google_refresh_token", null);
    setSetting(this.db, "google_folder_id", null);
    this.token = null;
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await this.http(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; error?: string };
    if (!res.ok) throw new Error(`Google: ${data.error ?? res.status}`);
    return data;
  }

  private async accessToken() {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const refresh = getSetting(this.db, "google_refresh_token");
    if (!refresh) throw new Error("Google Диск не подключён");
    const r = await this.tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
    this.token = { value: r.access_token, expires: Date.now() + (r.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private async call(url: string, init: RequestInit) {
    const res = await this.http(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok) throw Object.assign(new Error(`Google Диск: ${data.error?.message ?? res.status}`), { status: res.status });
    return data;
  }

  private async folder() {
    const saved = getSetting(this.db, "google_folder_id");
    if (saved) return saved;
    const f = await this.call(`${API}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    setSetting(this.db, "google_folder_id", f.id!);
    return f.id!;
  }

  /** Создаёт или перезаписывает Google Таблицу из CSV. Возвращает id файла. */
  async upsertSheet(name: string, csv: string, fileId?: string | null): Promise<string> {
    if (fileId) {
      try {
        await this.call(`${UPLOAD}/files/${fileId}?uploadType=media`, {
          method: "PATCH", headers: { "content-type": "text/csv; charset=utf-8" }, body: csv,
        });
        return fileId;
      } catch (e) {
        // Файл удалили вручную — создадим заново
        if ((e as { status?: number }).status !== 404) throw e;
      }
    }
    const boundary = "brookclean" + Date.now();
    const meta = { name, mimeType: "application/vnd.google-apps.spreadsheet", parents: [await this.folder()] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: text/csv; charset=UTF-8\r\n\r\n${csv}\r\n--${boundary}--`;
    const f = await this.call(`${UPLOAD}/files?uploadType=multipart`, {
      method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body,
    });
    return f.id!;
  }
}

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}`;

export function toCsv(rows: Array<Array<string | number>>) {
  return rows.map((r) => r.map((c) => {
    const s = String(c ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
}
