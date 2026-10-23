import { test } from "node:test";
import assert from "node:assert/strict";
import { consentDoc, contractData, contractDoc, dateLong, docText, fioShort } from "./contract.ts";
import type { CarForm, CompanyForm, CustomerForm } from "./order.ts";

const car: CarForm = { car: "Toyota Prius", vin: "zvw51-6123456", year: "2021", color: "Белый", body: "sedan", value: "1 600 000", city: "Новосибирск" };
const customer: CustomerForm = {
  fio: "Иванов  Пётр Сергеевич", phone: "+79135551234", passportSeries: "5012", passportNumber: "345678",
  passportIssued: "ГУ МВД России по Новосибирской обл.", passportDate: "2019-06-14", address: "г. Новосибирск, ул. Кирова, д. 10, кв. 5",
};
const q = { tariff: 120000, cashback: 10000, delivery: 130000, insurance: 4800, total: 134800, needsManager: false };
const company: CompanyForm = {
  name: "ООО «Ромашка»", inn: "5401234567", kpp: "540101001", ogrn: "1155476000001", address: "г. Новосибирск, ул. Ленина, д. 1",
  bank: "АО «Банк»", bik: "045004001", account: "40702810000000000001", corrAccount: "30101810000000000001", contact: "Иванов Пётр", email: "",
};

test("в договор и согласие подставляются все данные клиента", () => {
  const d = contractData(685, "2026-10-23", car, customer, q);
  // Разряды Intl разделяет неразрывным пробелом
  const text = docText(contractDoc(d)).replace(/[\u00a0\u202f]/g, " ");
  for (const s of [
    "Договор № 685", "«23» октября 2026 г.", "гражданин Иванов Пётр Сергеевич", "Паспорт серия 5012 № 345678",
    "Выдан ГУ МВД России по Новосибирской обл., 14.06.2019", "Адрес регистрации: г. Новосибирск, ул. Кирова, д. 10, кв. 5",
    "Заказчик: +79135551234", "ZVW51-6123456", "Новосибирск, терминал выдачи", "/Иванов П.С./",
    "130 000 (сто тридцать тысяч) рублей 00 копеек", "1 600 000 (один миллион шестьсот тысяч) рублей",
    "4 800 (четыре тысячи восемьсот) рублей", "1.1. По настоящему договору", "5.12. Сторона, не исполнившая",
  ]) assert.ok(text.includes(s), s);
  assert.ok(!text.includes("кэшбэк"));

  const consent = docText(consentDoc(d));
  for (const s of ["Я, Иванов Пётр Сергеевич", "серия 5012 № 345678", "«14» июня 2019 г.", "ул. Кирова", "ИНН 253717132973"])
    assert.ok(consent.includes(s), s);
});

test("у партнёра Заказчик — компания из карточки, клиент подписывает как представитель", () => {
  const text = docText(contractDoc(contractData(686, "2026-10-23", car, customer, q, company)));
  for (const s of ["ООО «Ромашка» (ИНН 5401234567, ОГРН 1155476000001), в лице представителя Иванов Пётр Сергеевич", "именуемое далее «Заказчик»",
    "ИНН: 5401234567, КПП: 540101001", "Р/счёт 40702810000000000001", "БИК 045004001", "Представитель: Иванов Пётр Сергеевич"])
    assert.ok(text.includes(s), s);
  assert.ok(!text.includes("гражданин Иванов"));
});

test("до присвоения номера и даты вместо них пропуски", () => {
  const text = docText(contractDoc(contractData(null, null, car, customer, q)));
  assert.ok(text.includes("Договор № ____"));
  assert.equal(dateLong(null), "«___» __________ 20__ г.");
  assert.equal(fioShort("Петрова анна"), "Петрова А.");
});
