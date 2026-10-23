import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { ConsoleSms } from "./sms.ts";
import { ensureOwner } from "./staff.ts";

const car = (city: string, vin: string) => ({ car: "Toyota Yaris", vin, year: "2023", color: "Белый", body: "sedan", value: "1000000", city });
const customer = {
  fio: "Юферов Павел Юрьевич", phone: "+7 913 555 00 53", passportSeries: "5012", passportNumber: "345678",
  passportIssued: "ГУ МВД России по Новосибирской обл.", passportDate: "2019-06-14", address: "г. Новосибирск, ул. Кирова, д. 10",
};

async function setup() {
  const db = openDb(":memory:", 678);
  ensureOwner(db, "owner", "owner-pass-1");
  const app = buildApp({ db, sms: new ConsoleSms() });
  async function login(l: string, p: string) {
    const r = await app.inject({ method: "POST", url: "/api/staff/login", payload: { login: l, password: p } });
    const c = r.headers["set-cookie"];
    return { status: r.statusCode, error: r.json().error as string | undefined, h: { cookie: typeof c === "string" ? c.split(";")[0] : "" } };
  }
  const h = (await login("owner", "owner-pass-1")).h;
  async function order(city: string, vin: string) {
    const { no } = (await app.inject({ method: "POST", url: "/api/staff/orders", headers: h, payload: { car: car(city, vin), customer } })).json();
    db.prepare("UPDATE orders SET status = 'signed' WHERE no = ?").run(no);
    return no as number;
  }
  return { app, db, login, h, order };
}

test("реестр водителей: карточка, импорт без повторов, рейс подставляет тягач и прицеп", async () => {
  const { app, h } = await setup();
  const created = await app.inject({ method: "POST", url: "/api/staff/registry", headers: h, payload: {
    name: "Волков Дмитрий Олегович", phone: "+79140005566", own: false, companyName: "ООО «Сибирь-Транзит»", companyInn: "5406000000",
    tractorModel: "MAN TGX", tractorPlate: "Е 905 УА 54", trailerModel: "LUXUDA LZC9405BG", trailerPlate: "АО 2148 54",
    docs: { lic: { number: "25 30 778899", valid_until: "01.01.2020", hack: "x" }, bogus: { a: "1" } },
  } });
  assert.equal(created.statusCode, 200);
  const d = created.json();
  assert.deepEqual(d.docs, { lic: { number: "25 30 778899", valid_until: "01.01.2020" } }, "лишние поля и виды отброшены");
  assert.equal(d.licExpired, true);
  assert.equal(d.docsFilled, 1);

  const drivers = [{ name: "Петров Сергей Иванович", importKey: "Петров|0412 556677|А 482 КР 125", tractorPlate: "А 482 КР 125" }];
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/staff/registry/import", headers: h, payload: { drivers } })).json(), { added: 1, skipped: 0 });
  assert.deepEqual((await app.inject({ method: "POST", url: "/api/staff/registry/import", headers: h, payload: { drivers } })).json(), { added: 0, skipped: 1 });

  const t = (await app.inject({ method: "POST", url: "/api/staff/trips", headers: h, payload: { dest: "Москва", regDriverId: d.id, advance: "150 000" } })).json();
  assert.equal(t.truck, "MAN TGX · Е 905 УА 54");
  assert.equal(t.trailer, "LUXUDA LZC9405BG · АО 2148 54");
  assert.equal(t.carrier, "ООО «Сибирь-Транзит»");
  assert.equal(t.driver, "Волков Дмитрий Олегович");
  assert.equal(t.advance, 150000);
  const list = (await app.inject({ url: "/api/staff/registry", headers: h })).json();
  assert.equal(list.find((x: { id: number }) => x.id === d.id).tripId, t.id);
});

test("рейс на 8 мест: девятую не поставить, сформированный рейс не меняется", async () => {
  const { app, h, order } = await setup();
  const t = (await app.inject({ method: "POST", url: "/api/staff/trips", headers: h, payload: { dest: "Новосибирск", truck: "Volvo FH", driver: "Сергей" } })).json();
  const nos = [];
  for (let i = 0; i < 9; i++) nos.push(await order("Новосибирск", `KSP210-00894${10 + i}`));
  for (const no of nos.slice(0, 8)) assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/cars`, headers: h, payload: { no, load: true } })).statusCode, 200);
  const ninth = await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/cars`, headers: h, payload: { no: nos[8], load: true } });
  assert.equal(ninth.statusCode, 409);
  assert.match(ninth.json().error, /нет мест/);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/orders/${nos[8]}`, headers: h, payload: { tripId: t.id } })).statusCode, 409);

  // Распределение: девятая машина ждёт, а полный рейс ей не предлагается
  const dist = (await app.inject({ url: "/api/staff/distribution", headers: h })).json();
  assert.deepEqual(dist.map((x: { no: number }) => x.no), [nos[8]]);
  assert.equal(dist[0].trips.length, 0);

  const formed = (await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/form`, headers: h, payload: { formed: true } })).json();
  assert.ok(formed.formedAt);
  assert.equal(formed.seats, 0);
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/cars`, headers: h, payload: { no: nos[0], load: false } })).statusCode, 409);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/orders/${nos[0]}`, headers: h, payload: { tripId: null } })).statusCode, 409);
  await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/form`, headers: h, payload: { formed: false } });
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/cars`, headers: h, payload: { no: nos[0], load: false } })).statusCode, 200);

  const empty = (await app.inject({ method: "POST", url: "/api/staff/trips", headers: h, payload: { dest: "Омск", truck: "Scania R" } })).json();
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${empty.id}/form`, headers: h, payload: { formed: true } })).statusCode, 400);
});

test("рейсовый отчёт: водитель сдаёт, менеджер возвращает и принимает", async () => {
  const { app, h, login, order } = await setup();
  await app.inject({ method: "POST", url: "/api/staff/users", headers: h, payload: { name: "Сергей", login: "sergey", password: "driver-pass-1", role: "driver" } });
  const dh = (await login("sergey", "driver-pass-1")).h;
  const t = (await app.inject({ method: "POST", url: "/api/staff/trips", headers: dh, payload: { dest: "Новосибирск", truck: "Volvo FH" } })).json();
  await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/meta`, headers: h, payload: { advance: 120000 } });
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/meta`, headers: dh, payload: { advance: 1 } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/report/submit`, headers: dh })).statusCode, 400, "без чеков не сдать");

  await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/expenses`, headers: dh, payload: { kind: "fuel", amount: 15818, liters: 220 } });
  const no = await order("Новосибирск", "KSP210-0089458");
  await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/cars`, headers: h, payload: { no, load: true } });
  const sub = (await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/report/submit`, headers: dh })).json();
  assert.equal(sub.trip.reportStatus, "submitted");
  assert.equal(sub.totals.balance, 120000 - 15818);
  assert.equal(sub.totals.revenue, undefined, "водителю выручку не показываем");
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/expenses`, headers: dh, payload: { kind: "food", amount: 500 } })).statusCode, 409);

  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/report/decision`, headers: h, payload: { accept: false } })).statusCode, 400, "вернуть без комментария нельзя");
  const back = (await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/report/decision`, headers: h, payload: { accept: false, comment: "Нет чека за стоянку" } })).json();
  assert.equal(back.trip.reportStatus, "returned");
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/expenses`, headers: dh, payload: { kind: "parking", amount: 500 } })).statusCode, 200);
  await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/report/submit`, headers: dh });
  const acc = (await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/report/decision`, headers: h, payload: { accept: true } })).json();
  assert.equal(acc.trip.reportStatus, "accepted");
  assert.ok(acc.trip.acceptedAt);
  assert.equal(acc.totals.revenue, 120000, "тариф Новосибирск, седан");
});

test("регистрация: заявка ждёт подтверждения, вход по телефону, карточка водителя из реестра", async () => {
  const { app, h, login } = await setup();
  await app.inject({ method: "POST", url: "/api/staff/registry/import", headers: h, payload: { drivers: [{ name: "Ким Олег Сергеевич", phone: "+79140007788", importKey: "k1" }] } });
  const bad = await app.inject({ method: "POST", url: "/api/staff/register", payload: { name: "Ким", phone: "123", password: "short", role: "owner" } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(Object.keys(bad.json().errors).sort(), ["name", "password", "phone", "role"]);
  const reg = await app.inject({ method: "POST", url: "/api/staff/register", payload: { name: "Ким Олег Сергеевич", phone: "8 914 000-77-88", password: "driver-pass-2", role: "driver" } });
  assert.equal(reg.statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/staff/register", payload: { name: "Ким Олег Сергеевич", phone: "+79140007788", password: "driver-pass-2", role: "driver" } })).statusCode, 409);

  const early = await login("+7 914 000 77 88", "driver-pass-2");
  assert.equal(early.status, 403);
  assert.match(early.error!, /ждёт подтверждения/);

  const pending = (await app.inject({ url: "/api/staff/registrations", headers: h })).json();
  assert.equal(pending.length, 1);
  await app.inject({ method: "POST", url: `/api/staff/registrations/${pending[0].id}`, headers: h, payload: { approve: true } });
  const ok = await login("89140007788", "driver-pass-2");
  assert.equal(ok.status, 200);
  const card = (await app.inject({ url: "/api/staff/registry/me", headers: ok.h })).json();
  assert.equal(card.name, "Ким Олег Сергеевич");
  assert.ok(card.fromExcel, "привязана карточка из Excel, а не создана новая");
  const upd = (await app.inject({ method: "PATCH", url: "/api/staff/registry/me", headers: ok.h, payload: { tractorPlate: "Т 418 ОР 54", own: false } })).json();
  assert.equal(upd.tractorPlate, "Т 418 ОР 54");
  assert.equal(upd.own, true, "водитель сам не меняет «свой/наёмный»");
  assert.equal((await app.inject({ url: "/api/staff/registry", headers: ok.h })).statusCode, 403);
});

test("таблица доставок: полис, отметки пути, выдача, обратка", async () => {
  const { app, h, order } = await setup();
  const t = (await app.inject({ method: "POST", url: "/api/staff/trips", headers: h, payload: { dest: "Омск", truck: "Volvo FH", driver: "Сергей", trailer: "LOHR" } })).json();
  const nsk = await order("Новосибирск", "KSP210-0089458"), omsk = await order("Омск", "KSP210-0094312");
  for (const no of [nsk, omsk]) await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/cars`, headers: h, payload: { no, load: true } });
  await app.inject({ method: "PATCH", url: `/api/staff/orders/${omsk}`, headers: h, payload: { policyNo: "61485/СГ-2026", paidDelivery: true } });
  for (const city of ["Хабаровск", "Новосибирск", "Омск"]) await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/position`, headers: h, payload: { city } });
  await app.inject({ method: "PATCH", url: `/api/staff/orders/${nsk}`, headers: h, payload: { status: "delivered" } });

  const d = (await app.inject({ url: `/api/staff/trips/${t.id}/deliveries`, headers: h })).json();
  assert.equal(d.trip.trailer, "LOHR");
  assert.equal(d.throughTransfer, true);
  const [a, b] = d.rows;
  assert.ok(a.arrivedTransfer && a.arrivedCity && a.deliveredAt);
  assert.equal(a.leftTransfer, null, "машина до Новосибирска дальше не едет");
  assert.ok(b.leftTransfer && b.arrivedCity);
  assert.equal(b.policyNo, "61485/СГ-2026");
  assert.equal(b.paidDelivery, true);

  const bh = (await app.inject({ method: "POST", url: `/api/staff/trips/${t.id}/backhaul`, headers: h, payload: { car: "Mazda CX-9", vin: "tc-123", route: "Омск → Уссурийск", price: "90000" } })).json();
  assert.equal(bh[0].vin, "TC-123");
  assert.equal(bh[0].price, 90000);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/staff/trips/${t.id}/backhaul/${bh[0].id}`, headers: h })).json().length, 0);
});
