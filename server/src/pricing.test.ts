import { test } from "node:test";
import assert from "node:assert/strict";
import { CITIES } from "@brookclean/shared";
import { TARIFF, quote } from "./pricing.ts";

test("расчёт: тариф + кэшбэк + страховка 0,3%", () => {
  const q = quote({ city: "Новосибирск", body: "sedan", value: 1_600_000, cashback: 5000 });
  assert.equal(q.tariff, 120000);
  assert.equal(q.delivery, 125000);
  assert.equal(q.insurance, 4800);
  assert.equal(q.total, 129800);
  assert.equal(q.needsManager, false);
  assert.equal(quote({ city: "Москва", body: "van", value: 1_000_000 }).needsManager, true);
});

test("список городов на сайте совпадает с тарифной сеткой", () => {
  assert.deepEqual([...CITIES], TARIFF.map((t) => t[0]));
});
