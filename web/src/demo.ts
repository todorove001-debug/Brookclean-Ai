// Имитация сервера для демо-сборки: те же ответы, что у server/src/app.ts, но в браузере.
import {
  kmTo, maskVin, normalizePhone, parseRub, quote, routeFor, validateCar, validateCustomer,
  type CarForm, type CustomerForm, type OrderStatus, type Quote, type TrackingView,
} from "@brookclean/shared";

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

  if (path === "/api/orders" && method === "POST") {
    const { car, customer, consents } = body as { car: CarForm; customer: CustomerForm; consents: Record<string, boolean> };
    const errors = { ...validateCar(car), ...validateCustomer(customer) };
    if (Object.keys(errors).length) return fail(400, "Проверьте поля", errors);
    if (!consents?.contract || !consents?.pep || !consents?.personalData) return fail(400, "Нужны все три согласия");
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
    return ok(publicOrder(o, await sha256(JSON.stringify({ no: o.no, car: o.car, customer: o.customer, quote: o.quote }))));
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
