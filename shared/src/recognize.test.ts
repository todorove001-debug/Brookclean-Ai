import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDocument, checkReceipt, checkVin, hasErrors, normDate, normPlate, parseRuPassportMrz, vinCheckDigit } from "./recognize.ts";

const now = new Date("2026-10-23T06:00:00Z");
const levelOf = (checks: ReturnType<typeof checkReceipt>, field: string) => checks.filter((c) => c.field === field).map((c) => c.level);

test("VIN: контрольная цифра", () => {
  // Тягач и прицеп из теста распознавания: китайские VIN, контрольная цифра обязательна.
  assert.equal(vinCheckDigit("LZZ7CCWDXPC617626"), "X");
  assert.equal(checkVin("LZZ7CCWDXPC617626").level, "ok");
  assert.equal(checkVin("LA9925Y27P0YCY467").level, "ok");
  assert.equal(checkVin("LZZ7CCWDXPC617628").level, "warn", "одна цифра перепутана");
  assert.equal(checkVin("LZZ7CCWDXPC61762").level, "error");
  assert.equal(checkVin("LZZ7CCWDXPC6I7626").suggest, "LZZ7CCWDXPC617626");
  assert.equal(checkVin("LZZ7ССWDXРС617626").level, "ok", "кириллица вместо латиницы");
});

test("госномер и даты", () => {
  assert.equal(normPlate("У821ОС797"), "У 821 ОС 797");
  assert.equal(normPlate("y821oc797"), "У 821 ОС 797");
  assert.equal(normPlate("AA123425"), "АА 1234 25");
  assert.equal(normDate("23.09.26"), "23.09.2026");
  assert.equal(normDate("2026-09-23"), "23.09.2026");
});

test("СТС тягача: VIN и номер приводятся к одному виду", () => {
  const f = { plate: "У821ОС797", model: "SITRAK C7H ZZ4186V391HE", vin: "LZZ7CCWDXPC617626", year: "2023", color: "Белый", category: "C/N3" };
  const c = checkDocument("t1f", f, now);
  assert.equal(f.plate, "У 821 ОС 797");
  assert.ok(!hasErrors(c));
  assert.equal(levelOf(c, "vin")[0], "ok");
});

test("ВУ: формат номера и срок 10 лет", () => {
  const f = { number: "9919942400", categories: "B, C, CE", issue_date: "17.12.2020", valid_until: "17.12.2030", birth_date: "10.06.1988" };
  const c = checkDocument("lic", f, now);
  assert.ok(!hasErrors(c));
  assert.equal(c.find((x) => x.field === "number")!.suggest, "99 19 942400");
  const bad = checkDocument("lic", { ...f, number: "99 19 94240", valid_until: "17.12.2031" }, now);
  assert.deepEqual(levelOf(bad, "number"), ["error"]);
  assert.deepEqual(levelOf(bad, "valid_until"), ["warn"]);
});

test("паспорт: нижняя строка (MRZ) ловит перепутанную цифру", () => {
  // Серия 45 23, номер 923969, родился 10.06.1988, выдан 28.12.2023, код 770-125.
  const line = mrzLine("452", "923969", "880610", "3", "231228", "770125");
  assert.deepEqual(parseRuPassportMrz(line), { series: "45 23", number: "923969", birth_date: "10.06.1988", issue_date: "28.12.2023", code: "770-125" });
  assert.equal(parseRuPassportMrz(line.slice(0, 5) + "8" + line.slice(6)), null, "контрольная цифра не сошлась");

  const f = { last_name: "ЗАРХОШЕВ", first_name: "ЖАМАЛ", middle_name: "ИЛЬЯСОВИЧ", birth_date: "10.06.1988", birth_place: "С. СУЗАК",
    series: "4523", number: "923960", issued_by: "ГУ МВД РОССИИ ПО Г. МОСКВЕ", issue_date: "28.12.2023", code: "770125" };
  const c = checkDocument("p1", f, now, line);
  assert.equal(f.series, "45 23");
  assert.equal(f.code, "770-125");
  const num = c.find((x) => x.field === "number")!;
  assert.equal(num.level, "error");
  assert.equal(num.suggest, "923969");
});

test("паспорт без MRZ: формат и возраст", () => {
  const c = checkDocument("p1", { series: "452", number: "923969", birth_date: "10.06.2015", issue_date: "28.12.2023", code: "770-125" }, now);
  assert.deepEqual(levelOf(c, "series"), ["error"]);
  assert.ok(levelOf(c, "issue_date").includes("error"));
  assert.ok(levelOf(c, "last_name").includes("warn"), "пустое поле");
});

test("чек: ФД и ФП перепутаны, цена литра, дата из будущего", () => {
  const f = { date: "13.09.26", amount: "620", fn: "7380440902353315", fd: "1078341582", fp: "25034", category: "toll" };
  const c = checkReceipt(f, now);
  assert.equal(f.date, "13.09.2026");
  assert.equal(c.find((x) => x.field === "fd" && x.level === "error")!.suggest, "25034");

  const fuel = checkReceipt({ date: "23.09.2026", amount: "25566", liters: "30", category: "fuel" }, now);
  assert.ok(levelOf(fuel, "liters").includes("error"), "852 ₽ за литр");
  assert.ok(!hasErrors(checkReceipt({ date: "23.09.2026", amount: "25566", liters: "300", category: "fuel" }, now)));

  assert.ok(levelOf(checkReceipt({ date: "23.11.2026", amount: "100" }, now), "date").includes("error"));
  assert.ok(levelOf(checkReceipt({ amount: "0" }, now), "amount").includes("error"));
  assert.ok(levelOf(checkReceipt({ fn: "73В0440902353315", amount: "1" }, now), "fn").includes("error"));
});

test("чек: поля из QR-кода не требуют сверки", () => {
  const c = checkReceipt({ date: "23.09.2026", amount: "25566", fn: "7380440903537975", fd: "84827", fp: "1455885666" }, now, ["date", "amount", "fn", "fd", "fp"]);
  assert.ok(c.filter((x) => ["amount", "fd", "fp"].includes(x.field)).every((x) => x.level === "ok"));
});

/** Строит вторую строку MRZ паспорта РФ с верными контрольными цифрами. */
function mrzLine(series3: string, number: string, birth: string, series4: string, issue: string, code: string) {
  const v = (c: string) => (/\d/.test(c) ? +c : c === "<" ? 0 : c.charCodeAt(0) - 55);
  const cd = (s: string) => String([...s].reduce((a, c, i) => a + v(c) * [7, 3, 1][i % 3], 0) % 10);
  const doc = series3 + number, opt = series4 + issue + code + "<";
  const l = doc + cd(doc) + "RUS" + birth + cd(birth) + "M" + "<<<<<<<" + opt + cd(opt);
  return l + cd(l.slice(0, 10) + l.slice(13, 20) + l.slice(21, 43));
}
