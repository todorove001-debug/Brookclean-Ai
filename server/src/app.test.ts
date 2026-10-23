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
  /** Вход клиента по коду из SMS: возвращает заголовок cookie. */
  async function signIn(phone = customer.phone) {
    await app.inject({ method: "POST", url: "/api/auth/code", payload: { phone } });
    const code = /входа (\d{4})/.exec(sms.sent.at(-1)!.text)![1];
    const r = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone, code } });
    return { cookie: String(r.headers["set-cookie"]).split(";")[0] };
  }
  return { app, sms, admin, codeFromSms, signIn };
}

test("оформление, подпись кодом и трекинг", async () => {
  const { app, sms, admin, codeFromSms, signIn } = setup();
  const h = await signIn();

  const link = (await app.inject({ method: "POST", url: "/api/staff/partner-links", headers: admin, payload: { partner: "Монстеркар", cashback: 5000 } })).json();

  const created = await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car, customer, consents, partnerToken: link.token } });
  assert.equal(created.statusCode, 200);
  const { id, no, quote } = created.json();
  assert.equal(no, 685);
  assert.equal(quote.delivery, 125000);
  assert.equal(quote.total, 128000);
  assert.equal(sms.sent[1].phone, "+79135551234");
  assert.equal(created.json().devCode, undefined);

  const bad = await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: "00000" } });
  assert.equal(bad.statusCode, 400);

  const signed = await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: codeFromSms() } });
  assert.equal(signed.statusCode, 200);
  const order = signed.json();
  assert.equal(order.status, "signed");
  assert.match(order.signature.documentSha256, /^[0-9a-f]{64}$/);
  assert.equal(order.trackToken.length, 16);

  await app.inject({ method: "PUT", url: "/api/staff/trips/R-01", headers: admin, payload: { dest: "Новосибирск", truck: "Volvo FH" } });
  await app.inject({ method: "PATCH", url: `/api/staff/orders/${no}`, headers: admin, payload: { tripId: "R-01" } });
  await app.inject({ method: "POST", url: "/api/staff/trips/R-01/position", headers: admin, payload: { city: "Хабаровск" } });

  const t = (await app.inject({ url: `/api/t/${order.trackToken}` })).json();
  assert.equal(t.status, "in_transit");
  assert.equal(t.km, 760);
  assert.equal(t.vinMasked, "KSP•••••••9458");
  assert.equal(JSON.stringify(t).includes("Иванов"), false);
});

test("без согласий и с ошибками заказ не создаётся; админка закрыта", async () => {
  const { app, signIn } = setup();
  const h = await signIn();
  assert.equal((await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car, customer, consents: {} } })).statusCode, 400);
  const r = await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car: { ...car, vin: "1" }, customer, consents } });
  assert.equal(r.statusCode, 400);
  assert.ok(r.json().errors.vin);
  assert.equal((await app.inject({ url: "/api/staff/orders" })).statusCode, 401);
});

test("после 5 неверных кодов подпись блокируется", async () => {
  const { app, codeFromSms, signIn } = setup();
  const h = await signIn();
  const { id } = (await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car, customer, consents } })).json();
  for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: "99999" } });
  const r = await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: codeFromSms() } });
  assert.equal(r.statusCode, 429);
});

test("получение автомобиля, SMS об отзыве один раз, отзыв виден менеджеру", async () => {
  const { app, sms, admin, codeFromSms, signIn } = setup();
  const h = await signIn();
  const { id, no } = (await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car, customer, consents } })).json();
  const { trackToken } = (await app.inject({ method: "POST", url: `/api/orders/${id}/sign`, payload: { code: codeFromSms() } })).json();

  // Отзыв до получения не принимается
  assert.equal((await app.inject({ method: "POST", url: `/api/t/${trackToken}/review`, payload: { rating: 5 } })).statusCode, 409);

  await app.inject({ method: "PATCH", url: `/api/staff/orders/${no}`, headers: admin, payload: { status: "delivered" } });
  await app.inject({ method: "PATCH", url: `/api/staff/orders/${no}`, headers: admin, payload: { status: "delivered" } });
  const reviewSms = sms.sent.filter((m) => m.text.includes("Оцените доставку"));
  assert.equal(reviewSms.length, 1);
  assert.ok(reviewSms[0].text.includes(`https://brookclean-reg.ru/t/${trackToken}`));

  assert.equal((await app.inject({ method: "POST", url: `/api/t/${trackToken}/received` })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/api/t/${trackToken}/review`, payload: { rating: 7 } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/api/t/${trackToken}/review`, payload: { rating: 2, text: "Долго" } })).statusCode, 200);

  assert.deepEqual((await app.inject({ url: `/api/t/${trackToken}` })).json().review, { rating: 2, text: "Долго" });
  const reviews = (await app.inject({ url: "/api/staff/reviews", headers: admin })).json();
  assert.equal(reviews[0].no, no);
  assert.equal(reviews[0].rating, 2);
});
