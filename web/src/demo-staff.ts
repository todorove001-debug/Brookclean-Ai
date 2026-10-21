// Демо панели управления: примерные заявки и рейсы, вход под любой ролью с паролем «demo».
import {
  BODY, ROLES, can, isRole, kmTo, normalizePhone, parseRub, quote, routeFor, validateCar, validateCustomer,
  type CarForm, type CustomerForm, type OrderRowView, type OrderStatus, type Permission, type Role, type StaffMe, type TripView,
} from "@brookclean/shared";

type Res = { status: number; data: unknown };
const ok = (data: unknown): Res => ({ status: 200, data });
const fail = (status: number, error: string, errors?: unknown): Res => ({ status, data: { error, errors } });

interface Row extends OrderRowView { fio: string; fullPhone: string }

const users = [
  { id: 1, name: "Евгений", login: "owner", role: "owner" as Role, active: true, createdAt: "2026-10-01T00:00:00Z" },
  { id: 2, name: "Анна", login: "manager", role: "manager" as Role, active: true, createdAt: "2026-10-02T00:00:00Z" },
  { id: 3, name: "Ирина", login: "accountant", role: "accountant" as Role, active: true, createdAt: "2026-10-03T00:00:00Z" },
  { id: 4, name: "Ольга", login: "acceptor", role: "acceptor" as Role, active: true, createdAt: "2026-10-04T00:00:00Z" },
];
let me: StaffMe | null = null;

function seedRow(no: number, date: string, car: string, vin: string, year: number, color: string, body: keyof typeof BODY, city: string,
  fio: string, phone: string, cashback: number, value: number, partner: string | null, tripId: string | null, extra: Partial<Row> = {}): Row {
  const q = quote({ city, body, value, cashback });
  return {
    no, id: "demo-" + no, createdAt: date, status: tripId === "R-01" ? "in_transit" : tripId ? "loading" : "signed", car, vin, year: String(year), color,
    body: BODY[body].name, city, client: fio, phone, fio, fullPhone: phone, partner, tariff: q.tariff, cashback, delivery: q.delivery, value,
    insurance: q.insurance, total: q.total, paidDelivery: false, paidInsurance: false, payTo: "", payForm: "", tripId,
    trackToken: null, signedAt: date, ...extra,
  };
}

const rows: Row[] = [
  seedRow(684, "2026-10-21T09:10:00Z", "Toyota Yaris", "KSP210-0089458", 2023, "Белый", "sedan", "Новосибирск", "Юферов Павел Юрьевич", "+79135550053", 5000, 1000000, null, "R-01"),
  seedRow(683, "2026-10-21T08:40:00Z", "Toyota Yaris", "KSP210-0094312", 2023, "Чёрный", "sedan", "Кемерово", "Юферов Павел Юрьевич", "+79135550053", 5000, 1000000, null, "R-01"),
  seedRow(682, "2026-10-21T07:15:00Z", "Toyota Corolla Cross", "ZVG11-1068109", 2023, "Белый", "cross", "Краснодар", "Бойков Андрей Алексеевич", "+79605550036", 10000, 3000000, "Роман · Монстеркар", "R-02"),
  seedRow(681, "2026-10-21T06:00:00Z", "Suzuki Swift", "ZCEDS-102835", 2024, "Салатовый", "sedan", "Краснодар", "Тагаева Людмила Геннадьевна", "+79295550094", 20000, 1800000, "Роман · Монстеркар", "R-02"),
  seedRow(680, "2026-10-20T12:30:00Z", "Subaru Forester", "SKE-054317", 2021, "Белый", "cross", "Москва", "Конорев Сергей Александрович", "+79935550064", 10000, 2450000, null, "R-03"),
  seedRow(679, "2026-10-20T10:20:00Z", "BMW 218i", "WBA2A32050VZ51833", 2014, "Белый", "sedan", "Кемерово", "Карпиков Алексей Игоревич", "+79025550038", 0, 1000000, null, "R-01",
    { paidDelivery: true, paidInsurance: true, payTo: "Тодоров", payForm: "нал" }),
  seedRow(678, "2026-10-20T09:00:00Z", "Honda Fit", "GS4-1009355", 2023, "Серебристый", "sedan", "Красноярск", "Жаворонкова Людмила Викторовна", "+79085550068", 10000, 1050000, null, "R-01",
    { paidDelivery: true, payTo: "Ким", payForm: "перевод" }),
];

const trips: TripView[] = [
  { id: "R-01", dest: "Новосибирск", truck: "Volvo FH · А 482 КР 125", driver: "Сергей", loadDate: "2026-10-21", km: 760, status: "in_transit",
    orders: [], driveUrl: null, driveError: null, driveSyncedAt: null,
    events: [{ at: "2026-10-20T20:10:00Z", city: "Владивосток", note: "Погружен, выехал" }, { at: "2026-10-21T08:40:00Z", city: "Хабаровск", note: "В пути" }] },
  { id: "R-02", dest: "Краснодар", truck: "Scania R · В 117 ОМ 125", driver: "Алексей", loadDate: "2026-10-23", km: 0, status: "loading",
    orders: [], driveUrl: null, driveError: null, driveSyncedAt: null, events: [] },
  { id: "R-03", dest: "Москва", truck: "MAN TGX · Е 905 УА 125", driver: "Дмитрий", loadDate: "2026-10-24", km: 0, status: "loading",
    orders: [], driveUrl: null, driveError: null, driveSyncedAt: null, events: [] },
];

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
function tripView(t: TripView): TripView {
  const status = t.km >= kmTo(t.dest) && t.km > 0 ? "arrived" : t.km > 0 ? "in_transit" : "loading";
  return { ...t, status, orders: rows.filter((r) => r.tripId === t.id).map((r) => r.no).sort() };
}
const need = (p: Permission) => (!me ? fail(401, "Войдите в панель") : !can(me.role, p) ? fail(403, "Нет доступа к этому разделу") : null);

export function demoStaffFetch(path: string, method: string, body: any): Res {
  let m: RegExpExecArray | null;
  if (path === "/api/staff/login") {
    const u = users.find((x) => x.login === String(body?.login).toLowerCase() && x.active);
    if (!u || body?.password !== "demo") return fail(401, "Неверный логин или пароль. В демо пароль: demo");
    me = { id: u.id, name: u.name, login: u.login, role: u.role, perms: [...ROLES[u.role].perms] };
    return ok(me);
  }
  if (path === "/api/staff/logout") return (me = null), ok({ ok: true });
  if (path === "/api/staff/me") return me ? ok(me) : fail(401, "Войдите в панель");

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
    if (("status" in b || "tripId" in b) && !can(me!.role, "orders.edit")) return fail(403, "Нет доступа к этому полю");
    if (["paidDelivery", "paidInsurance", "payTo", "payForm"].some((k) => k in b) && !can(me!.role, "payments.edit")) return fail(403, "Нет доступа к этому полю");
    Object.assign(r, b);
    if ("tripId" in b && b.tripId && (r.status === "signed" || r.status === "paid")) r.status = "loading";
    if (r.paidDelivery && r.paidInsurance && r.status === "signed") r.status = "paid";
    return ok(view(r));
  }

  if (path === "/api/staff/trips") return need("trips.read") ?? ok(trips.map(tripView));
  if ((m = /^\/api\/staff\/trips\/([\w-]+)$/.exec(path)) && method === "PUT") {
    const denied = need("trips.edit");
    if (denied) return denied;
    let t = trips.find((x) => x.id === m![1]);
    if (!t) trips.unshift((t = { id: m[1], dest: body.dest, truck: "", driver: "", loadDate: null, km: 0, status: "loading", orders: [], driveUrl: null, driveError: null, driveSyncedAt: null, events: [] }));
    Object.assign(t, { dest: body.dest, truck: body.truck, driver: body.driver, loadDate: body.loadDate || null });
    return ok(tripView(t));
  }
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/position$/.exec(path))) {
    const denied = need("trips.edit");
    if (denied) return denied;
    const t = trips.find((x) => x.id === m![1])!;
    if (!routeFor(t.dest).includes(body.city)) return fail(400, "Город не на маршруте рейса");
    t.km = kmTo(body.city);
    t.events.push({ at: new Date().toISOString(), city: body.city, note: body.note || (t.km ? "В пути" : "Погрузка") });
    for (const r of rows.filter((x) => x.tripId === t.id && x.status !== "delivered"))
      r.status = (t.km >= kmTo(r.city) ? "arrived" : t.km > 0 ? "in_transit" : "loading") as OrderStatus;
    return ok(tripView(t));
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
    const u = { id: users.length + 1, name: body.name, login: body.login.toLowerCase(), role: body.role, active: true, createdAt: new Date().toISOString() };
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
