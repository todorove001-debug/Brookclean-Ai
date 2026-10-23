import { test } from "node:test";
import assert from "node:assert/strict";
import jpeg from "jpeg-js";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { ConsoleSms } from "./sms.ts";
import { ensureOwner } from "./staff.ts";
import { YandexVision, parseJson, parseReceiptQr, recognize, tiles, type Vision } from "./recognize.ts";

const photo = (w = 400, h = 300) => Buffer.from(jpeg.encode({ data: Buffer.alloc(w * h * 4, 200), width: w, height: h }, 80).data);
const fake = (answer: (prompt: string, n: number) => string): Vision & { prompts: string[] } => {
  const prompts: string[] = [];
  return { prompts, ask: async (p, imgs) => { prompts.push(p); return { text: answer(p, imgs.length), model: "fake" }; } };
};

test("ответ модели с ```json и мусором вокруг", () => {
  assert.deepEqual(parseJson('\n\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.equal(parseJson("не знаю"), null);
});

test("QR-код чека", () => {
  assert.deepEqual(parseReceiptQr("t=20260923T1508&s=25566.00&fn=7380440903537975&i=84827&fp=1455885666&n=1"),
    { fn: "7380440903537975", fd: "84827", fp: "1455885666", amount: "25566", date: "23.09.2026", time: "15:08" });
  assert.equal(parseReceiptQr("https://example.com"), null);
});

test("Яндекс: пустой ответ первой модели — спрашиваем вторую, ключ только в заголовке", async () => {
  const calls: Array<{ model: string; auth: string }> = [];
  const v = new YandexVision({
    apiKey: "k", folderId: "b1g", models: ["qwen", "deepseek"], timeoutMs: 1000,
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ model: body.model, auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: body.model.endsWith("qwen") ? null : '{"ok":1}' } }] }));
    }) as typeof fetch,
  });
  assert.deepEqual(await v.ask("p", [photo()]), { text: '{"ok":1}', model: "deepseek" });
  assert.deepEqual(calls, [{ model: "gpt://b1g/qwen", auth: "Api-Key k" }, { model: "gpt://b1g/deepseek", auth: "Api-Key k" }]);
});

test("ВУ: перепутанная цифра не проходит молча", async () => {
  const v = fake(() => '{"number":"99 19 94246","categories":["B","C"],"issue_date":"17.12.2020","valid_until":"17.12.2030","birth_date":"10.06.1988"}');
  const r = await recognize(v, "lic", photo(), { now: new Date("2026-10-23") });
  assert.equal(r.fields.categories, "B, C");
  assert.ok(r.checks.some((c) => c.field === "number" && c.level === "error"));
});

test("второе прочтение номера ВУ ловит цифру, которую модель перепутала", async () => {
  // Как в тесте на настоящем ВУ: deepseek прочитал 942460 вместо 942400.
  const v = fake((p) => p.includes("посимвольно") ? '{"number":"99 19 942400"}'
    : '{"number":"99 19 942460","categories":"B, C","issue_date":"17.12.2020","valid_until":"17.12.2030","birth_date":"10.06.1988"}');
  const r = await recognize(v, "lic", photo(), { now: new Date("2026-10-23") });
  const bad = r.checks.find((c) => c.field === "number" && c.level === "error")!;
  assert.match(bad.msg, /942460.*942400/);
  assert.equal(bad.suggest, "99 19 942400");
});

test("чек: ФН, ФД, ФП одной строкой раскладываются по полям", async () => {
  const v = fake((p) => p.includes("посимвольно") ? '{"amount":"620.00","fd":"25034","fp":"1078341582"}'
    : '{"date":"13.09.2026","amount":620,"category":"toll","fiscal":"ФН: 7380440902353315, ФД: 25034, ФП: 1078341582"}');
  const r = await recognize(v, "receipt", photo(), { now: new Date("2026-10-23") });
  assert.deepEqual([r.fields.fn, r.fields.fd, r.fields.fp], ["7380440902353315", "25034", "1078341582"]);
  assert.ok(r.checks.filter((c) => c.msg === "Два прочтения совпали").length === 3);
  assert.ok(!r.checks.some((c) => c.level === "error"));
});

test("повреждения: целый кадр и 4 части, одинаковые находки не дублируются", async () => {
  assert.equal(tiles(photo()).length, 4);
  const v = fake((p) => p.includes("правая нижняя") || !p.includes("часть")
    ? '{"quality":"ok","damages":[{"part":"диск","desc":"следы бордюра по кромке","confidence":"medium"}]}'
    : '{"quality":"ok","damages":[]}');
  const r = await recognize(v, "damage", photo());
  assert.equal(v.prompts.length, 5);
  assert.equal(r.damages!.length, 1);
  assert.equal(r.damages![0].where, "весь кадр");
});

test("API распознавания: вход, настройка, формат фото", async () => {
  const db = openDb(":memory:", 685);
  ensureOwner(db, "owner", "owner-pass-1");
  const login = async (app: ReturnType<typeof buildApp>) =>
    String((await app.inject({ method: "POST", url: "/api/staff/login", payload: { login: "owner", password: "owner-pass-1" } })).headers["set-cookie"]).split(";")[0];
  const image = photo().toString("base64");

  const off = buildApp({ db, sms: new ConsoleSms() });
  assert.equal((await off.inject({ method: "POST", url: "/api/staff/recognize", payload: { kind: "receipt", image } })).statusCode, 401);
  const h0 = { cookie: await login(off) };
  assert.equal((await off.inject({ method: "POST", url: "/api/staff/recognize", headers: h0, payload: { kind: "receipt", image } })).statusCode, 503);

  const app = buildApp({ db, sms: new ConsoleSms(), vision: fake(() => '{"date":"23.09.26","amount":620,"category":"toll","fd":"1078341582","fp":"25034"}') });
  const h = { cookie: await login(app) };
  assert.equal((await app.inject({ method: "POST", url: "/api/staff/recognize", headers: h, payload: { kind: "passport", image } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/staff/recognize", headers: h, payload: { kind: "receipt", image: "aGVsbG8=" } })).statusCode, 400);
  const r = await app.inject({ method: "POST", url: "/api/staff/recognize", headers: h, payload: { kind: "receipt", image: "data:image/jpeg;base64," + image } });
  assert.equal(r.statusCode, 200);
  const body = r.json();
  assert.equal(body.fields.date, "23.09.2026");
  assert.ok(body.checks.some((c: { field: string; level: string }) => c.field === "fd" && c.level === "error"));
});
