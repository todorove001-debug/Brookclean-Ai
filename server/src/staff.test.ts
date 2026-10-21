import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { ConsoleSms } from "./sms.ts";
import { GoogleDrive } from "./drive.ts";
import { ensureOwner } from "./staff.ts";

const car = { car: "Honda Fit", vin: "GS4-1009355", year: "2023", color: "Серебристый", body: "sedan", value: "1050000", city: "Красноярск" };
const customer = {
  fio: "Жаворонкова Людмила Викторовна", phone: "+7 908 123 45 68", passportSeries: "0412", passportNumber: "556677",
  passportIssued: "ГУ МВД России по Красноярскому краю", passportDate: "2018-03-01", address: "г. Красноярск, ул. Мира, д. 5",
};

function setup(drive?: (db: ReturnType<typeof openDb>) => GoogleDrive) {
  const db = openDb(":memory:", 678);
  ensureOwner(db, "owner@brookclean.ru", "owner-pass-1");
  const sms = new ConsoleSms();
  const app = buildApp({ db, sms, drive: drive?.(db) });
  async function login(l: string, p: string) {
    const r = await app.inject({ method: "POST", url: "/api/staff/login", payload: { login: l, password: p } });
    const c = r.headers["set-cookie"];
    return { status: r.statusCode, cookie: typeof c === "string" ? c.split(";")[0] : "" };
  }
  return { app, sms, db, login };
}

test("вход, роли и доступ к разделам", async () => {
  const { app, login } = setup();
  assert.equal((await login("owner@brookclean.ru", "wrong")).status, 401);
  const owner = await login("Owner@Brookclean.ru", "owner-pass-1");
  assert.equal(owner.status, 200);
  const h = { cookie: owner.cookie };

  const me = (await app.inject({ url: "/api/staff/me", headers: h })).json();
  assert.equal(me.role, "owner");
  assert.ok(me.perms.includes("staff.manage"));

  const created = await app.inject({ method: "POST", url: "/api/staff/users", headers: h,
    payload: { name: "Ольга", login: "olga", password: "acceptor-1", role: "acceptor" } });
  assert.equal(created.statusCode, 200);

  const acc = await login("olga", "acceptor-1");
  const ah = { cookie: acc.cookie };
  assert.equal((await app.inject({ url: "/api/staff/orders", headers: ah })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/staff/users", headers: ah })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/staff/orders", headers: ah, payload: { car, customer } })).statusCode, 403);

  // Выключили сотрудника — его вход перестаёт работать сразу
  await app.inject({ method: "PATCH", url: `/api/staff/users/${created.json().id}`, headers: h, payload: { active: false } });
  assert.equal((await app.inject({ url: "/api/staff/orders", headers: ah })).statusCode, 401);

  // Последнего владельца разжаловать нельзя
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/users/${me.id}`, headers: h, payload: { role: "manager" } })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/staff/orders" })).statusCode, 401);
});

test("менеджер оформляет заявку, клиент подписывает по ссылке, бухгалтер отмечает оплату", async () => {
  const { app, sms, login } = setup();
  const h = { cookie: (await login("owner@brookclean.ru", "owner-pass-1")).cookie };
  await app.inject({ method: "POST", url: "/api/staff/users", headers: h, payload: { name: "Ирина", login: "irina", password: "accountant-1", role: "accountant" } });
  await app.inject({ method: "POST", url: "/api/staff/users", headers: h, payload: { name: "Ольга", login: "olga", password: "acceptor-1", role: "acceptor" } });

  const r = await app.inject({ method: "POST", url: "/api/staff/orders", headers: h, payload: { car, customer, cashback: 10000, partner: "Монстеркар" } });
  assert.equal(r.statusCode, 200);
  const { id, no, signUrl } = r.json();
  assert.equal(no, 678);
  assert.equal(r.json().quote.delivery, 120000);
  assert.ok(sms.sent.at(-1)!.text.includes(signUrl));

  const doc = (await app.inject({ url: `/api/orders/${id}` })).json();
  assert.equal(doc.documentCustomer.passportNumber, "••••77");

  await app.inject({ method: "POST", url: `/api/orders/${id}/resend` });
  const code = /: (\d{4})\./.exec(sms.sent.at(-1)!.text)![1];
  assert.equal((await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code } })).statusCode, 400, "без согласий");
  const signed = await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code, consents: { contract: true, pep: true, personalData: true } } });
  assert.equal(signed.json().status, "signed");

  const ih = { cookie: (await login("irina", "accountant-1")).cookie };
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/orders/${no}`, headers: ih, payload: { tripId: null } })).statusCode, 403);
  const paid = await app.inject({ method: "PATCH", url: `/api/staff/orders/${no}`, headers: ih,
    payload: { paidDelivery: true, paidInsurance: true, payTo: "Тодоров", payForm: "нал" } });
  assert.equal(paid.json().status, "paid");
  assert.equal(paid.json().client, "Жаворонкова Людмила Викторовна");

  // Приёмщик видит заявку, но без полного ФИО и телефона
  const oh = { cookie: (await login("olga", "acceptor-1")).cookie };
  const rows = (await app.inject({ url: "/api/staff/orders", headers: oh })).json();
  assert.equal(rows[0].client, "Жаворонкова Л. В.");
  assert.equal(rows[0].phone, "+7 908 ***-**-68");
});

test("рейсовый отчёт: CSV и загрузка в Google Диск", async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: String(init.body ?? "") });
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).includes("oauth2")) return json({ access_token: "at", expires_in: 3600, refresh_token: "rt" });
    if (String(url).endsWith("/drive/v3/files")) return json({ id: "folder1" });
    if (String(url).includes("uploadType=multipart")) return json({ id: "sheet1" });
    return json({ id: "sheet1" });
  }) as typeof fetch;
  const { app, db, login } = setup((db) => new GoogleDrive(db, { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" }, fakeFetch));
  const h = { cookie: (await login("owner@brookclean.ru", "owner-pass-1")).cookie };

  const { no } = (await app.inject({ method: "POST", url: "/api/staff/orders", headers: h, payload: { car, customer } })).json();
  db.prepare("UPDATE orders SET status = 'signed' WHERE no = ?").run(no);
  await app.inject({ method: "PUT", url: "/api/staff/trips/R-01", headers: h, payload: { dest: "Новосибирск", truck: "Volvo FH · А 482 КР 125", driver: "Сергей", loadDate: "2026-10-21" } });
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/orders/${no}`, headers: h, payload: { tripId: "R-01" } })).statusCode, 200);
  await app.inject({ method: "POST", url: "/api/staff/trips/R-01/position", headers: h, payload: { city: "Хабаровск" } });

  const csv = (await app.inject({ url: "/api/staff/trips/R-01/report.csv", headers: h })).body;
  assert.ok(csv.includes("Рейсовый отчёт R-01"));
  assert.ok(csv.includes("GS4-1009355"));
  assert.ok(csv.includes("Жаворонкова Л. В."), "в отчёте сокращённое ФИО");
  assert.ok(!csv.includes("556677"), "паспорта в отчёте нет");

  // Подключение Диска (как после входа в Google) и ручная выгрузка
  await new GoogleDrive(db, { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" }, fakeFetch).finishAuth("code");
  const synced = await app.inject({ method: "POST", url: "/api/staff/trips/R-01/sync", headers: h });
  assert.equal(synced.statusCode, 200);
  assert.equal(synced.json().driveUrl, "https://docs.google.com/spreadsheets/d/sheet1");
  const upload = calls.find((c) => c.url.includes("uploadType=multipart"))!;
  assert.ok(upload.body.includes("application/vnd.google-apps.spreadsheet"));
  assert.ok(upload.body.includes('"parents":["folder1"]'));

  // Повторная выгрузка обновляет ту же таблицу
  await app.inject({ method: "POST", url: "/api/staff/trips/R-01/sync", headers: h });
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.includes("/files/sheet1")));
});
