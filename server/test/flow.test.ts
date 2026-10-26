// полный путь машины Владивосток → терминал Новосибирск → Москва через API
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addManager, client, multipart, PNG, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>>;
let api: ReturnType<typeof client>;
const T: Record<string, string> = {};   // токены сотрудников
let no = 0, track = "", trip1 = "", trip2 = "";

const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), mp4 = Buffer.from("fake-mp4-bytes");
async function upload(token: string, stage: string, kind: "photo" | "video", slot: number) {
  const m = multipart({ kind, slot: String(slot) }, kind === "photo" ? { name: "p.jpg", type: "image/jpeg", data: jpg } : { name: "v.mp4", type: "video/mp4", data: mp4 });
  const r = await ctx.app.inject({ method: "POST", url: `/api/orders/${no}/stages/${stage}/media`, payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
async function shootAll(token: string, stage: string) {
  const st = (await api("GET", `/api/orders/${no}/stages/${stage}`, undefined, token)).body;
  for (const p of st.spec.photos) expect((await upload(token, stage, "photo", p.slot)).status).toBe(201);
  for (const v of st.spec.videos.filter((x: any) => x.required)) expect((await upload(token, stage, "video", v.slot)).status).toBe(201);
}
const sign = (token: string, stage: string, side: "give" | "take") => api("POST", `/api/orders/${no}/stages/${stage}/sign`, { side, image: PNG }, token);
const stage = (token: string, s: string) => api("GET", `/api/orders/${no}/stages/${s}`, undefined, token).then((r) => r.body);

async function staff(role: string, name: string, phone: string, extra: Record<string, string> = {}) {
  const r = await api("POST", "/api/auth/register", { role, name, phone, password: "secret123", ...extra });
  expect(r.status).toBe(201);
  expect((await api("POST", "/api/auth/login", { phone, password: "secret123" })).status).toBe(403);   // ждёт подтверждения
  expect((await api("POST", `/api/users/${r.body.user.id}/status`, { status: "active" }, T.m)).status).toBe(200);
  return (await api("POST", "/api/auth/login", { phone, password: "secret123" })).body.token as string;
}

beforeAll(async () => {
  ctx = await setup();
  api = client(ctx.app);
  const m = await addManager(ctx.pool);
  T.m = (await api("POST", "/api/auth/login", { phone: "+7 950 281-55-55", password: m.pass })).body.token;
});
afterAll(async () => { await ctx.app.close(); await ctx.pool.end(); });

describe("сотрудники", () => {
  it("регистрация и подтверждение менеджером", async () => {
    T.vl = await staff("terminal", "Ли Ольга Викторовна", "79140009911", { terminalCity: "Владивосток" });
    T.nsk = await staff("terminal", "Кузнецов Андрей Петрович", "79130009900", { terminalCity: "Новосибирск" });
    T.a = await staff("driver", "Гаврилов Игорь Петрович", "79240001234", { license: "2531123456" });
    T.other = await staff("driver", "Посторонний Пётр Петрович", "79240005555", { license: "2531999999" });
    expect((await api("GET", "/api/me", undefined, T.a)).body.user.role).toBe("driver");
  });
});

describe("клиент", () => {
  it("расчёт, заявка и подпись по коду из SMS", async () => {
    const q = await api("POST", "/api/quote", { city: "Москва", body: "cross", value: 2300000 });
    expect(q.body).toEqual({ delivery: 185000, insurance: 6900, total: 191900, needsManager: false });
    const r = await api("POST", "/api/orders", {
      city: "Москва", body: "cross", value: 2300000, car: "Mazda CX-5", vin: "KF2P-401234", year: 2019, color: "Красный",
      fio: "Белов Дмитрий Сергеевич", phone: "+7 977 000 00 85", passportSeries: "4510", passportNumber: "123456",
      passportIssued: "ГУ МВД России по г. Москве", passportDate: "2018-05-14", address: "г. Москва, ул. Тверская, д. 1", consentPd: true,
    });
    expect(r.status).toBe(201);
    no = r.body.no; track = r.body.trackToken;
    expect((await api("POST", `/api/orders/${no}/sign/request`, { token: track })).status).toBe(200);
    expect((await api("POST", `/api/orders/${no}/sign/request`, { token: track })).status).toBe(429);
    const code = ctx.sms.sent.at(-1)!.text.match(/(\d{6})/)![1];
    expect((await api("POST", `/api/orders/${no}/sign/confirm`, { token: track, code: code === "000000" ? "111111" : "000000" })).status).toBe(400);
    const ok = await api("POST", `/api/orders/${no}/sign/confirm`, { token: track, code });
    expect(ok.status).toBe(200);
    expect(ok.body.docHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await api("GET", `/api/track/${track}`)).body.status).toBe("Оплачен, ждёт рейса");
  });
});

describe("рейс до терминала", () => {
  it("менеджер ставит машину через терминал", async () => {
    const drivers = (await api("GET", "/api/drivers", undefined, T.m)).body.drivers;
    const a = drivers.find((d: any) => d.name.startsWith("Гаврилов"));
    const t = await api("POST", "/api/trips", { dest: "Новосибирск", driverId: a.id, truck: "Sitrak C7H · Р 117 ТТ 125", loadDate: "2026-10-14" }, T.m);
    expect(t.status).toBe(201);
    trip1 = t.body.trip.id;
    expect((await api("POST", `/api/orders/${no}/route`, { mode: "terminal", trip1Id: trip1 }, T.m)).status).toBe(200);
    expect((await api("GET", `/api/orders/${no}/stages`, undefined, T.a)).body.stages.map((s: any) => s.stage))
      .toEqual(["priemka", "pogruzka", "term_in", "term_out", "vygruzka"]);
  });

  it("приёмка во Владивостоке: снимает приёмщик, клиент подписывает на его устройстве", async () => {
    expect((await upload(T.a, "priemka", "photo", 0)).status).toBe(403);
    await shootAll(T.vl, "priemka");
    expect((await api("PATCH", `/api/orders/${no}/stages/priemka/section`, { car: { plate: "без номера", keys: "2", ptsType: "Выписка ЭПТС" } }, T.vl)).status).toBe(200);
    expect((await sign(T.vl, "priemka", "take")).status).toBe(409);   // сначала «Сдал»
    expect((await sign(T.vl, "priemka", "give")).status).toBe(200);
    expect((await sign(T.vl, "priemka", "take")).body.closed).toBe(true);
  });

  it("погрузка во Владивостоке: 4 фото водителя", async () => {
    expect((await upload(T.vl, "pogruzka", "photo", 0)).status).toBe(403);
    await shootAll(T.a, "pogruzka");
    expect((await sign(T.vl, "pogruzka", "give")).status).toBe(200);
    expect((await sign(T.a, "pogruzka", "take")).status).toBe(200);
  });

  it("приём на терминал: только когда автовоз на месте; изменение после подписи сбрасывает её", async () => {
    await shootAll(T.nsk, "term_in");
    expect((await sign(T.a, "term_in", "give")).status).toBe(409);   // автовоз ещё не в Новосибирске
    expect((await api("POST", `/api/trips/${trip1}/position`, { city: "Новосибирск" }, T.a)).status).toBe(200);
    expect((await sign(T.a, "term_in", "give")).status).toBe(200);
    expect((await api("POST", `/api/orders/${no}/stages/term_in/marks`, { code: "S", x: 0.4, y: 0.5, part: "капот" }, T.nsk)).status).toBe(201);
    expect((await stage(T.nsk, "term_in")).section.give).toBeNull();
    expect((await upload(T.a, "term_in", "photo", 0)).status).toBe(403);
    expect((await sign(T.a, "term_in", "give")).status).toBe(200);
    expect((await sign(T.nsk, "term_in", "take")).status).toBe(200);
    expect((await api("GET", `/api/track/${track}`)).body.status).toBe("На терминале Новосибирск");
  });
});

describe("отгрузка с терминала", () => {
  it("приёмщик заводит водителя в свою базу и формирует рейс", async () => {
    expect((await api("GET", "/api/drivers", undefined, T.nsk)).body.drivers).toHaveLength(0);   // общая база не видна
    const comp = await api("POST", "/api/companies", { name: "ООО «Сиб-Автовоз»", inn: "5405000137" }, T.nsk);
    const d = await api("POST", "/api/drivers", { name: "Мельников Денис Олегович", phone: "+7 913 000-77-30", companyId: comp.body.company.id,
      tractorModel: "Sitrak C7H", tractorPlate: "К 908 НТ 54", trailerPlate: "АР 1290 54", docs: { license: { number: "54 22 334455" } } }, T.nsk);
    expect(d.status).toBe(201);
    // водитель регистрируется сам — его кабинет связывается с карточкой терминала по телефону
    T.b = await staff("driver", "Мельников Денис Олегович", "79130007730", { license: "5422334455" });
    expect((await api("GET", "/api/drivers", undefined, T.nsk)).body.drivers[0].userId).not.toBeNull();
    const t = await api("POST", "/api/trips", { dest: "Москва", driverId: d.body.driver.id, truck: "Sitrak C7H · К 908 НТ 54" }, T.nsk);
    expect(t.status).toBe(201);
    trip2 = t.body.trip.id;
    expect(t.body.trip.origin).toBe("Новосибирск");
    expect((await api("POST", `/api/trips/${trip2}/cars`, { orderNo: no }, T.nsk)).status).toBe(200);
    expect((await upload(T.nsk, "term_out", "photo", 0)).status).toBe(201);   // снимать можно заранее
    expect((await sign(T.nsk, "term_out", "give")).status).toBe(409);      // рейс не сформирован
    expect((await api("POST", `/api/trips/${trip2}/status`, { status: "formed" }, T.nsk)).status).toBe(200);
  });

  it("приёмщик — 2 фото и «Сдал», водитель — приёмка, дефекты и «Принял»", async () => {
    expect((await upload(T.nsk, "term_out", "photo", 1)).status).toBe(201);
    expect((await upload(T.nsk, "term_out", "photo", 10)).status).toBe(403);
    expect((await upload(T.b, "term_out", "photo", 0)).status).toBe(403);
    expect((await api("POST", `/api/orders/${no}/stages/term_out/marks`, { code: "A1", x: 0.3, y: 0.2 }, T.nsk)).status).toBe(403);
    const st = await stage(T.b, "term_out");
    expect(st.mode.light).toBe(true);
    expect(st.perms).toMatchObject({ shootDriver: true, shootTerminal: false, marks: true, signGive: false, signTake: true });
    for (const p of st.spec.photos.filter((x: any) => x.by === "driver")) expect((await upload(T.b, "term_out", "photo", p.slot)).status).toBe(201);
    for (const v of st.spec.videos) expect((await upload(T.b, "term_out", "video", v.slot)).status).toBe(201);
    expect((await api("POST", `/api/orders/${no}/stages/term_out/marks`, { code: "A1", x: 0.3, y: 0.2, part: "левый борт" }, T.b)).status).toBe(201);
    // экран приёмщика передан водителю: отметка записывается на водителя
    expect((await api("PATCH", `/api/orders/${no}/stages/term_out/section`, { driverMode: true }, T.nsk)).status).toBe(200);
    expect((await api("POST", `/api/orders/${no}/stages/term_out/marks`, { code: "B1", x: 0.5, y: 0.8 }, T.nsk)).status).toBe(201);
    const marks = (await stage(T.b, "term_out")).marks.filter((m: any) => m.firstStage === "term_out");
    expect(marks.map((m: any) => m.history[0].who)).toEqual(["Мельников Денис Олегович", "Мельников Денис Олегович"]);
    expect(marks[1].history[0].role).toContain("на устройстве приёмщика");
    expect((await sign(T.nsk, "term_out", "give")).status).toBe(403);      // пока экран у водителя
    await api("PATCH", `/api/orders/${no}/stages/term_out/section`, { driverMode: false }, T.nsk);
    expect((await sign(T.b, "term_out", "take")).status).toBe(409);        // ждёт «Сдал»
    expect((await sign(T.b, "term_out", "give")).status).toBe(403);
    expect((await sign(T.nsk, "term_out", "give")).status).toBe(200);
    expect((await sign(T.nsk, "term_out", "take")).status).toBe(403);
    expect((await sign(T.b, "term_out", "take")).body.closed).toBe(true);
    // паспорт и телефон получателя — у водителя, который выдаёт машину; водитель до терминала их не видит
    const t2 = (await api("GET", `/api/trips/${trip2}`, undefined, T.b)).body;
    expect(t2.cars[0].client).toMatchObject({ fio: "Белов Дмитрий Сергеевич", phone: "79770000085", passport: { series: "4510", number: "123456" } });
    expect((await api("GET", `/api/trips/${trip1}`, undefined, T.a)).body.cars[0].client).toBeNull();
    expect((await stage(T.b, "vygruzka")).client.passport.number).toBe("123456");
    expect((await stage(T.b, "term_out")).client).toBeNull();
    expect((await stage(T.nsk, "vygruzka")).client).toBeNull();
    expect((await api("POST", `/api/orders/${no}/stages/term_out/marks`, { code: "A1", x: 0.1, y: 0.1 }, T.b)).status).toBe(409);
  });
});

describe("история и доступ", () => {
  it("каждый участник цепочки видит прошлые фото, видео и подписи; посторонний — нет", async () => {
    const h = await api("GET", `/api/orders/${no}/history`, undefined, T.b);
    expect(h.status).toBe(200);
    expect(h.body.stages.map((s: any) => s.stage)).toEqual(["priemka", "pogruzka", "term_in", "term_out"]);
    const pr = h.body.stages[0];
    expect(pr.media.filter((m: any) => m.kind === "photo")).toHaveLength(10);
    expect(pr.take.signedAt).not.toBeNull();
    const file = await ctx.app.inject({ method: "GET", url: `/api/media/${pr.media[0].id}`, headers: { authorization: `Bearer ${T.b}` } });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(jpg)).toBe(true);
    expect((await api("GET", `/api/orders/${no}/history`, undefined, T.a)).status).toBe(200);
    expect((await api("GET", `/api/orders/${no}/history`, undefined, T.other)).status).toBe(403);
    expect((await api("GET", `/api/media/${pr.media[0].id}`, undefined, T.other)).status).toBe(403);
  });

  it("менеджер снимает отметку после подписей с комментарием", async () => {
    const m = (await api("GET", `/api/orders/${no}/history`, undefined, T.m)).body.marks[0];
    expect((await api("DELETE", `/api/orders/${no}/marks/${m.id}`, { reason: "" }, T.m)).status).toBe(400);
    expect((await api("DELETE", `/api/orders/${no}/marks/${m.id}`, { reason: "Скол был до приёмки, есть на фото" }, T.m)).status).toBe(200);
    expect((await api("DELETE", `/api/orders/${no}/marks/${m.id}`, { reason: "повтор" }, T.nsk)).status).toBe(403);
  });

  it("журнал действий пишет, кто и что менял", async () => {
    const r = await ctx.pool.query("select action, count(*)::int n from audit_log where entity = 'order' and entity_id = $1 group by action", [String(no)]);
    const a = Object.fromEntries(r.rows.map((x) => [x.action, x.n]));
    expect(a).toMatchObject({ order_sign: 1, stage_done: 4, mark_add: 3, mark_remove_manager: 1 });
  });
});
