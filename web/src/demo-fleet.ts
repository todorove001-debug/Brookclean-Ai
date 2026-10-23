// Демо автопарка: реестр водителей, сдача отчёта, формирование рейса, распределение, таблица доставок, регистрация.
// Повторяет проверки сервера (server/src/fleet.ts), данные живут в памяти страницы.
import {
  CAPACITY, HUB, TRANSFER_CITY, can, terminalOf, docsFilled, isSite, kmTo, licExpired, normalizePhone, routeFor,
  type BackhaulRow, type Deliveries, type DistributionItem, type DriverCard, type DriverInput, type Permission, type Role, type StaffMe,
  type TripReport, type TripView,
} from "@brookclean/shared";
import { demoActClosedAt } from "./demo-acts.ts";
import type { DemoTrip, Row, users as Users } from "./demo-staff.ts";

type Res = { status: number; data: unknown };
const ok = (data: unknown): Res => ({ status: 200, data });
const fail = (status: number, error: string, errors?: unknown): Res => ({ status, data: { error, errors } });

type Card = DriverInput & { id: number; site: string; staffId: number | null; active: boolean; importKey: string | null; createdAt: string };
const blankCard = (id: number, own: boolean, site: string = HUB): Card => ({
  id, site, name: "", phone: "", own, group: "", tractorModel: "", tractorPlate: "", trailerModel: "", trailerPlate: "",
  companyName: "", companyInn: "", companyPhone: "", docs: {}, staffId: null, active: true, importKey: null, createdAt: "2026-10-01T00:00:00Z",
});
const cards: Card[] = [];
const backhaul = new Map<string, BackhaulRow[]>();
let seq = 100;

export function seedFleet() {
  if (cards.length) return;
  const c = (id: number, own: boolean, x: Partial<Card>) => cards.push({ ...blankCard(id, own), ...x });
  c(1, true, { name: "Петров Сергей Иванович", phone: "+79140001122", staffId: 5, tractorModel: "Volvo FH", tractorPlate: "А 482 КР 125",
    trailerModel: "LUXUDA LZC9407BG", trailerPlate: "ОО 5642 25",
    docs: { lic: { number: "25 31 123456", categories: "B, C, CE", issue_date: "14.03.2019", valid_until: "14.03.2029", birth_date: "03.05.1985" } } });
  c(2, true, { name: "Смирнов Алексей Викторович", phone: "+79140003344", tractorModel: "Scania R", tractorPlate: "В 117 ОМ 125", trailerModel: "LOHR S2M52X", trailerPlate: "АО 0802 25" });
  c(3, false, { name: "Волков Дмитрий Олегович", phone: "+79140005566", tractorModel: "MAN TGX", tractorPlate: "Е 905 УА 54", trailerModel: "LUXUDA LZC9405BG", trailerPlate: "АО 2148 54",
    companyName: "ООО «Сибирь-Транзит» (пример)", companyInn: "5406000000", companyPhone: "+73830000000", group: "Наёмники", site: TRANSFER_CITY,
    docs: { lic: { number: "25 30 778899", valid_until: "01.09.2026" } } });
  c(4, false, { name: "Гаврилов Игорь Петрович", phone: "+79240001234", tractorModel: "Sitrak C7H", tractorPlate: "Р 117 ТТ 125", trailerModel: "LUXUDA LZC9407BG", trailerPlate: "ОО 7781 25",
    companyName: "ИП Гаврилов И. П. (пример)", companyInn: "253700000000", group: "Наёмники", importKey: "demo-4" });
  c(5, true, { name: "Ким Олег Сергеевич", phone: "+79140007788", staffId: 7, tractorModel: "Shacman X3000", tractorPlate: "Т 418 ОР 54", trailerModel: "LOHR S2M52X", trailerPlate: "АР 3317 54" });
  // Свой водитель терминала Новосибирск: его видит только приёмщик терминала и менеджер
  c(6, true, { name: "Сидоров Андрей Петрович", phone: "+79130004455", site: TRANSFER_CITY, tractorModel: "КАМАЗ 54901", tractorPlate: "К 230 НС 154",
    trailerModel: "LOHR S2M52X", trailerPlate: "НВ 4410 54" });
}
export const demoDriverCard = (id: number) => cards.find((c) => c.id === id && c.active);
export const demoCardOfStaff = (staffId: number) => cards.find((c) => c.staffId === staffId && c.active);

interface Ctx {
  me: StaffMe | null;
  rows: Row[];
  trips: DemoTrip[];
  users: typeof Users;
  tripFor: (id: string, edit: boolean) => DemoTrip | Res;
  isRes: (x: DemoTrip | Res) => x is Res;
  tripView: (t: DemoTrip) => TripView;
  report: (t: DemoTrip) => TripReport;
}

export function demoFleetFetch(path: string, method: string, body: any, ctx: Ctx): Res | null {
  const { me, rows, trips, users } = ctx;
  let m: RegExpExecArray | null;
  const need = (...ps: Permission[]) => (!me ? fail(401, "Войдите в панель") : !ps.every((p) => can(me.role, p)) ? fail(403, "Нет доступа к этому разделу") : null);
  const needAny = (...ps: Permission[]) => (!me ? fail(401, "Войдите в панель") : !ps.some((p) => can(me.role, p)) ? fail(403, "Нет доступа к этому разделу") : null);
  const view = (c: Card): DriverCard => {
    const u = c.staffId ? users.find((x) => x.id === c.staffId) : undefined;
    const { importKey, ...rest } = c;
    return { ...rest, pending: !!u?.pending, fromExcel: !!importKey, tripId: trips.find((t) => t.regDriverId === c.id && !t.closedAt)?.id ?? null,
      docsFilled: docsFilled(c.docs), licExpired: licExpired(c.docs, new Date()) };
  };
  const apply = (c: Card, b: Partial<Card>, self: boolean) => {
    const { docs, own, active, id: _i, staffId: _s, importKey: _k, site: _site, ...rest } = b;
    Object.assign(c, rest);
    if (docs) c.docs = { ...c.docs, ...docs };
    if (!self && own !== undefined) c.own = own;
    if (!self && active !== undefined) c.active = active;
  };

  // --- Реестр: менеджер видит всех, приёмщик терминала — только своих (как scopeOf на сервере) ---
  const scope: string | null | undefined = !me ? null : can(me.role, "drivers.edit") || can(me.role, "trips.edit") ? undefined
    : can(me.role, "drivers.site") ? terminalOf(me) : null;
  const regDenied = () => needAny("drivers.edit", "trips.edit", "drivers.site") ?? (scope === null ? fail(403, "Свой список водителей есть только у терминала перегруза") : null);
  const inScope = (c: Card) => scope == null || c.site === scope;
  if (path === "/api/staff/registry" && method === "GET") return regDenied() ?? ok(cards.filter(inScope).map(view));
  if (path === "/api/staff/registry" && method === "POST") {
    const denied = regDenied();
    if (denied) return denied;
    if (String(body?.name ?? "").trim().length < 3) return fail(400, "Укажите ФИО водителя");
    const c = blankCard(++seq, body.own !== false, scope ?? (isSite(body.site) ? body.site : HUB));
    apply(c, body, false);
    cards.push(c);
    return ok(view(c));
  }
  if (path === "/api/staff/registry/import") {
    const denied = regDenied();
    if (denied) return denied;
    let added = 0, skipped = 0;
    for (const d of body?.drivers ?? []) {
      if (String(d.name ?? "").trim().length < 3 || (d.importKey && cards.some((c) => c.importKey === d.importKey))) {
        skipped++;
        continue;
      }
      const c = blankCard(++seq, d.own !== false, scope ?? HUB);
      apply(c, d, false);
      c.importKey = d.importKey ?? null;
      cards.push(c);
      added++;
    }
    return ok({ added, skipped });
  }
  if (path === "/api/staff/registry/me") {
    const denied = need("trips.driver");
    if (denied) return denied;
    let c = cards.find((x) => x.staffId === me!.id);
    if (method === "GET") return ok(c ? view(c) : null);
    if (!c) cards.push((c = { ...blankCard(++seq, true), name: me!.name, staffId: me!.id }));
    const { name: _n, group: _g, ...rest } = body ?? {};
    apply(c, rest, true);
    return ok(view(c));
  }
  if ((m = /^\/api\/staff\/registry\/(\d+)$/.exec(path))) {
    const denied = regDenied();
    if (denied) return denied;
    const c = cards.find((x) => x.id === Number(m![1]));
    if (!c || !inScope(c)) return fail(404, "Водитель не найден");
    if (scope === undefined && isSite(body?.site)) c.site = body.site;
    if (body?.name !== undefined && String(body.name).trim().length < 3) return fail(400, "Укажите ФИО водителя");
    apply(c, body ?? {}, false);
    return ok(view(c));
  }

  // --- Рейс: аванс, прицеп, перевозчик, формирование, отчёт ---
  if ((m = /^\/api\/staff\/trips\/([\w-]+)\/(meta|form|report\/submit|report\/decision|deliveries|backhaul)(?:\/(\d+))?$/.exec(path))) {
    const [, id, what, bid] = m;
    if (what === "meta" || what === "form" || what === "backhaul") {
      const denied = need("trips.edit");
      if (denied) return denied;
    }
    if (what === "report/decision" || what === "deliveries") {
      const denied = need("reports.read");
      if (denied) return denied;
    }
    const t = ctx.tripFor(id, what === "meta" || what === "form" || what === "report/submit");
    if (ctx.isRes(t)) return t;
    const onTrip = rows.filter((r) => r.tripId === t.id || r.trip2Id === t.id);

    if (what === "meta") {
      if (body.advance !== undefined) {
        if (!(Number(body.advance) >= 0)) return fail(400, "Аванс — сумма в рублях");
        t.advance = Math.round(Number(body.advance));
      }
      for (const k of ["truck", "trailer", "carrier"] as const) if (body[k] !== undefined) t[k] = String(body[k]).trim();
      return ok(ctx.tripView(t));
    }
    if (what === "form") {
      if (body.formed) {
        if (!t.driver && !t.regDriverId) return fail(400, "Чтобы сформировать рейс, назначьте водителя");
        if (!onTrip.length) return fail(400, "Чтобы сформировать рейс, поставьте в него хотя бы одну машину");
        t.formedAt ??= new Date().toISOString();
      } else {
        if (t.km > 0) return fail(409, "Рейс уже в пути: состав не меняется");
        t.formedAt = null;
      }
      return ok(ctx.tripView(t));
    }
    if (what === "report/submit") {
      if (t.reportStatus === "submitted" || t.reportStatus === "accepted") return fail(409, "Отчёт уже сдан");
      if (!t.expenses.length) return fail(400, "Добавьте хотя бы один чек");
      t.reportStatus = "submitted";
      t.submittedAt = new Date().toISOString();
      return ok(ctx.report(t));
    }
    if (what === "report/decision") {
      if (t.reportStatus !== "submitted") return fail(409, "Отчёт ещё не сдан водителем");
      const comment = String(body?.comment ?? "").trim();
      if (!body?.accept && !comment) return fail(400, "Напишите водителю, что исправить");
      t.reportStatus = body.accept ? "accepted" : "returned";
      t.reportComment = comment;
      if (body.accept) t.acceptedAt = new Date().toISOString();
      return ok(ctx.report(t));
    }
    if (what === "backhaul") {
      const list = backhaul.get(t.id) ?? [];
      if (method === "DELETE") backhaul.set(t.id, list.filter((b) => b.id !== Number(bid)));
      else {
        if (!String(body?.car ?? "").trim()) return fail(400, "Укажите автомобиль");
        const price = body.price === null || body.price === undefined || String(body.price) === "" ? null : Math.round(Number(body.price));
        backhaul.set(t.id, [...list, { id: ++seq, car: String(body.car).trim(), vin: String(body.vin ?? "").trim().toUpperCase(), route: String(body.route ?? "").trim(), client: String(body.client ?? "").trim(), price }]);
      }
      return ok(backhaul.get(t.id));
    }
    // Таблица доставок
    const personal = can(me!.role, "orders.personal");
    const kmT = kmTo(TRANSFER_CITY);
    const passed = (tripId: string | null, km: number, strict = false) =>
      trips.find((x) => x.id === tripId)?.events.find((e) => (strict ? kmTo(e.city) > km : kmTo(e.city) >= km))?.at ?? null;
    const card = t.regDriverId ? cards.find((c) => c.id === t.regDriverId) : undefined;
    const result: Deliveries = {
      trip: { id: t.id, dest: t.dest, loadDate: t.loadDate, truck: t.truck, trailer: t.trailer, carrier: t.carrier, driver: t.driver, driverPhone: card?.phone ?? "", formedAt: t.formedAt },
      rows: onTrip.sort((a, b) => a.no - b.no).map((r) => {
        const kmC = kmTo(r.city), first = r.tripId === t.id;
        return {
          no: r.no, createdAt: r.createdAt, status: r.status, car: r.car, vin: r.vin, year: r.year, city: r.city,
          legNote: r.transfer ? (first ? `перегрузка в ${r.transfer}` : `с терминала ${r.transfer}`) : "",
          client: personal ? r.fio : r.client, phone: personal ? r.fullPhone : r.phone, partner: r.partner,
          arrivedTransfer: kmC >= kmT ? passed(r.tripId, kmT) : null,
          leftTransfer: r.transfer ? demoActClosedAt(r.no, "term_out") : kmC > kmT ? passed(r.tripId, kmT, true) : null,
          arrivedCity: passed(r.transfer ? r.trip2Id : r.tripId, kmC), deliveredAt: r.deliveredAt ?? null,
          delivery: r.delivery, cashback: r.cashback, value: r.value, insurance: r.insurance, policyNo: r.policyNo,
          paidDelivery: r.paidDelivery, paidInsurance: r.paidInsurance, payTo: r.payTo, payForm: r.payForm,
        };
      }),
      throughTransfer: onTrip.some((r) => kmTo(r.city) >= kmT),
      backhaul: backhaul.get(t.id) ?? [],
    };
    return ok(result);
  }

  // --- Распределение ---
  if (path === "/api/staff/distribution") {
    const denied = need("trips.edit");
    if (denied) return denied;
    const open = trips.filter((t) => !t.closedAt && !t.formedAt).sort((a, b) => (a.loadDate ?? "9").localeCompare(b.loadDate ?? "9"));
    const pick = (from: string | null, to: string) => open
      .filter((t) => routeFor(t.dest).includes(to) && (!from || routeFor(t.dest).includes(from)) && (from ? t.km < kmTo(from) : t.km === 0))
      .map((t) => ({ id: t.id, dest: t.dest, loadDate: t.loadDate, seats: CAPACITY - rows.filter((r) => r.tripId === t.id || r.trip2Id === t.id).length }))
      .filter((t) => t.seats > 0);
    return ok(rows.filter((r) => r.status !== "draft" && r.status !== "delivered" && (!r.tripId || (r.transfer && !r.trip2Id))).sort((a, b) => a.no - b.no)
      .map((r): DistributionItem => {
        const leg = r.tripId ? 2 : 1;
        return { no: r.no, car: `${r.car} ${r.year}`, city: r.city, transfer: r.transfer, leg, atTerminal: leg === 2 && !!demoActClosedAt(r.no, "term_in"),
          trips: leg === 1 ? pick(null, r.transfer ?? r.city) : pick(r.transfer, r.city) };
      }));
  }

  // --- Регистрация ---
  if (path === "/api/staff/register") {
    const name = String(body?.name ?? "").trim(), phone = normalizePhone(String(body?.phone ?? ""));
    const errors: Record<string, string> = {};
    if (name.split(/\s+/).length < 2) errors.name = "Фамилия, имя и отчество";
    if (!phone) errors.phone = "Номер в формате +7 900 000 00 00";
    if (!body?.password || String(body.password).length < 8) errors.password = "Пароль не короче 8 символов";
    if (body?.role !== "driver" && body?.role !== "acceptor") errors.role = "Выберите: водитель или приёмщик";
    if (body?.role === "acceptor" && !isSite(body.site)) errors.site = "Выберите площадку";
    if (Object.keys(errors).length) return fail(400, "Проверьте поля", errors);
    if (users.some((u) => u.login === phone)) return fail(409, "Этот номер уже зарегистрирован. Войдите или попросите менеджера сбросить пароль.");
    const id = Math.max(...users.map((u) => u.id)) + 1;
    users.push({ id, name, login: phone, role: body.role as Role, active: false, createdAt: new Date().toISOString(),
      site: body.role === "acceptor" ? body.site : null, pending: true, phone });
    if (body.role === "driver") {
      const c = cards.find((x) => x.phone === phone && !x.staffId);
      if (c) c.staffId = id;
      else cards.push({ ...blankCard(++seq, true), name, phone, staffId: id });
    }
    return ok({ ok: true });
  }
  if (path === "/api/staff/registrations") return need("staff.approve") ?? ok(users.filter((u) => u.pending));
  if ((m = /^\/api\/staff\/registrations\/(\d+)$/.exec(path))) {
    const denied = need("staff.approve");
    if (denied) return denied;
    const i = users.findIndex((u) => u.id === Number(m![1]) && u.pending);
    if (i < 0) return fail(404, "Заявка не найдена");
    if (body?.approve) Object.assign(users[i], { pending: false, active: true });
    else {
      for (const c of cards) if (c.staffId === users[i].id) c.staffId = null;
      users.splice(i, 1);
    }
    return ok(users.filter((u) => u.pending));
  }
  return null;
}
