import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { ConsoleSms } from "./sms.ts";

const car = { car: "Toyota Yaris", vin: "KSP210-0089458", year: "2023", color: "Белый", body: "sedan", value: "1000000", city: "Новосибирск" };
const customer = {
  fio: "Иванов Пётр Сергеевич", phone: "+79135551234", passportSeries: "5012", passportNumber: "345678",
  passportIssued: "ГУ МВД России", passportDate: "2019-06-14", address: "г. Новосибирск, ул. Кирова, д. 10",
};
const consents = { contract: true, pep: true, personalData: true };
const company = {
  name: "ООО «Автоимпорт»", inn: "2536123456", kpp: "253601001", ogrn: "1022500000000", address: "г. Владивосток, ул. Светланская, д. 1",
  bank: "ПАО Сбербанк", bik: "040813608", account: "40702810000000000001", corrAccount: "30101810600000000608", contact: "Петров Иван", email: "",
};

function setup() {
  const sms = new ConsoleSms();
  let t = Date.parse("2026-10-23T00:00:00Z");
  const app = buildApp({ db: openDb(":memory:", 685), sms, adminToken: "secret", now: () => new Date(t) });
  const admin = { authorization: "Bearer secret" };
  const smsCode = () => /(\d{4})/.exec(sms.sent.at(-1)!.text)![1];
  async function signIn() {
    await app.inject({ method: "POST", url: "/api/auth/code", payload: { phone: customer.phone } });
    const r = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone: customer.phone, code: smsCode() } });
    return { cookie: String(r.headers["set-cookie"]).split(";")[0] };
  }
  async function order(h: { cookie: string }, vin: string) {
    const r = await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car: { ...car, vin }, customer, consents } });
    if (r.statusCode !== 200) return r;
    return app.inject({ method: "POST", url: `/api/orders/${r.json().id}/sign`, payload: { code: /: (\d{4})\./.exec(sms.sent.at(-1)!.text)![1] } });
  }
  return { app, sms, admin, signIn, order, later: (ms: number) => (t += ms) };
}

test("обычный клиент: один автомобиль в сутки, дальше — карточка партнёра", async () => {
  const { app, admin, signIn, order } = setup();
  const h = await signIn();
  assert.equal((await order(h, "KSP210-0089458")).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/auth/me", headers: h })).json().canOrder, false);
  // Цену второго автомобиля не показываем: сразу карточка партнёра
  const price = await app.inject({ method: "POST", url: "/api/quote", headers: h, payload: { car: { ...car, city: "Москва" } } });
  assert.equal(price.statusCode, 403);
  assert.equal(price.json().needPartner, true);
  assert.equal(JSON.stringify(price.json()).includes("000"), false);
  const second = await order(h, "KSP210-0089459");
  assert.equal(second.statusCode, 403);
  assert.equal(second.json().needPartner, true);

  // Реквизиты проверяются
  const bad = await app.inject({ method: "POST", url: "/api/partner", headers: h, payload: { company: { ...company, inn: "123" } } });
  assert.ok(bad.json().errors.inn);
  const sent = await app.inject({ method: "POST", url: "/api/partner", headers: h, payload: { company } });
  assert.equal(sent.json().status, "pending");
  assert.equal((await order(h, "KSP210-0089459")).statusCode, 403);

  // Менеджер одобряет — ограничение снимается
  const list = (await app.inject({ url: "/api/staff/partner-requests", headers: admin })).json();
  assert.equal(list[0].company.inn, "2536123456");
  await app.inject({ method: "PATCH", url: `/api/staff/partner-requests/${list[0].id}`, headers: admin, payload: { status: "approved" } });
  const me = (await app.inject({ url: "/api/auth/me", headers: h })).json();
  assert.equal(me.partner, "approved");
  assert.equal(me.canOrder, true);
  assert.equal((await app.inject({ method: "POST", url: "/api/quote", headers: h, payload: { car } })).statusCode, 200);
  const signed = await order(h, "KSP210-0089459");
  assert.equal(signed.statusCode, 200);
  // В договоре партнёра Заказчик — компания из карточки, клиент — её представитель
  assert.equal(signed.json().contract.company.inn, "2536123456");
  assert.equal(signed.json().contract.customer.fio, "Иванов Пётр Сергеевич");
  assert.equal((await order(h, "KSP210-0089460")).statusCode, 200);
});

test("через сутки обычный клиент снова может оформить автомобиль", async () => {
  const { signIn, order, later } = setup();
  const h = await signIn();
  assert.equal((await order(h, "KSP210-0089458")).statusCode, 200);
  later(25 * 3_600_000);
  assert.equal((await order(h, "KSP210-0089459")).statusCode, 200);
});

test("два черновика параллельно не обходят лимит", async () => {
  const { app, signIn, sms } = setup();
  const h = await signIn();
  const a = (await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car, customer, consents } })).json();
  const b = (await app.inject({ method: "POST", url: "/api/orders", headers: h, payload: { car: { ...car, vin: "KSP210-0089459" }, customer, consents } })).json();
  const codeFor = (no: number) => new RegExp(`№${no}: (\\d{4})`).exec(sms.sent.map((m) => m.text).join("\n"))![1];
  assert.equal((await app.inject({ method: "POST", url: `/api/orders/${a.id}/sign`, payload: { code: codeFor(a.no) } })).statusCode, 200);
  const r = await app.inject({ method: "POST", url: `/api/orders/${b.id}/sign`, payload: { code: codeFor(b.no) } });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().needPartner, true);
});
