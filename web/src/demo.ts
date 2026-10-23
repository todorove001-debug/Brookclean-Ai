// Имитация сервера для демо-сборки: те же ответы, что у server/src/app.ts, но в браузере.
import {
  contractData, contractDate, kmTo, maskVin, normalizePhone, parseRub, routeFor, validateCar, validateCompany, validateCustomer,
  type CarForm, type CompanyForm, type CustomerForm, type OrderStatus, type Quote, type TrackingView,
} from "@brookclean/shared";
// Только демо-страница: в обычной сборке сайта тарифов нет (проверяет web/vite.config.ts).
// Демо-файл содержит прайс целиком, поэтому его не стоит выкладывать в открытый доступ.
import { quote } from "../../server/src/pricing.ts";
import { demoPartner, partnerRequests } from "./demo-partners.ts";

interface DemoOrder {
  id: string; no: number; status: OrderStatus; createdAt: string; car: CarForm; customer: CustomerForm; phone: string;
  quote: Quote; code: string; trackToken: string | null; signedAt: string | null; km: number;
  events: TrackingView["events"]; review: TrackingView["review"];
}

const KEY = "demo-orders";
let orders: DemoOrder[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
})();
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(orders));
  } catch {
    /* демо работает и без хранилища */
  }
};

let demoPhone: string | null = null;
const DAY = 86_400_000;
const clientMe = (phone: string) => ({
  phone, partner: demoPartner(phone)?.status ?? null, ordersPerDay: 1,
  canOrder: demoPartner(phone)?.status === "approved" ||
    !orders.some((o) => o.phone === phone && o.signedAt && Date.now() - Date.parse(o.signedAt) < DAY),
});
let loginCode: { phone: string; code: string } | null = null;

const rand = (n: number) => Array.from({ length: n }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("");
const ok = (data: unknown) => ({ status: 200, data });
const fail = (status: number, error: string, errors?: unknown) => ({ status, data: { error, errors } });

async function sha256(text: string) {
  try {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    return "демо-" + rand(24);
  }
}

function publicOrder(o: DemoOrder, hash = "") {
  return {
    id: o.id, no: o.no, status: o.status, createdAt: o.createdAt, car: o.car,
    customer: { fio: o.customer.fio, phone: o.phone }, quote: o.quote, trackToken: o.trackToken, signedAt: o.signedAt,
    signature: o.signedAt ? { method: "ПЭП: код из SMS", phone: o.phone, at: o.signedAt, documentSha256: hash } : null,
  };
}

function view(o: DemoOrder): TrackingView {
  const destKm = kmTo(o.car.city);
  return {
    orderNo: o.no, car: `${o.car.car} ${o.car.year}`, vinMasked: maskVin(o.car.vin.toUpperCase()), city: o.car.city,
    status: o.status, km: Math.min(o.km, destKm), destKm, truck: o.status === "signed" ? null : "Volvo FH · А 482 КР 125",
    loadDate: "23.10", events: o.events, review: o.review,
  };
}

/** Кнопки демо в трекинге: двигают автовоз так, как это делал бы менеджер. */
export function demoAdvance(token: string, step: "move" | "arrive") {
  const o = orders.find((x) => x.trackToken === token);
  if (!o) return;
  const route = routeFor(o.car.city);
  const next = step === "arrive" ? route.length - 1 : Math.min(route.findIndex((c) => kmTo(c) > o.km), route.length - 2);
  const city = route[Math.max(next, 1)];
  o.km = kmTo(city);
  o.status = o.km >= kmTo(o.car.city) ? "arrived" : "in_transit";
  o.events.push({ at: new Date().toISOString(), city, note: o.status === "arrived" ? "Прибыл на терминал выдачи" : "В пути" });
  persist();
}

export async function demoFetch(path: string, method: string, body: any): Promise<{ status: number; data: unknown }> {
  let m: RegExpExecArray | null;
  if (path.startsWith("/api/staff/")) return (await import("./demo-staff.ts")).demoStaffFetch(path, method, body);

  if ((m = /^\/api\/partner-links\//.exec(path))) return fail(404, "Ссылка не найдена");

  // Вход по SMS: в демо код показывается на экране
  if (path === "/api/auth/me") return demoPhone ? ok(clientMe(demoPhone)) : fail(401, "Подтвердите номер телефона");
  if (path === "/api/auth/code") {
    const phone = normalizePhone(String(body?.phone ?? ""));
    if (!phone) return fail(400, "Укажите номер мобильного телефона", { phone: "Укажите номер мобильного телефона" });
    loginCode = { phone, code: String(Math.floor(1000 + Math.random() * 9000)) };
    return ok({ ok: true, phone, devCode: loginCode.code });
  }
  if (path === "/api/auth/verify") {
    if (!loginCode || normalizePhone(String(body?.phone)) !== loginCode.phone || String(body?.code) !== loginCode.code) return fail(400, "Неверный код");
    demoPhone = loginCode.phone;
    return ok(clientMe(demoPhone));
  }
  if (path === "/api/partner") {
    if (!demoPhone) return fail(401, "Подтвердите номер телефона");
    if (method === "GET") return ok(demoPartner(demoPhone) ?? null);
    const company = body?.company as CompanyForm;
    const errors = validateCompany(company);
    if (Object.keys(errors).length) return fail(400, "Проверьте реквизиты", errors);
    const prev = demoPartner(demoPhone);
    const r = { id: prev?.id ?? partnerRequests.length + 1, phone: demoPhone, createdAt: new Date().toISOString(), status: "pending" as const, company, reviewedAt: null };
    if (prev) Object.assign(prev, r);
    else partnerRequests.push(r);
    return ok(r);
  }
  if (path === "/api/auth/logout") return (demoPhone = null), ok({ ok: true });
  if (path === "/api/quote") {
    if (!demoPhone) return fail(401, "Подтвердите номер телефона, чтобы увидеть цену");
    if (!clientMe(demoPhone).canOrder)
      return { status: 403, data: { error: "Обычный клиент может оформить один автомобиль в сутки. Чтобы оформлять больше, заполните карточку партнёра.", needPartner: true } };
    const car = body?.car as CarForm;
    return ok(quote({ city: car.city, body: car.body, value: parseRub(car.value) }));
  }

  if (path === "/api/orders" && method === "POST") {
    const { car, customer, consents } = body as { car: CarForm; customer: CustomerForm; consents: Record<string, boolean> };
    const errors = { ...validateCar(car), ...validateCustomer(customer) };
    if (Object.keys(errors).length) return fail(400, "Проверьте поля", errors);
    if (!consents?.contract || !consents?.pep || !consents?.personalData) return fail(400, "Нужны все три согласия");
    if (demoPhone && !clientMe(demoPhone).canOrder)
      return { status: 403, data: { error: "Обычный клиент может оформить один автомобиль в сутки. Чтобы оформлять больше, заполните карточку партнёра.", needPartner: true } };
    const o: DemoOrder = {
      id: rand(16), no: 685 + orders.length, status: "draft", createdAt: new Date().toISOString(), car, customer,
      phone: normalizePhone(customer.phone), quote: quote({ city: car.city, body: car.body, value: parseRub(car.value) }),
      code: String(Math.floor(1000 + Math.random() * 9000)), trackToken: null, signedAt: null, km: 0, events: [], review: null,
    };
    orders.push(o);
    persist();
    return ok({ id: o.id, no: o.no, quote: o.quote, devCode: o.code });
  }

  if ((m = /^\/api\/orders\/(\w+)\/resend$/.exec(path))) {
    const o = orders.find((x) => x.id === m![1]);
    if (!o) return fail(404, "Заказ не найден");
    o.code = String(Math.floor(1000 + Math.random() * 9000));
    persist();
    return ok({ ok: true, devCode: o.code });
  }

  if ((m = /^\/api\/orders\/(\w+)\/sign$/.exec(path))) {
    const o = orders.find((x) => x.id === m![1]);
    if (!o) return fail(404, "Заказ не найден");
    if (String(body?.code) !== o.code) return fail(400, "Неверный код");
    o.status = "signed";
    o.signedAt = new Date().toISOString();
    o.trackToken = rand(16);
    persist();
    // Как на сервере: у одобренного партнёра Заказчик в договоре — его компания
    const p = demoPartner(o.phone);
    const contract = contractData(o.no, contractDate(new Date(o.createdAt)), o.car, o.customer, o.quote, p?.status === "approved" ? p.company : null);
    return ok({ ...publicOrder(o, await sha256(JSON.stringify(contract))), contract });
  }

  if ((m = /^\/api\/t\/(\w+)(\/received|\/review)?$/.exec(path))) {
    const o = orders.find((x) => x.trackToken === m![1]);
    if (!o) return fail(404, "Ссылка не найдена");
    if (m[2] === "/received") {
      o.status = "delivered";
      persist();
      return ok({ ok: true });
    }
    if (m[2] === "/review") {
      if (o.status !== "delivered") return fail(409, "Отзыв можно оставить после получения автомобиля");
      const rating = Number(body?.rating);
      if (!(rating >= 1 && rating <= 5)) return fail(400, "Поставьте оценку от 1 до 5");
      o.review = { rating, text: String(body?.text ?? "").trim() };
      persist();
      return ok({ ok: true });
    }
    return ok(view(o));
  }

  return fail(404, "Не найдено");
}
