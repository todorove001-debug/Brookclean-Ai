import { test } from "node:test";
import assert from "node:assert/strict";
import { PHOTO_SLOTS, VIDEO_SLOTS } from "@brookclean/shared";
import { openDb } from "./db.ts";
import { buildApp } from "./app.ts";
import { ConsoleSms } from "./sms.ts";
import { ensureOwner } from "./staff.ts";
import { MemoryStore, S3Store } from "./media.ts";
import type { Vision } from "./recognize.ts";

const car = { car: "Honda Fit", vin: "GS4-1009355", year: "2023", color: "Серебристый", body: "sedan", value: "1050000", city: "Красноярск" };
const customer = {
  fio: "Жаворонкова Людмила Викторовна", phone: "+7 908 123 45 68", passportSeries: "0412", passportNumber: "556677",
  passportIssued: "ГУ МВД России по Красноярскому краю", passportDate: "2018-03-01", address: "г. Красноярск, ул. Мира, д. 5",
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 1)]);
const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** ИИ находит скол только на фото «Спереди» — его узнаём по первому вызову. */
function fakeVision(): Vision & { calls: number } {
  const v = {
    calls: 0,
    async ask() {
      v.calls++;
      const damages = v.calls === 1 ? [{ part: "капот, передняя кромка", code: "S", desc: "скол краски", confidence: "high" }] : [];
      return { text: JSON.stringify({ quality: "ok", damages }), model: "qwen-test" };
    },
  };
  return v;
}

async function setup() {
  const db = openDb(":memory:", 700);
  ensureOwner(db, "owner@brookclean.ru", "owner-pass-1");
  const media = new MemoryStore();
  const vision = fakeVision();
  const app = buildApp({ db, sms: new ConsoleSms(), media, vision });
  const login = async (l: string, p: string) => {
    const r = await app.inject({ method: "POST", url: "/api/staff/login", payload: { login: l, password: p } });
    return { cookie: String(r.headers["set-cookie"]).split(";")[0] };
  };
  const owner = await login("owner@brookclean.ru", "owner-pass-1");
  for (const [name, l, role] of [["Ольга", "olga", "acceptor"], ["Анна", "anna", "manager"]])
    await app.inject({ method: "POST", url: "/api/staff/users", headers: owner, payload: { name, login: l, password: "password-1", role } });
  const created = (await app.inject({ method: "POST", url: "/api/staff/orders", headers: owner, payload: { car, customer } })).json();
  return { app, db, media, vision, owner, acc: await login("olga", "password-1"), mgr: await login("anna", "password-1"), no: created.no as number };
}

/** Ячейка: ссылка на загрузку → PUT файла → подтверждение. */
async function upload(app: Awaited<ReturnType<typeof setup>>["app"], h: { cookie: string }, no: number, slot: string, video = false, stage = "priemka") {
  const contentType = video ? "video/mp4" : "image/jpeg";
  const body = video ? Buffer.alloc(5000, 2) : JPEG;
  const u = await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/upload`, headers: h, payload: { slot, contentType, size: body.length, durationSec: video ? 48 : undefined } });
  assert.equal(u.statusCode, 200, u.body);
  const { key, url } = u.json();
  const put = await app.inject({ method: "PUT", url, headers: { ...h, "content-type": contentType }, payload: body });
  assert.equal(put.statusCode, 200, put.body);
  const r = await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/media`, headers: h, payload: { slot, key, contentType, durationSec: video ? 48 : undefined } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}

const settle = () => new Promise((ok) => setTimeout(ok, 20));

test("приёмка: 35 фото и 6 видео, находки ИИ, подписи сдал/принял, сброс подписей", async () => {
  const { app, db, media, acc, mgr, no } = await setup();
  const stage = "priemka";

  // Заявка сразу видна приёмщику
  const list = (await app.inject({ url: "/api/staff/acts", headers: acc })).json();
  assert.equal(list[0].no, no);
  let act = (await app.inject({ url: `/api/staff/acts/${no}/${stage}`, headers: acc })).json();
  assert.equal(act.giveName, customer.fio);
  assert.equal(act.takeName, "Ольга");
  assert.ok(act.blockers.some((b: string) => b.includes("не подписал договор")));
  assert.ok(act.blockers.some((b: string) => b.includes("не хватает 35")));

  db.prepare("UPDATE orders SET status = 'signed' WHERE no = ?").run(no);

  // Видео длиннее минуты не принимаем
  const long = await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/upload`, headers: acc, payload: { slot: "v_doors", contentType: "video/mp4", size: 1000, durationSec: 95 } });
  assert.equal(long.statusCode, 400);

  for (const s of PHOTO_SLOTS) await upload(app, acc, no, s.id);
  for (const s of VIDEO_SLOTS) await upload(app, acc, no, s.id, true);
  assert.equal(media.files.size, 41);
  await settle();

  act = (await app.inject({ url: `/api/staff/acts/${no}/${stage}`, headers: acc })).json();
  assert.equal(act.media.length, 41);
  assert.ok(act.media.filter((m: { ai: unknown }) => m.ai).every((m: { ai: { status: string } }) => m.ai.status === "done"));
  assert.equal(act.suggestions.length, 1);
  const sug = act.suggestions[0];
  assert.equal(sug.code, "S");
  assert.equal(sug.state, "pending");
  assert.ok(act.blockers.some((b: string) => b.includes("Находки ИИ")));
  assert.ok(act.blockers.some((b: string) => b.includes("ключей")));

  // Пока есть находка без решения, подписать нельзя
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/sign`, headers: acc, payload: { who: "give", img: SIG } })).statusCode, 409);

  act = (await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/suggestions/${sug.id}`, headers: acc, payload: { state: "yes" } })).json();
  assert.equal(act.marks.length, 1);
  assert.equal(act.marks[0].src, "ai");
  act = (await app.inject({ method: "PATCH", url: `/api/staff/acts/${no}/${stage}`, headers: acc, payload: { details: { keys: "2", plate: "А 123 ВС 125" }, cond: ["dark"] } })).json();
  assert.deepEqual(act.blockers, []);

  // «Принял» раньше «Сдал» нельзя
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/sign`, headers: acc, payload: { who: "take", img: SIG } })).statusCode, 409);
  act = (await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/sign`, headers: acc, payload: { who: "give", img: SIG, device: "iPhone" } })).json();
  assert.equal(act.give.name, customer.fio);

  // Новая отметка после подписи сбрасывает подпись
  act = (await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/marks`, headers: acc, payload: { code: "A1", part: "левая дверь", x: 0.4, y: 0.8 } })).json();
  assert.equal(act.give, null);

  await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/sign`, headers: acc, payload: { who: "give", img: SIG } });
  act = (await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/sign`, headers: acc, payload: { who: "take", img: SIG } })).json();
  assert.ok(act.closedAt);
  assert.equal(act.take.name, "Ольга");

  // Закрытый акт: приёмщик ничего не меняет, менеджер снимает отметку с комментарием, подписи остаются
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/acts/${no}/${stage}`, headers: acc, payload: { notes: "x" } })).statusCode, 409);
  const mark = act.marks.find((m: { code: string }) => m.code === "A1");
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/marks/${mark.id}/remove`, headers: acc, payload: { reason: "ошибка" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/marks/${mark.id}/remove`, headers: mgr, payload: { reason: "" } })).statusCode, 400);
  act = (await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/marks/${mark.id}/remove`, headers: mgr, payload: { reason: "грязь, а не царапина" } })).json();
  const removed = act.marks.find((m: { id: number }) => m.id === mark.id);
  assert.equal(removed.removed, true);
  assert.equal(removed.history.at(-1).manager, true);
  assert.ok(act.give && act.take && act.closedAt);

  // Менеджер видит акт, но не грузит фото; водитель не видит акты
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/upload`, headers: mgr, payload: { slot: "front", contentType: "image/jpeg", size: 10 } })).statusCode, 403);
});

test("переснятое фото: старые находки ИИ без решения убираются, старый файл удаляется", async () => {
  const { app, db, media, acc, no } = await setup();
  const stage = "priemka";
  db.prepare("UPDATE orders SET status = 'signed' WHERE no = ?").run(no);
  await upload(app, acc, no, "front");
  await settle();
  let act = (await app.inject({ url: `/api/staff/acts/${no}/${stage}`, headers: acc })).json();
  assert.equal(act.suggestions.length, 1);
  await upload(app, acc, no, "front");
  await settle();
  act = (await app.inject({ url: `/api/staff/acts/${no}/${stage}`, headers: acc })).json();
  assert.equal(act.suggestions.length, 0);
  assert.equal(media.files.size, 1);
  // Чужой ключ подтвердить нельзя
  const bad = await app.inject({ method: "POST", url: `/api/staff/acts/${no}/${stage}/media`, headers: acc, payload: { slot: "rear", key: `acts/${no}/priemka/front-abc.jpg`, contentType: "image/jpeg" } });
  assert.equal(bad.statusCode, 400);
});

test("S3: подписанная ссылка на загрузку без ключей в открытом виде", () => {
  const s3 = new S3Store({ endpoint: "https://s3.regru.cloud", region: "ru-1", bucket: "brookclean-media", accessKey: "AK", secretKey: "SECRET" },
    () => new Date("2026-10-23T08:00:00Z"));
  const url = new URL(s3.presign("PUT", "acts/700/front-1a2b.jpg", 3600));
  assert.equal(url.pathname, "/brookclean-media/acts/700/front-1a2b.jpg");
  assert.equal(url.searchParams.get("X-Amz-Credential"), "AK/20261023/ru-1/s3/aws4_request");
  assert.equal(url.searchParams.get("X-Amz-Date"), "20261023T080000Z");
  assert.match(url.searchParams.get("X-Amz-Signature")!, /^[0-9a-f]{64}$/);
  assert.ok(!url.href.includes("SECRET"));
  // Подпись зависит от метода: ссылкой на просмотр нельзя загрузить файл
  assert.notEqual(new URL(s3.presign("GET", "acts/700/front-1a2b.jpg", 3600)).searchParams.get("X-Amz-Signature"), url.searchParams.get("X-Amz-Signature"));
});

test("перегруз в Новосибирске: приём на терминал и погрузка с терминала — отдельные разделы акта", async () => {
  const { app, db, owner, acc, no: krsk } = await setup();
  // Красноярск до Новосибирска: перегружать там нечего
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/orders/${krsk}`, headers: owner, payload: { transfer: "Новосибирск" } })).statusCode, 400);

  const msk = (await app.inject({ method: "POST", url: "/api/staff/orders", headers: owner, payload: { car: { ...car, city: "Москва" }, customer } })).json().no;
  db.prepare("UPDATE orders SET status = 'signed' WHERE no = ?").run(msk);
  await app.inject({ method: "PUT", url: "/api/staff/trips/R-1", headers: owner, payload: { dest: "Новосибирск", truck: "Volvo", driver: "Сергей Петров" } });
  await app.inject({ method: "PUT", url: "/api/staff/trips/R-2", headers: owner, payload: { dest: "Москва", truck: "MAN", driver: "Олег Ким" } });
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/orders/${msk}`, headers: owner, payload: { tripId: "R-1" } })).statusCode, 400);
  const o = (await app.inject({ method: "PATCH", url: `/api/staff/orders/${msk}`, headers: owner, payload: { transfer: "Новосибирск", tripId: "R-1", trip2Id: "R-2" } })).json();
  assert.equal(o.transfer, "Новосибирск");
  assert.equal(o.trip2Id, "R-2");

  await app.inject({ method: "POST", url: "/api/staff/users", headers: owner, payload: { name: "Андрей", login: "nsk", password: "password-1", role: "acceptor", site: "Новосибирск" } });
  const nsk = { cookie: String((await app.inject({ method: "POST", url: "/api/staff/login", payload: { login: "nsk", password: "password-1" } })).headers["set-cookie"]).split(";")[0] };

  // Владивосток видит только приёмку; терминал не видит машины, пока они на стоянке во Владивостоке
  const vl = (await app.inject({ url: "/api/staff/acts", headers: acc })).json();
  assert.ok(vl.every((r: { stage: string }) => r.stage === "priemka"));
  assert.deepEqual((await app.inject({ url: "/api/staff/acts", headers: nsk })).json(), []);

  // Принять на терминал можно только после закрытой погрузки и только на своей площадке
  let r = await app.inject({ method: "PATCH", url: `/api/staff/acts/${msk}/term_in`, headers: nsk, payload: { notes: "x" } });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /Погрузка в автовоз/);
  // Приёмку и погрузку во Владивостоке проверяют другие тесты — здесь закрываем их сразу
  await app.inject({ url: `/api/staff/acts/${msk}/priemka`, headers: acc });
  db.prepare("UPDATE acts SET closed_at = '2026-10-23T08:00:00Z', details = ? WHERE stage = 'priemka'")
    .run(JSON.stringify({ plate: "", ptsType: "Оригинал", ptsNo: "", keys: "2", docs: "" }));
  assert.deepEqual((await app.inject({ url: "/api/staff/acts", headers: acc })).json().filter((x: { no: number }) => x.no === msk)
    .map((x: { stage: string; group: string }) => [x.stage, x.group]), [["pogruzka", "load"]]);
  await app.inject({ url: `/api/staff/acts/${msk}/pogruzka`, headers: acc });
  db.prepare("UPDATE acts SET closed_at = '2026-10-23T09:00:00Z' WHERE stage = 'pogruzka'").run();
  const ns = (await app.inject({ url: "/api/staff/acts", headers: nsk })).json();
  assert.deepEqual(ns.map((x: { no: number; group: string }) => [x.no, x.group]), [[msk, "incoming"]]);
  assert.equal(ns[0].trip.id, "R-1");
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/acts/${msk}/term_in`, headers: acc, payload: { notes: "x" } })).statusCode, 409);

  const act = (await app.inject({ url: `/api/staff/acts/${msk}/term_in`, headers: nsk })).json();
  assert.equal(act.giveName, "Сергей Петров");
  assert.equal(act.takeName, "Андрей");
  assert.equal(act.giveRole, "Водитель рейса R-1");
  assert.deepEqual(act.sections.map((x: { stage: string }) => x.stage), ["priemka", "pogruzka", "term_in", "term_out", "vygruzka"]);
  assert.ok(!act.blockers.some((b: string) => b.includes("Сначала закройте")));
  r = await app.inject({ method: "PATCH", url: `/api/staff/acts/${msk}/term_in`, headers: nsk, payload: { details: { keys: "1" } } });
  assert.equal(r.statusCode, 400);

  // Погрузка с терминала: сдаёт приёмщик, принимает водитель второго рейса
  db.prepare("UPDATE acts SET closed_at = '2026-10-25T08:00:00Z' WHERE stage = 'term_in'").run();
  const ns2 = (await app.inject({ url: "/api/staff/acts", headers: nsk })).json();
  assert.deepEqual(ns2.map((x: { stage: string; group: string }) => [x.stage, x.group]), [["term_out", "yard"]]);
  const out = (await app.inject({ url: `/api/staff/acts/${msk}/term_out`, headers: nsk })).json();
  assert.equal(out.giveName, "Андрей");
  assert.equal(out.takeName, "Олег Ким");
  assert.equal(out.takeRole, "Водитель рейса R-2");
  const trip2 = (await app.inject({ url: "/api/staff/trips", headers: owner })).json().find((t: { id: string }) => t.id === "R-2");
  assert.deepEqual(trip2.orders, [msk]);
  // Выдачу после перегруза оформляет водитель второго рейса
  const last = (await app.inject({ url: `/api/staff/acts/${msk}/vygruzka`, headers: owner })).json();
  assert.equal(last.giveRole, "Водитель рейса R-2");
  assert.equal(last.giveName, "Олег Ким");
});

test("водитель: погрузка во Владивостоке — 4 угла и подписи, выдача получателю в его городе", async () => {
  const { app, db, owner, acc, no } = await setup();
  db.prepare("UPDATE orders SET status = 'signed' WHERE no = ?").run(no);
  const u = (await app.inject({ method: "POST", url: "/api/staff/users", headers: owner, payload: { name: "Сергей Петров", login: "sergey", password: "password-1", role: "driver" } })).json();
  await app.inject({ method: "POST", url: "/api/staff/users", headers: owner, payload: { name: "Иван", login: "ivan", password: "password-1", role: "driver" } });
  const login = async (l: string) => ({ cookie: String((await app.inject({ method: "POST", url: "/api/staff/login", payload: { login: l, password: "password-1" } })).headers["set-cookie"]).split(";")[0] });
  const drv = await login("sergey"), other = await login("ivan");

  // Без рейса водителю здесь нечего делать
  assert.deepEqual((await app.inject({ url: "/api/staff/acts", headers: drv })).json(), []);
  await app.inject({ method: "PUT", url: "/api/staff/trips/R-7", headers: owner, payload: { dest: "Красноярск", truck: "Volvo FH", driverId: u.id } });
  await app.inject({ method: "PATCH", url: `/api/staff/orders/${no}`, headers: owner, payload: { tripId: "R-7" } });
  assert.deepEqual((await app.inject({ url: "/api/staff/acts", headers: drv })).json().map((x: { stage: string; group: string }) => [x.stage, x.group]),
    [["pogruzka", "load"], ["vygruzka", "deliver"]]);
  // Чужой водитель машину не видит, приёмка водителю только для чтения
  assert.equal((await app.inject({ url: `/api/staff/acts/${no}/pogruzka`, headers: other })).statusCode, 403);
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/acts/${no}/priemka`, headers: drv, payload: { notes: "x" } })).statusCode, 409);

  // Приёмщик закрыл приёмку — сдаёт машину водителю тот же приёмщик
  await app.inject({ url: `/api/staff/acts/${no}/priemka`, headers: acc });
  db.prepare("UPDATE acts SET closed_at = '2026-10-23T08:00:00Z', details = ? WHERE stage = 'priemka'")
    .run(JSON.stringify({ plate: "", ptsType: "Оригинал", ptsNo: "", keys: "2", docs: "" }));
  let act = (await app.inject({ url: `/api/staff/acts/${no}/pogruzka`, headers: drv })).json();
  assert.equal(act.giveName, "Ольга");
  assert.equal(act.takeName, "Сергей Петров");
  assert.equal(act.takeRole, "Водитель рейса R-7");
  assert.equal(act.canEdit, true);
  assert.ok(act.blockers.includes("Фото: не хватает 4 из 4"));
  assert.ok(!act.blockers.some((b: string) => b.startsWith("Видео")));
  // На погрузке только 4 угла
  const extra = await app.inject({ method: "POST", url: `/api/staff/acts/${no}/pogruzka/upload`, headers: drv, payload: { slot: "roof", contentType: "image/jpeg", size: 10 } });
  assert.equal(extra.statusCode, 400);
  for (const s of ["front_left", "rear_left", "rear_right", "front_right"]) await upload(app, drv, no, s, false, "pogruzka");
  await settle();
  act = (await app.inject({ url: `/api/staff/acts/${no}/pogruzka`, headers: drv })).json();
  for (const sg of act.suggestions) await app.inject({ method: "POST", url: `/api/staff/acts/${no}/pogruzka/suggestions/${sg.id}`, headers: drv, payload: { state: "no" } });
  await app.inject({ method: "POST", url: `/api/staff/acts/${no}/pogruzka/sign`, headers: drv, payload: { who: "give", img: SIG } });
  act = (await app.inject({ method: "POST", url: `/api/staff/acts/${no}/pogruzka/sign`, headers: drv, payload: { who: "take", img: SIG } })).json();
  assert.ok(act.closedAt, JSON.stringify(act.blockers));
  assert.deepEqual((await app.inject({ url: "/api/staff/acts", headers: acc })).json().map((x: { stage: string; group: string }) => [x.stage, x.group]), [["pogruzka", "done"]]);

  // Выдача: сдаёт водитель, принимает получатель; подписать — только в городе получателя
  act = (await app.inject({ url: `/api/staff/acts/${no}/vygruzka`, headers: drv })).json();
  assert.equal(act.giveName, "Сергей Петров");
  assert.equal(act.takeName, customer.fio);
  assert.equal(act.takeRole, "Грузополучатель");
  assert.equal(act.place, "Красноярск");
  assert.ok(act.blockers.some((b: string) => b.includes("не в городе Красноярск")));
  // Приёмщик Владивостока выдачу не оформляет
  assert.equal((await app.inject({ method: "PATCH", url: `/api/staff/acts/${no}/vygruzka`, headers: acc, payload: { notes: "x" } })).statusCode, 409);
  for (const s of PHOTO_SLOTS) await upload(app, drv, no, s.id, false, "vygruzka");
  for (const s of VIDEO_SLOTS) await upload(app, drv, no, s.id, true, "vygruzka");
  await settle();
  act = (await app.inject({ url: `/api/staff/acts/${no}/vygruzka`, headers: drv })).json();
  for (const sg of act.suggestions) await app.inject({ method: "POST", url: `/api/staff/acts/${no}/vygruzka/suggestions/${sg.id}`, headers: drv, payload: { state: "no" } });
  assert.equal((await app.inject({ method: "POST", url: `/api/staff/acts/${no}/vygruzka/sign`, headers: drv, payload: { who: "give", img: SIG } })).statusCode, 409);
  db.prepare("UPDATE trips SET km = 9000 WHERE id = 'R-7'").run();
  await app.inject({ method: "POST", url: `/api/staff/acts/${no}/vygruzka/sign`, headers: drv, payload: { who: "give", img: SIG } });
  act = (await app.inject({ method: "POST", url: `/api/staff/acts/${no}/vygruzka/sign`, headers: drv, payload: { who: "take", img: SIG } })).json();
  assert.ok(act.closedAt, JSON.stringify(act.blockers));
  assert.equal(act.take.name, customer.fio);
  assert.equal((db.prepare("SELECT status FROM orders WHERE no = ?").get(no) as { status: string }).status, "delivered");
  assert.deepEqual((await app.inject({ url: "/api/staff/acts", headers: drv })).json().map((x: { stage: string; group: string }) => [x.stage, x.group]), [["vygruzka", "done"]]);
});
