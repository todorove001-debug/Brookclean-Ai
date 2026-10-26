// два сайта: клиенты и партнёры — отдельно, сотрудники — отдельно
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addManager, client, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
let api: ReturnType<typeof client>;
let mgr = "", partner = "", link = "";

const ORDER = {
  city: "Москва", body: "sedan", value: 1500000, car: "Toyota Prius", vin: "ZVW51-6234567", year: 2020, color: "Белый",
  fio: "Орлова Мария Константиновна", phone: "+7 999 000 00 14", passportSeries: "4512", passportNumber: "654321",
  passportIssued: "ГУ МВД России по г. Москве", passportDate: "2019-02-11", address: "г. Москва, ул. Арбат, д. 5", consentPd: true,
};

beforeAll(async () => {
  ctx = await setup();
  api = client(ctx.app);
  const m = await addManager(ctx.pool);
  mgr = (await api("POST", "/api/auth/login", { phone: m.phone, password: m.pass })).body.token;
});
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });

describe("партнёр", () => {
  it("регистрируется на сайте для клиентов, на сайте сотрудников войти не может", async () => {
    const r = await api("POST", "/api/partner/auth/register", { name: "Роман", company: "Монстеркар", phone: "79880000000", password: "partner123" });
    expect(r.status).toBe(201);
    expect((await api("POST", "/api/partner/auth/login", { phone: "79880000000", password: "partner123" })).status).toBe(403);   // ждёт подтверждения
    await api("POST", `/api/users/${r.body.user.id}/status`, { status: "active" }, mgr);
    expect((await api("POST", "/api/auth/login", { phone: "79880000000", password: "partner123" })).status).toBe(401);
    const ok = await api("POST", "/api/partner/auth/login", { phone: "79880000000", password: "partner123" });
    expect(ok.status).toBe(200);
    partner = ok.body.token;
    expect((await api("GET", "/api/orders", undefined, partner)).status).toBe(403);
  });

  it("сотрудник не входит через сайт для клиентов, а партнёр не регистрируется как сотрудник", async () => {
    expect((await api("POST", "/api/partner/auth/login", { phone: "79502815555", password: "manager123" })).status).toBe(401);
    expect((await api("POST", "/api/auth/register", { role: "partner", name: "Кто-то Такой", phone: "79880000001", password: "partner123" })).status).toBe(400);
  });

  it("кэшбэк задаёт партнёр в ссылке; клиент видит только итоговую цену", async () => {
    const l = await api("POST", "/api/partner/links", { title: "Сайт Монстеркар", cashback: 15000 }, partner);
    expect(l.status).toBe(201);
    link = l.body.link.code;
    const plain = (await api("POST", "/api/quote", { city: "Москва", body: "sedan", value: 1500000 })).body;
    const viaLink = (await api("POST", "/api/quote", { city: "Москва", body: "sedan", value: 1500000, ref: link })).body;
    expect(viaLink.delivery - plain.delivery).toBe(15000);
    expect(viaLink).not.toHaveProperty("cashback");
    const o = await api("POST", "/api/orders", { ...ORDER, ref: link });
    expect(o.status).toBe(201);
    expect(o.body.quote).not.toHaveProperty("cashback");
    const po = (await api("GET", "/api/partner/orders", undefined, partner)).body;
    expect(po.orders).toHaveLength(1);
    expect(po.orders[0]).toMatchObject({ cashback: 15000, client: ORDER.fio, status: "Ждёт подписания" });
    expect(po.orders[0]).not.toHaveProperty("phone");
    // ссылка выключена — новые заявки идут без кэшбэка
    await api("PATCH", `/api/partner/links/${l.body.link.id}`, { active: false }, partner);
    expect((await api("POST", "/api/quote", { city: "Москва", body: "sedan", value: 1500000, ref: link })).body.delivery).toBe(plain.delivery);
  });
});

describe("личный кабинет клиента", () => {
  it("вход по коду из SMS только на номер из заявки", async () => {
    const before = ctx.sms.sent.length;
    expect((await api("POST", "/api/client/login/request", { phone: "+7 900 111 22 33" })).body).toEqual({ sent: true });
    expect(ctx.sms.sent.length).toBe(before);   // чужой номер: SMS не уходит, ответ тот же
    expect((await api("POST", "/api/client/login/request", { phone: ORDER.phone })).status).toBe(200);
    expect((await api("POST", "/api/client/login/request", { phone: ORDER.phone })).status).toBe(429);
    const code = ctx.sms.sent.at(-1)!.text.match(/(\d{6})/)![1];
    const r = await api("POST", "/api/client/login/confirm", { phone: ORDER.phone, code });
    expect(r.status).toBe(200);
    const list = (await api("GET", "/api/client/orders", undefined, r.body.token)).body;
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]).toMatchObject({ car: "Toyota Prius", status: "Ждёт подписания" });
    expect(list.orders[0].price).not.toHaveProperty("cashback");
    expect((await api("GET", "/api/client/orders", undefined, mgr)).status).toBe(401);   // токен сотрудника здесь не работает
    expect((await api("GET", "/api/orders", undefined, r.body.token)).status).toBe(401);  // а токен клиента — у сотрудников
  });
});
