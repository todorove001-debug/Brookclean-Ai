import { test } from "node:test";
import assert from "node:assert/strict";
import { rubWords, words } from "./quote.ts";
import { maskVin, normalizePhone, validateCar } from "./order.ts";
import { routeFor } from "./tariffs.ts";

// Intl ставит неразрывные пробелы между разрядами
const sp = (s: string) => s.replace(/\s/g, " ");

test("сумма прописью", () => {
  assert.equal(words(215000), "двести пятнадцать тысяч");
  assert.equal(words(1_021_001), "один миллион двадцать одна тысяча один");
  assert.equal(sp(rubWords(4800)), "4 800 (четыре тысячи восемьсот) рублей");
  assert.equal(sp(rubWords(122001)), "122 001 (сто двадцать две тысячи один) рубль");
});

test("валидация VIN и номера кузова", () => {
  const base = { car: "Toyota Prius", year: "2021", color: "Белый", body: "sedan" as const, value: "1600000", city: "Москва" };
  assert.deepEqual(validateCar({ ...base, vin: "ZVW51-6123456" }), {});
  assert.deepEqual(validateCar({ ...base, vin: "WBA2A32050VZ51833" }), {});
  assert.ok(validateCar({ ...base, vin: "123" }).vin);
  assert.ok(validateCar({ ...base, vin: "ZVW51-6123456", city: "Лондон" }).city);
});

test("телефон, маска VIN, маршрут", () => {
  assert.equal(normalizePhone("8 (913) 555-12-34"), "+79135551234");
  assert.equal(normalizePhone("123"), "");
  assert.equal(maskVin("KSP210-0089458"), "KSP•••••••9458");
  assert.deepEqual(routeFor("Кемерово"), ["Владивосток", "Хабаровск", "Чита", "Иркутск", "Красноярск", "Кемерово"]);
});
