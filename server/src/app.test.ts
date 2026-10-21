import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { ConsoleSms } from "./sms.ts";

const car = { car: "Toyota Yaris", vin: "KSP210-0089458", year: "2023", color: "Белый", body: "sedan", value: "1000000", city: "Новосибирск" };
const customer = {
  fio: "Иванов Пётр Сергеевич", phone: "8 913 555 12 34", passportSeries: "5012", passportNumber: "345678",
  passportIssued: "ГУ МВД России по Новосибирской обл.", passportDate: "2019-06-14", address: "г. Новосибирск, ул. Кирова, д. 10",
};
const consents = { contract: true, pep: true, personalData: true };

function setup() {
  const sms = new ConsoleSms();
  const app = buildApp({ db: openDb(":memory:", 685), sms, adminToken: "secret" });
  const admin = { authorization: "Bearer secret" };
  const codeFromSms = () => /: (\d{4})\./.exec(sms.sent.at(-1)!.text)![1];
  return { app, sms, admin, codeFromSms };
}

test("оформление, подпись кодом и трекинг", async () => {
  const { app, sms, admin, codeFromSms } = setup();

  const link = (await app.inject({ method: "POST", url: "/api/admin/partner-links", headers: admin, payload: { partner: "Монстеркар", cashback: 5000 } })).json();

  const created = await app.inject({ method: "POST", url: "/api/orders", payload: { car, customer, consents, partnerToken: link.token } });
  assert.equal(created.statusCode, 200);
  const { id, no, quote } = created.json();
  assert.equal(no, 685);
  assert.equal(quote.delivery, 125000);
  assert.equal(quote.total, 128000);
  assert.equal(sms.sent[0].phone, "+79135551234");
  assert.equal(created.json().devCode, undefined);

  const bad = await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: "00000" } });
  assert.equal(bad.statusCode, 400);

  const signed = await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: codeFromSms() } });
  assert.equal(signed.statusCode, 200);
  const order = signed.json();
  assert.equal(order.status, "signed");
  assert.match(order.signature.documentSha256, /^[0-9a-f]{64}$/);
  assert.equal(order.trackToken.length, 16);

  await app.inject({ method: "PUT", url: "/api/admin/trips/R-01", headers: admin, payload: { dest: "Новосибирск", truck: "Volvo FH" } });
  await app.inject({ method: "POST", url: `/api/admin/orders/${no}/trip`, headers: admin, payload: { tripId: "R-01" } });
  await app.inject({ method: "POST", url: "/api/admin/trips/R-01/position", headers: admin, payload: { city: "Хабаровск" } });

  const t = (await app.inject({ url: `/api/t/${order.trackToken}` })).json();
  assert.equal(t.status, "in_transit");
  assert.equal(t.km, 760);
  assert.equal(t.vinMasked, "KSP•••••••9458");
  assert.equal(JSON.stringify(t).includes("Иванов"), false);
});

test("без согласий и с ошибками заказ не создаётся; админка закрыта", async () => {
  const { app } = setup();
  assert.equal((await app.inject({ method: "POST", url: "/api/orders", payload: { car, customer, consents: {} } })).statusCode, 400);
  const r = await app.inject({ method: "POST", url: "/api/orders", payload: { car: { ...car, vin: "1" }, customer, consents } });
  assert.equal(r.statusCode, 400);
  assert.ok(r.json().errors.vin);
  assert.equal((await app.inject({ url: "/api/admin/orders" })).statusCode, 401);
});

test("после 5 неверных кодов подпись блокируется", async () => {
  const { app, codeFromSms } = setup();
  const { id } = (await app.inject({ method: "POST", url: "/api/orders", payload: { car, customer, consents } })).json();
  for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: "99999" } });
  const r = await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: codeFromSms() } });
  assert.equal(r.statusCode, 429);
});
