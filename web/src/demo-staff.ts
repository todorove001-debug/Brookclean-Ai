// Демо панели управления: примерные заявки и рейсы, вход под любой ролью с паролем «demo».
import {
  BODY, CAPACITY, EXPENSE_KINDS, legShare, NET, ROLES, can, isRole, kmTo, normalizePhone, parseRub, routeFor, validateCar, validateCustomer,
  type CarForm, type CustomerForm, type OrderRowView, type ExpenseKind, type OrderStatus, type Permission, type Role, type StaffMe,
  type TripCar, type TripExpense, type TripReport, type TripView,
} from "@brookclean/shared";
import { quote } from "../../server/src/pricing.ts";
import { partnerRequests } from "./demo-partners.ts";
import { demoActsFetch, seedActs } from "./demo-acts.ts";
import { demoDriverCard, demoFleetFetch, seedFleet } from "./demo-fleet.ts";

type Res = { status: number; data: unknown };
const ok = (data: unknown): Res => ({ status: 200, data });
const fail = (status: number, error: string, errors?: unknown): Res => ({ status, data: { error, errors } });

export interface Row extends OrderRowView { fio: string; fullPhone: string; deliveredAt?: string | null }

export const users = [
  { id: 1, name: "Евгений", login: "owner", role: "owner" as Role, active: true, createdAt: "2026-10-01T00:00:00Z", site: null as string | null, pending: false, phone: null as string | null },
  { id: 2, name: "Анна", login: "manager", role: "manager" as Role, active: true, createdAt: "2026-10-02T00:00:00Z", site: null, pending: false, phone: null },
  { id: 3, name: "Ирина", login: "accountant", role: "accountant" as Role, active: true, createdAt: "2026-10-03T00:00:00Z", site: null, pending: false, phone: null },
  { id: 4, name: "Ольга", login: "acceptor", role: "acceptor" as Role, active: true, createdAt: "2026-10-04T00:00:00Z", site: "Владивосток", pending: false, phone: null },
  { id: 5, name: "Сергей", login: "driver", role: "driver" as Role, active: true, createdAt: "2026-10-05T00:00:00Z", site: null, pending: false, phone: null },
  { id: 7, name: "Ким Олег Сергеевич", login: "+79140007788", role: "driver" as Role, active: false, createdAt: "2026-10-22T09:00:00Z", site: null, pending: true, phone: "+79140007788" },
  { id: 6, name: "Андрей", login: "terminal", role: "acceptor" as Role, active: true, createdAt: "2026-10-06T00:00:00Z", site: "Новосибирск", pending: false, phone: null },
];
let me: StaffMe | null = null;

function seedRow(no: number, date: string, car: string, vin: string, year: number, color: string, body: keyof typeof BODY, city: string,
  fio: string, phone: string, cashback: number, value: number, partner: string | null, tripId: string | null, extra: Partial<Row> = {}): Row {
  const q = quote({ city, body, value, cashback });
  return {
    no, id: "demo-" + no, createdAt: date, status: tripId === "R-01" ? "in_transit" : tripId ? "loading" : "signed", car, vin, year: String(year), color,
    body: BODY[body].name, city, client: fio, phone, fio, fullPhone: phone, partner, tariff: q.tariff, cashback, delivery: q.delivery, value,
    insurance: q.insurance, total: q.total, paidDelivery: false, paidInsurance: false, payTo: "", payForm: "", tripId,
    transfer: null, trip2Id: null, trackToken: null, signedAt: date, policyNo: "", ...extra,
  };
}

const rows: Row[] = [
  seedRow(686, "2026-10-22T03:20:00Z", "Mazda CX-5", "KF5P-512345", 2020, "Красный", "cross", "Екатеринбург", "Сидоренко Виктор Павлович", "+79145550021", 0, 2100000, null, null),
  seedRow(685, "2026-10-21T10:05:00Z", "Mazda CX-5", "KF5P-451207", 2022, "Красный", "cross", "Иркутск", "Дорохова Елена Сергеевна", "+79025550071", 0, 2600000, null, null),
  seedRow(684, "2026-10-21T09:10:00Z", "Toyota Yaris", "KSP210-0089458", 2023, "Белый", "sedan", "Новосибирск", "Юферов Павел Юрьевич", "+79135550053", 5000, 1000000, null, "R-01"),
  seedRow(683, "2026-10-21T08:40:00Z", "Toyota Yaris", "KSP210-0094312", 2023, "Чёрный", "sedan", "Кемерово", "Юферов Павел Юрьевич", "+79135550053", 5000, 1000000, null, "R-01"),
  // Перегруз в Новосибирске: до терминала рейсом R-01, дальше R-02. №682 уже на площадке терминала, №681 едет к нему
  seedRow(682, "2026-10-21T07:15:00Z", "Toyota Corolla Cross", "ZVG11-1068109", 2023, "Белый", "cross", "Краснодар", "Бойков Андрей Алексеевич", "+79605550036", 10000, 3000000, "Роман · Монстеркар", "R-01",
    { transfer: "Новосибирск", trip2Id: "R-02" }),
  seedRow(681, "2026-10-21T06:00:00Z", "Suzuki Swift", "ZCEDS-102835", 2024, "Салатовый", "sedan", "Краснодар", "Тагаева Людмила Геннадьевна", "+79295550094", 20000, 1800000, "Роман · Монстеркар", "R-01",
    { transfer: "Новосибирск", trip2Id: "R-02" }),
  seedRow(680, "2026-10-20T12:30:00Z", "Subaru Forester", "SKE-054317", 2021, "Белый", "cross", "Москва", "Конорев Сергей Александрович", "+79935550064", 10000, 2450000, null, "R-03"),
  seedRow(679, "2026-10-20T10:20:00Z", "BMW 218i", "WBA2A32050VZ51833", 2014, "Белый", "sedan", "Кемерово", "Карпиков Алексей Игоревич", "+79025550038", 0, 1000000, null, "R-01",
    { paidDelivery: true, paidInsurance: true, payTo: "Тодоров", payForm: "нал" }),
  seedRow(678, "2026-10-20T09:00:00Z", "Honda Fit", "GS4-1009355", 2023, "Серебристый", "sedan", "Красноярск", "Жаворонкова Людмила Викторовна", "+79085550068", 10000, 1050000, null, "R-01",
    { paidDelivery: true, payTo: "Ким", payForm: "перевод" }),
];

export type DemoTrip = Omit<TripView, "status" | "orders" | "expensesTotal" | "editable" | "seats"> & { expenses: TripExpense[] };
const blank = {
  driverId: null, odometerStart: null, odometerEnd: null, closedAt: null, driveUrl: null, driveError: null, driveSyncedAt: null,
  trailer: "", carrier: "собственный", regDriverId: null, formedAt: null, advance: 0, reportStatus: "draft" as const, reportComment: "", submittedAt: null, acceptedAt: null,
};
const trips: DemoTrip[] = [
  { ...blank, id: "R-01", dest: "Новосибирск", truck: "Volvo FH · А 482 КР 125", driver: "Сергей", driverId: 5, loadDate: "2026-10-21", km: 760, odometerStart: 412300,
    trailer: "LUXUDA LZC9407BG · ОО 5642 25", regDriverId: 1, formedAt: "2026-10-20T19:00:00Z", advance: 120000,
    events: [{ at: "2026-10-20T20:10:00Z", city: "Владивосток", note: "Погружен, выехал" }, { at: "2026-10-21T08:40:00Z", city: "Хабаровск", note: "В пути" }],
    expenses: [
      { id: 1, at: "2026-10-20T20:30:00Z", kind: "fuel", amount: 21600, liters: 300, note: "АЗС Роснефть, Владивосток", by: "Сергей" },
      { id: 2, at: "2026-10-21T08:55:00Z", kind: "parking", amount: 400, liters: null, note: "Стоянка, Хабаровск", by: "Сергей" },
    ] },
  { ...blank, id: "R-02", dest: "Краснодар", truck: "Scania R · В 117 ОМ 125", driver: "Смирнов Алексей Викторович", loadDate: "2026-10-23", km: 0, events: [], expenses: [],
    trailer: "LOHR S2M52X · АО 0802 25", regDriverId: 2, advance: 150000 },
  { ...blank, id: "R-03", dest: "Москва", truck: "MAN TGX · Е 905 УА 54", driver: "Волков Дмитрий Олегович", loadDate: "2026-10-24", km: 0, events: [], expenses: [],
    trailer: "LUXUDA LZC9405BG · АО 2148 54", carrier: "ООО «Сибирь-Транзит» (пример)", regDriverId: 3, advance: 150000 },
];
let expenseId = 10;
seedActs(rows, trips);
seedFleet();

const reviews = [
  { no: 671, client: "Петров Илья Сергеевич", phone: "+79145550012", rating: 2, text: "Задержали на неделю, никто не предупредил.", createdAt: "2026-10-18T10:00:00Z" },
  { no: 664, client: "Ли Анна Викторовна", phone: "+79245550077", rating: 5, text: "Всё быстро, машина без единой царапины. Спасибо!", createdAt: "2026-10-15T09:00:00Z" },
];
const links = [{ token: "rm7k2p9q4x", partner: "Роман · Монстеркар", cashback: 15000, createdAt: "2026-10-10T00:00:00Z" }];

const shortName = (fio: string) => {
  const [f, i, o] = fio.split(/\s+/);
  return [f, i ? i[0] + "." : "", o ? o[0] + "." : ""].filter(Boolean).join(" ");
};
const maskPhone = (p: string) => `${p.slice(0, 2)} ${p.slice(2, 5)} ***-**-${p.slice(-2)}`;

function view(r: Row): OrderRowView {
  const personal = me && can(me.role, "orders.personal");
  const { fio, fullPhone, ...rest } = r;
  return { ...rest, client: personal ? fio : shortName(fio), phone: personal ? fullPhone : maskPhone(fullPhone) };
}
const canSee = (t: DemoTrip) => !!me && (can(me.role, "trips.read") || (can(me.role, "trips.driver") && t.driverId === me.id));
const canEdit = (t: DemoTrip) => !!me && (can(me.role, "trips.edit") || (can(me.role, "trips.driver") && t.driverId === me.id && !t.closedAt));
function tripView(t: DemoTrip): TripView {
  const status = t.km >= kmTo(t.dest) && t.km > 0 ? "arrived" : t.km > 0 ? "in_transit" : "loading";
  const { expenses, ...rest } = t;
  const orders = rows.filter((r) => r.tripId === t.id || r.trip2Id === t.id).map((r) => r.no).sort();
  return { ...rest, status, orders, seats: CAPACITY - orders.length, expensesTotal: expenses.reduce((s, e) => s + e.amount, 0), editable: canEdit(t) };
}
const STATUS_RU: Record<string, string> = { signed: "Подписан", paid: "Оплачен", loading: "Погрузка", in_transit: "В пути", arrived: "Прибыл", delivered: "Выдан" };
function report(t: DemoTrip): TripReport {
  const finance = can(me!.role, "reports.read");
  const mine = rows.filter((r) => r.tripId === t.id || r.trip2Id === t.id);
  const cars = mine.sort((a, b) => a.no - b.no).map((r): TripCar => {
    const base = { no: r.no, car: r.car, vin: r.vin, year: r.year, color: r.color, city: r.city, km: kmTo(r.city), client: shortName(r.fio), phone: maskPhone(r.fullPhone), status: STATUS_RU[r.status] ?? r.status };
    return finance ? { ...base, delivery: r.delivery, insurance: r.insurance, total: r.total, paidDelivery: r.paidDelivery, paidInsurance: r.paidInsurance, payTo: r.payTo, payForm: r.payForm } : base;
  });
  const byKind: TripReport["totals"]["byKind"] = {};
  for (const e of t.expenses) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.amount;
  const sum = (f: (c: TripCar) => number) => cars.reduce((s, c) => s + f(c), 0);
  const spent = t.expenses.reduce((s, e) => s + e.amount, 0);
  const revenue = mine.reduce((s, r) => s + r.delivery * legShare(!r.transfer ? null : r.tripId === t.id ? 1 : 2, kmTo(r.transfer ?? r.city), kmTo(r.city)), 0);
  return {
    trip: tripView(t), cars, expenses: t.expenses, finance,
    totals: {
      cars: cars.length, expenses: spent, balance: t.advance - spent, byKind,
      fuelLiters: t.expenses.reduce((s, e) => s + (e.liters ?? 0), 0),
      mileage: t.odometerStart !== null && t.odometerEnd !== null ? t.odometerEnd - t.odometerStart : null,
      ...(finance ? { delivery: sum((c) => c.delivery!), insurance: sum((c) => c.insurance!),
        unpaid: sum((c) => (c.paidDelivery ? 0 : c.delivery!) + (c.paidInsurance ? 0 : c.insurance!)), revenue: Math.round(revenue) } : {}),
    },
  };
}
const needAny = (...ps: Permission[]) => (!me ? fail(401, "Войдите в панель") : !ps.some((p) => can(me!.role, p)) ? fail(403, "Нет доступа к этому разделу") : null);
/** Рейс из адреса с проверкой доступа, как на сервере. */
function tripFor(id: string, edit: boolean): DemoTrip | Res {
  const denied = needAny("trips.read", "trips.driver");
  if (denied) return denied;
  const t = trips.find((x) => x.id === id);
  if (!t || !canSee(t)) return fail(404, "Рейс не найден");
  if (edit && !canEdit(t)) return fail(403, t.closedAt ? "Рейс закрыт" : "Нет доступа к этому рейсу");
  return t;
}
const isRes = (x: DemoTrip | Res): x is Res => "status" in x && "data" in x;
/** Отчёт сдан или принят: водитель больше не меняет расходы и одометр. */
const locked = (t: DemoTrip) => !can(me!.role, "trips.edit") && (t.reportStatus === "submitted" || t.reportStatus === "accepted");
function seatError(tripId: string, no: number) {
  const t = trips.find((x) => x.id === tripId);
  if (t?.formedAt) return `Рейс ${tripId} сформирован: сначала верните его в формирование`;
  if (rows.filter((r) => r.no !== no && (r.tripId === tripId || r.trip2Id === tripId)).length >= CAPACITY) return `В рейсе ${tripId} нет мест: занято ${CAPACITY} из ${CAPACITY}`;
  return "";
}
const need = (p: Permission) => (!me ? fail(401, "Войдите в панель") : !can(me.role, p) ? fail(403, "Нет доступа к этому разделу") : null);

export function demoStaffFetch(path: string, method: string, body: any): Res {
  let m: RegExpExecArray | null;
  if (path === "/api/staff/login") {
    const login = String(body?.login).toLowerCase(), asPhone = normalizePhone(login);
    const u = users.find((x) => (x.login === login || (asPhone && x.login === asPhone)) && (x.active || x.pending));
    if (!u || body?.password !== "demo") return fail(401, "Неверный логин или пароль. В демо пароль: demo");
    if (u.pending) return fail(403, "Заявка на доступ ждёт подтверждения менеджером");
    me = { id: u.id, name: u.name, login: u.login, role: u.role, perms: [...ROLES[u.role].perms], site: u.site };
    return ok(me);
  }
  if (path === "/api/staff/logout") return (me = null), ok({ ok: true });
  if (path === "/api/staff/me") return me ? ok(me) : fail(401, "Войдите в панель");

  if (path.startsWith("/api/staff/acts")) return demoActsFetch(path, method, body, me, rows, trips);
  const fleet = demoFleetFetch(path, method, body, { me, rows, trips, users, tripFor, isRes, tripView, report });
  if (fleet) return fleet;
  if (path === "/api/staff/quote") {
    const denied = need("orders.create");
    if (denied) return denied;
    const car = body.car as CarForm;
    return ok(quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback: Number(body.cashback) || 0 }));
  }
  if (path === "/api/staff/partner-requests") return need("partners.edit") ?? ok(partnerRequests);
  if ((m = /^\/api\/staff\/partner-requests\/(\d+)$/.exec(path))) {
    const denied = need("partners.edit");
    if (denied) return denied;
    const r = partnerRequests.find((x) => x.id === Number(m![1]));
    if (!r) return fail(404, "Заявка не найдена");
    r.status = body.status;
    r.reviewedAt = new Date().toISOString();
    return ok(r);
  }
  if (path === "/api/staff/security") return need("security.manage") ?? ok({ events: [], suspects: [], blocked: [] });
  if (path.startsWith("/api/staff/security/")) return need("security.manage") ?? fail(400, "В демо блокировки не сохраняются");
  if (path === "/api/staff/orders" && method === "GET") return need("orders.read") ?? ok(rows.map(view));
  if (path === "/api/staff/orders" && method === "POST") {
    const denied = need("orders.create");
    if (denied) return denied;
    const { car, customer } = body as { car: CarForm; customer: CustomerForm };
    const errors = { ...validateCar(car), ...validateCustomer(customer) };
    if (Object.keys(errors).length) return fail(400, "Проверьте поля", errors);
    const no = Math.max(...rows.map((r) => r.no)) + 1;
    const r = seedRow(no, new Date().toISOString(), car.car, car.vin.toUpperCase(), Number(car.year), car.color, car.body, car.city, customer.fio,
      normalizePhone(customer.phone), parseRub(String(body.cashback ?? 0)), parseRub(car.value), body.partner || null, null, { status: "draft", signedAt: null });
    rows.unshift(r);
    return ok({ id: r.id, no, quote: quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback: r.cashback }),
      signUrl: `https://brookclean-reg.ru/o/${r.id}`, smsSent: true });
  }
  if ((m = /^\/api\/staff\/orders\/(\d+)$/.exec(path)) && method === "PATCH") {
    const r = rows.find((x) => x.no === Number(m![1]));
    if (!r) return fail(404, "Заявка не найдена");
    const b = body ?? {};
    if (["status", "tripId", "transfer", "trip2Id"].some((k) => k in b) && !can(me!.role, "orders.edit")) return fail(403, "Нет доступа к этому полю");
    if (["paidDelivery", "paidInsurance", "payTo", "payForm", "policyNo"].some((k) => k in b) && !can(me!.role, "payments.edit")) return fail(403, "Нет доступа к этому полю");
    for (const id of [b.tripId, b.trip2Id]) {
      const full = id && seatError(id, r.no);
      if (full) return fail(409, full);
    }
    if ("tripId" in b && r.tripId && r.tripId !== b.tripId && trips.find((t) => t.id === r.tripId)?.formedAt) return fail(409, `Рейс ${r.tripId} сформирован: сначала верните его в формирование`);
    Object.assign(r, b);
    if (b.status === "delivered") r.deliveredAt ??= new Date().toISOString();
    if ("tripId" in b && b.tripId && (r.status === "signed" || r.status === "paid")) r.status = "loading";
    if (r.paidDelivery && r.paidInsurance && r.status === "signed") r.status = "paid";
    return ok(view(r));
  }

  if (path === "/api/staff/trips" && method === "GET")
    return needAny("trips.read", "trips.driver") ?? ok(trips.filter(canSee).sort((a, b) => Number(!!a.closedAt) - Number(!!b.closedAt)).map(tripView));
  if (path === "/api/staff/drivers") return need("trips.edit") ?? ok(users.filter((u) => u.role === "driver" && u.active).map(({ id, name }) => ({ id, name })));
  if (path === "/api/staff/trips" && method === "POST") {
    const denied = needAny("trips.edit", "trips.driver");
    if (denied) return denied;
    const manager = can(me!.role, "trips.edit");
    const card = manager && body.regDriverId ? demoDriverCard(Number(body.regDriverId)) : undefined;
    if (card) {
      body.truck ||= [card.tractorModel, card.tractorPlate].filter(Boolean).join(" · ");
      body.trailer ||= [card.trailerModel, card.trailerPlate].filter(Boolean).join(" · ");
      body.carrier ||= card.own ? "собственный" : card.companyName || "наёмный";
      body.driver = card.name;
    }
    if (!NET[body?.dest] || !String(body?.truck ?? "").trim()) return fail(400, "Укажите город назначения и автовоз");
    const d = manager && body.driverId ? users.find((u) => u.id === Number(body.driverId) && u.role === "driver") : undefined;
    let n = trips.length + 1;
    while (trips.some((t) => t.id === `R-${String(n).padStart(2, "0")}`)) n++;
    const t: DemoTrip = { ...blank, id: `R-${String(n).padStart(2, "0")}`, dest: body.dest, truck: body.truck.trim(),
      driver: manager ? d?.name ?? String(body.driver ?? "").trim() : me!.name, driverId: manager ? d?.id ?? null : me!.id,
      loadDate: body.loadDate || null, km: 0, odometerStart: body.odometerStart ?? null, events: [], expenses: [],
      trailer: String(body.trailer ?? ""), carrier: String(body.carrier ?? ""), regDriverId: card?.id ?? null,
      advance: manager ? Number(String(body.advance ?? 0).replace(/\D/g, "")) || 0 : 0 };
    trips.unshift(t);
    return ok(tripView(t));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)$/.exec(path)) && method === "PATCH") {
    const reopening = body?.closed === false;
    if (reopening && !can(me!.role, "trips.edit")) return fail(403, "Открыть закрытый рейс может менеджер");
    const t = tripFor(m[1], !reopening);
    if (isRes(t)) return t;
    if (("odometerStart" in body || "odometerEnd" in body) && locked(t)) return fail(409, "Отчёт сдан на проверку: изменения недоступны");
    const start = "odometerStart" in body ? body.odometerStart : t.odometerStart;
    const end = "odometerEnd" in body ? body.odometerEnd : t.odometerEnd;
    if (start !== null && end !== null && end < start) return fail(400, "Одометр в конце меньше, чем в начале");
    if (body.closed === true && end === null) return fail(400, "Перед закрытием укажите одометр в конце рейса");
    Object.assign(t, { odometerStart: start, odometerEnd: end });
    if (body.closed === true) t.closedAt = new Date().toISOString();
    if (reopening) t.closedAt = null;
    return ok(tripView(t));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/position$/.exec(path))) {
    const t = tripFor(m[1], true);
    if (isRes(t)) return t;
    if (!routeFor(t.dest).includes(body.city)) return fail(400, "Город не на маршруте рейса");
    t.km = kmTo(body.city);
    t.events.push({ at: new Date().toISOString(), city: body.city, note: body.note || (t.km ? "В пути" : "Погрузка") });
    for (const r of rows.filter((x) => x.tripId === t.id && x.status !== "delivered"))
      r.status = (t.km >= kmTo(r.city) ? "arrived" : t.km > 0 ? "in_transit" : "loading") as OrderStatus;
    return ok(tripView(t));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/report$/.exec(path))) {
    const t = tripFor(m[1], false);
    return isRes(t) ? t : ok(report(t));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/waiting$/.exec(path))) {
    const t = tripFor(m[1], true);
    if (isRes(t)) return t;
    const route = routeFor(t.dest);
    return ok(rows.filter((r) => !r.tripId && (r.status === "signed" || r.status === "paid") && route.includes(r.city))
      .map((r) => ({ no: r.no, car: `${r.car} ${r.year}`, vin: r.vin, city: r.city, status: r.status })));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/cars$/.exec(path))) {
    const t = tripFor(m[1], true);
    if (isRes(t)) return t;
    const r = rows.find((x) => x.no === Number(body?.no));
    if (!r) return fail(404, "Заявка не найдена");
    if (body.load) {
      if (r.tripId) return fail(409, "Машина уже в рейсе " + r.tripId);
      const full = seatError(t.id, r.no);
      if (full) return fail(409, full);
      r.tripId = t.id;
      r.status = "loading";
    } else {
      if (t.formedAt) return fail(409, `Рейс ${t.id} сформирован: сначала верните его в формирование`);
      r.tripId = null;
      if (r.status === "loading") r.status = "signed";
    }
    return ok(tripView(t));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/expenses$/.exec(path))) {
    const t = tripFor(m[1], true);
    if (isRes(t)) return t;
    if (locked(t)) return fail(409, "Отчёт сдан на проверку: изменения недоступны");
    const amount = Math.round(Number(body?.amount));
    if (!(body?.kind in EXPENSE_KINDS)) return fail(400, "Выберите вид расхода");
    if (!(amount > 0)) return fail(400, "Сумма в рублях больше нуля");
    t.expenses.push({ id: ++expenseId, at: new Date().toISOString(), kind: body.kind as ExpenseKind, amount,
      liters: body.kind === "fuel" && body.liters ? Number(body.liters) : null, note: String(body.note ?? "").trim(), by: me!.name });
    return ok(report(t));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/expenses\/(\d+)$/.exec(path))) {
    const t = tripFor(m[1], true);
    if (isRes(t)) return t;
    if (locked(t)) return fail(409, "Отчёт сдан на проверку: изменения недоступны");
    t.expenses = t.expenses.filter((e) => e.id !== Number(m![2]));
    return ok(report(t));
  }
  if (path === "/api/staff/recognize") {
    // В демо ответ подставлен заранее; на сервере фото читает Yandex AI Studio. ФП прочитан с ошибкой, как бывает у модели.
    return ok({
      kind: "receipt", model: "демо", ms: 4200, fromQr: [],
      fields: { date: "21.10.2026", time: "19:05", seller: "АЗС №12 «ДВ-Ойл»", city: "Хабаровск", category: "fuel", description: "ДТ-Л-К5, 160 л × 72,10",
        liters: "160", amount: "11536", fn: "7380440700123456", fd: "48211", fp: "3912345678" },
      checks: [
        { field: "amount", level: "ok", msg: "Два прочтения совпали" },
        { field: "fd", level: "ok", msg: "Два прочтения совпали" },
        { field: "fp", level: "error", msg: "Два прочтения разошлись: «3912345678» и «3912346578». Сверьте с фото", suggest: "3912346578" },
      ],
    });
  }
  if (path === "/api/staff/google") return need("reports.read") ?? ok({ configured: false, connected: false, folderUrl: null });

  if (path === "/api/staff/reviews") {
    const denied = need("reviews.read");
    if (denied) return denied;
    const personal = can(me!.role, "orders.personal");
    return ok(reviews.map((r) => ({ ...r, client: personal ? r.client : shortName(r.client), phone: personal ? r.phone : maskPhone(r.phone) })));
  }
  if (path === "/api/staff/partner-links" && method === "GET") return need("partners.edit") ?? ok(links);
  if (path === "/api/staff/partner-links") {
    const denied = need("partners.edit");
    if (denied) return denied;
    const token = Math.random().toString(36).slice(2, 12);
    links.unshift({ token, partner: body.partner, cashback: Number(body.cashback) || 0, createdAt: new Date().toISOString() });
    return ok({ token, url: `https://brookclean-reg.ru/?p=${token}` });
  }

  if (path === "/api/staff/users" && method === "GET") return need("staff.manage") ?? ok(users);
  if (path === "/api/staff/users") {
    const denied = need("staff.manage");
    if (denied) return denied;
    if (!body.name || !body.login) return fail(400, "Укажите имя и логин");
    if (!body.password || body.password.length < 8) return fail(400, "Пароль не короче 8 символов");
    if (!isRole(body.role)) return fail(400, "Выберите роль");
    const u = { id: users.length + 1, name: body.name, login: body.login.toLowerCase(), role: body.role, active: true, createdAt: new Date().toISOString(),
      site: body.role === "acceptor" ? body.site ?? "Владивосток" : null, pending: false, phone: null };
    users.push(u);
    return ok(u);
  }
  if ((m = /^\/api\/staff\/users\/(\d+)$/.exec(path))) {
    const denied = need("staff.manage");
    if (denied) return denied;
    const u = users.find((x) => x.id === Number(m![1]))!;
    const owners = users.filter((x) => x.role === "owner" && x.active).length;
    if (u.role === "owner" && owners <= 1 && ((body.role && body.role !== "owner") || body.active === false)) return fail(400, "Нельзя убрать последнего владельца");
    if (body.password !== undefined && body.password.length < 8) return fail(400, "Пароль не короче 8 символов");
    const { password: _p, ...rest } = body;
    Object.assign(u, rest);
    return ok(u);
  }
  return fail(404, "В демо этот раздел не работает");
}
