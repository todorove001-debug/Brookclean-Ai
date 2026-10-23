import { test } from "node:test";
import assert from "node:assert/strict";
import { legShare, licExpired, parseDriverSheet, parseVehicle } from "./fleet.ts";

test("госномера тягача и прицепа из строки Excel", () => {
  assert.deepEqual(parseVehicle("Volvo FH A482KP125 прицеп LUXUDA LZC9407BG OO564225"), {
    tractor: { model: "Volvo FH", plate: "А 482 КР 125" }, trailer: { model: "LUXUDA LZC9407BG", plate: "ОО 5642 25" },
  });
  // ноль вместо буквы О в номере прицепа
  assert.equal(parseVehicle("Scania R В117ОМ125, LOHR S2M52X A0080225").trailer.plate, "АО 0802 25");
});

test("лист реестра: группы, наёмные компании, паспорт и телефон", () => {
  const rows = [
    ["Реестр"], [],
    ["Транспортное средство", null, "Водители", "Дата рождения", "Паспорт", "Дата выдачи", "Телефон"],
    ["Свои"],
    ["Volvo FH А 482 КР 125 прицеп LUXUDA АО 2148 54", null, "Петров Сергей Иванович", new Date(1985, 4, 3), "0412 556677", "01.02.2015", "89140001122"],
    ["ООО «Сибирь-Транзит» ИНН 5406000000"],
    ["MAN TGX Е905УА54", null, "Волков Дмитрий Олегович", null, "5008 123456", null, 9140005566],
  ];
  const r = parseDriverSheet(rows);
  assert.ok("drivers" in r);
  assert.equal(r.drivers.length, 2);
  assert.equal(r.companies, 1);
  const [a, b] = r.drivers;
  assert.equal(a.own, true);
  assert.equal(a.tractorPlate, "А 482 КР 125");
  assert.equal(a.trailerPlate, "АО 2148 54");
  assert.equal(a.phone, "+79140001122");
  assert.deepEqual(a.docs.p1, { last_name: "Петров", first_name: "Сергей", middle_name: "Иванович", birth_date: "03.05.1985", series: "0412", number: "556677", issue_date: "01.02.2015" });
  assert.equal(b.own, false);
  assert.equal(b.companyName, "ООО «Сибирь-Транзит»");
  assert.equal(b.companyInn, "5406000000");
  assert.equal(b.phone, "+79140005566");
  assert.ok("error" in parseDriverSheet([["нет нужного столбца"]]));
});

test("просроченное ВУ и доля выручки при перегрузе", () => {
  const now = new Date("2026-10-23T00:00:00Z");
  assert.equal(licExpired({ lic: { valid_until: "22.10.2026" } }, now), true);
  assert.equal(licExpired({ lic: { valid_until: "24.10.2026" } }, now), false);
  assert.equal(licExpired({}, now), false);
  assert.equal(legShare(null, 5880, 10190), 1);
  assert.equal(legShare(1, 5880, 10190) + legShare(2, 5880, 10190), 1);
});
