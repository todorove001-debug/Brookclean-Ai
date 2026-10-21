const test = require("node:test");
const assert = require("node:assert");
const c = require("../src/contract");
const { renderContract, renderConsent } = require("../src/node");
const example = require("../scripts/example-order.json");

test("сумма прописью", () => {
  assert.strictEqual(c.words(215000), "двести пятнадцать тысяч");
  assert.strictEqual(c.words(1600000), "один миллион шестьсот тысяч");
  assert.strictEqual(c.words(4800), "четыре тысячи восемьсот");
  assert.strictEqual(c.words(21000), "двадцать одна тысяча");
  assert.strictEqual(c.rubWords(1), "1 (один) рубль 00 копеек");
  assert.strictEqual(c.rubWords(134800), "134 800 (сто тридцать четыре тысячи восемьсот) рублей 00 копеек");
});

test("страховка 0,3%, кэшбэк внутри перевозки", () => {
  assert.deepStrictEqual(c.calcPrice(example), { delivery: 130000, insurance: 4800, total: 134800 });
});

test("кэшбэк не попадает в текст договора", () => {
  const json = JSON.stringify(c.buildContractDoc(example));
  assert.ok(!/кэшб|кешб|cashback/i.test(json));
  assert.ok(!json.includes("120 000"), "тариф без кэшбэка не должен светиться");
  assert.ok(json.includes("130 000 (сто тридцать тысяч)"));
});

test("без обязательных полей договор не формируется", () => {
  assert.throws(() => c.buildContractDoc({ ...example, client: { ...example.client, fio: "" } }), /ФИО/);
});

test("PDF собираются", async () => {
  for (const buf of [await renderContract(example), await renderConsent(example)]) {
    assert.strictEqual(buf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(buf.length > 10000);
  }
});
