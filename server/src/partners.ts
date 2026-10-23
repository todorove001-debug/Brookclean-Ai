// Партнёры с реквизитами компании: им можно оформлять больше одного автомобиля в сутки.
import type { CompanyForm, PartnerRequestView, PartnerStatus } from "@brookclean/shared";
import type { DB } from "./db.ts";

const DAY = 86_400_000;

/** Обычный клиент оформляет не больше стольких автомобилей за сутки, дальше — карточка партнёра. */
export const CLIENT_ORDERS_PER_DAY = 1;

export function migratePartners(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,        -- подтверждённый по SMS номер
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,              -- pending | approved | rejected
      company TEXT NOT NULL,             -- JSON CompanyForm
      reviewed_at TEXT,
      reviewed_by INTEGER
    );
  `);
}

interface Row { id: number; phone: string; created_at: string; status: PartnerStatus; company: string; reviewed_at: string | null }

export const requestView = (r: Row): PartnerRequestView => ({
  id: r.id, phone: r.phone, createdAt: r.created_at, status: r.status, company: JSON.parse(r.company) as CompanyForm, reviewedAt: r.reviewed_at,
});

export function partnerRequest(db: DB, phone: string) {
  const r = db.prepare("SELECT * FROM partner_requests WHERE phone = ?").get(phone) as Row | undefined;
  return r ? requestView(r) : undefined;
}

export const isPartner = (db: DB, phone: string) => partnerRequest(db, phone)?.status === "approved";

/** Сколько договоров номер подписал за последние сутки (заявки от менеджера не считаются). */
export function signedToday(db: DB, phone: string, now: Date, exceptId = "") {
  const since = new Date(now.getTime() - DAY).toISOString();
  return (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND signed_at > ? AND created_by IS NULL AND id != ?")
    .get(phone, since, exceptId) as { n: number }).n;
}

/** Можно ли номеру оформить ещё один автомобиль сегодня. */
export const canOrder = (db: DB, phone: string, now: Date, exceptId = "") =>
  isPartner(db, phone) || signedToday(db, phone, now, exceptId) < CLIENT_ORDERS_PER_DAY;
