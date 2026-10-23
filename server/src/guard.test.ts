import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { ConsoleSms } from "./sms.ts";
import { LIMITS, type CaptchaVerifier } from "./guard.ts";

const car = { car: "Toyota Yaris", vin: "KSP210-0089458", year: "2023", color: "Белый", body: "sedan", value: "1000000", city: "Новосибирск" };

function setup(opts: { captcha?: CaptchaVerifier; staffUrl?: string } = {}) {
  const sms = new ConsoleSms();
  let t = Date.parse("2026-10-23T00:00:00Z");
  const app = buildApp({ db: openDb(":memory:", 685), sms, adminToken: "secret", now: () => new Date(t), ...opts });
  const admin = { authorization: "Bearer secret" };
  async function signIn(phone: string, ip = "10.0.0.1") {
    const sent = await app.inject({ method: "POST", url: "/api/auth/code", payload: { phone }, remoteAddress: ip });
    if (sent.statusCode !== 200) return { status: sent.statusCode, body: sent.json(), cookie: "" };
    const code = /входа (\d{4})/.exec(sms.sent.at(-1)!.text)![1];
    const r = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone, code }, remoteAddress: ip });
    return { status: r.statusCode, body: r.json(), cookie: String(r.headers["set-cookie"]).split(";")[0] };
  }
  const later = (ms: number) => (t += ms);
  return { app, sms, admin, signIn, later };
}

test("цену видит только вошедший по SMS клиент", async () => {
  const { app, signIn } = setup();
  const anon = await app.inject({ method: "POST", url: "/api/quote", payload: { car } });
  assert.equal(anon.statusCode, 401);
  assert.equal(JSON.stringify(anon.json()).includes("120"), false);

  const bad = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone: "+79135551234", code: "0000" } });
  assert.equal(bad.statusCode, 410);

  const s = await signIn("8 913 555 12 34");
  assert.equal(s.status, 200);
  assert.equal(s.body.phone, "+79135551234");
  assert.match(s.cookie, /^bc_client=/);
  const q = await app.inject({ method: "POST", url: "/api/quote", headers: { cookie: s.cookie }, payload: { car } });
  assert.equal(q.statusCode, 200);
  assert.equal(q.json().total, 123000);
  assert.equal((await app.inject({ url: "/api/auth/me", headers: { cookie: s.cookie } })).json().phone, "+79135551234");

  // Договор оформляется только на подтверждённый номер
  const customer = {
    fio: "Иванов Пётр Сергеевич", phone: "+7 999 000 00 00", passportSeries: "5012", passportNumber: "345678",
    passportIssued: "ГУ МВД", passportDate: "2019-06-14", address: "г. Новосибирск, ул. Кирова, д. 10",
  };
  const other = await app.inject({ method: "POST", url: "/api/orders", headers: { cookie: s.cookie },
    payload: { car, customer, consents: { contract: true, pep: true, personalData: true } } });
  assert.equal(other.statusCode, 400);
  assert.ok(other.json().errors.phone);
});

test("лимит разных вариантов за сутки и запись в журнал", async () => {
  const { app, admin, signIn, later } = setup();
  const { cookie } = await signIn("+79135551234");
  const cities = ["Москва", "Казань", "Омск", "Пермь", "Уфа", "Тюмень", "Киров"];
  const codes: number[] = [];
  for (const city of cities) codes.push((await app.inject({ method: "POST", url: "/api/quote", headers: { cookie }, payload: { car: { ...car, city } } })).statusCode);
  assert.deepEqual(codes, [...Array(LIMITS.quotesPerPhoneDay).fill(200), 429]);
  // Повтор уже посчитанного варианта не тратит лимит
  assert.equal((await app.inject({ method: "POST", url: "/api/quote", headers: { cookie }, payload: { car: { ...car, city: "Москва", value: "2000000" } } })).statusCode, 200);

  const report = (await app.inject({ url: "/api/staff/security", headers: admin })).json();
  const kinds = report.events.map((e: { kind: string }) => e.kind);
  assert.ok(kinds.includes("many_cities"));
  assert.ok(kinds.includes("quote_limit"));
  const suspect = report.suspects.find((x: { value: string }) => x.value === "+79135551234");
  assert.equal(suspect.cities, LIMITS.quotesPerPhoneDay);

  // Через сутки лимит снова доступен
  later(25 * 3_600_000);
  assert.equal((await app.inject({ method: "POST", url: "/api/quote", headers: { cookie }, payload: { car: { ...car, city: "Киров" } } })).statusCode, 200);
});

test("лимит SMS на номер и блокировка из панели", async () => {
  const { app, admin, signIn, later } = setup();
  for (let i = 0; i < LIMITS.smsPerPhoneHour; i++) assert.equal((await signIn("+79135551234", `10.0.0.${i}`)).status, 200);
  assert.equal((await signIn("+79135551234", "10.0.1.1")).status, 429);
  later(3_600_000);

  const blocked = await app.inject({ method: "POST", url: "/api/staff/security/block", headers: admin, payload: { value: "8 (913) 555-12-34", note: "конкурент" } });
  assert.equal(blocked.json().blocked[0].value, "+79135551234");
  const r = await signIn("+79135551234");
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Позвоните/);

  await app.inject({ method: "POST", url: "/api/staff/security/block", headers: admin, payload: { value: "10.9.9.9" } });
  assert.equal((await signIn("+79990001122", "10.9.9.9")).status, 403);
  await app.inject({ method: "DELETE", url: "/api/staff/security/block/10.9.9.9", headers: admin });
  assert.equal((await signIn("+79990001122", "10.9.9.9")).status, 200);
});

test("капча только при подозрительной активности", async () => {
  const checked: string[] = [];
  const captcha: CaptchaVerifier = { siteKey: "site-key", verify: async (token) => (checked.push(token), token === "good") };
  const { app, signIn } = setup({ captcha });
  assert.equal((await signIn("+79135550001")).status, 200);
  assert.equal((await signIn("+79135550002")).status, 200);
  assert.equal(checked.length, 0);

  const need = await app.inject({ method: "POST", url: "/api/auth/code", payload: { phone: "+79135550003" }, remoteAddress: "10.0.0.1" });
  assert.equal(need.statusCode, 428);
  assert.equal(need.json().captcha, "site-key");
  const bad = await app.inject({ method: "POST", url: "/api/auth/code", payload: { phone: "+79135550003", captcha: "bad" }, remoteAddress: "10.0.0.1" });
  assert.equal(bad.statusCode, 428);
  const good = await app.inject({ method: "POST", url: "/api/auth/code", payload: { phone: "+79135550003", captcha: "good" }, remoteAddress: "10.0.0.1" });
  assert.equal(good.statusCode, 200);
  // С другого адреса капча не нужна
  assert.equal((await signIn("+79135550004", "10.0.0.2")).status, 200);
});

test("подбор кода входа: 5 попыток, затем запись в журнал", async () => {
  const { app, admin } = setup();
  await app.inject({ method: "POST", url: "/api/auth/code", payload: { phone: "+79135551234" } });
  for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone: "+79135551234", code: "9999" } });
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/verify", payload: { phone: "+79135551234", code: "1234" } })).statusCode, 429);
  const report = (await app.inject({ url: "/api/staff/security", headers: admin })).json();
  assert.equal(report.events[0].kind, "bad_code");
});

test("панель на отдельном адресе: на сайте клиента её нет", async () => {
  const { app, admin } = setup({ staffUrl: "https://staff.brookclean-reg.ru" });
  const site = { host: "brookclean-reg.ru", ...admin };
  const staff = { host: "staff.brookclean-reg.ru", ...admin };
  assert.equal((await app.inject({ url: "/api/staff/orders", headers: site })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/staff/orders", headers: staff })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/staff/login", headers: { host: "brookclean-reg.ru" }, payload: {} })).statusCode, 404);
  const root = await app.inject({ url: "/", headers: { host: "staff.brookclean-reg.ru" } });
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, "/admin");
});
