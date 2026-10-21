import { createHash } from "node:crypto";
import type { CarForm, CustomerForm, Quote } from "@brookclean/shared";
import { CARRIER, ORIGIN } from "@brookclean/shared";

/** Версия шаблона договора: меняется при каждой правке текста договора. */
export const CONTRACT_VERSION = "2026-10-21";

/**
 * Данные, которые клиент подписывает кодом из SMS. Хеш от них фиксируется в журнале подписи,
 * чтобы потом доказать, что PDF соответствует подписанному.
 */
export function contractPayload(no: number, date: string, car: CarForm, customer: CustomerForm, q: Quote) {
  return {
    template: CONTRACT_VERSION,
    no,
    date,
    carrier: { name: CARRIER.name, inn: CARRIER.inn },
    customer: {
      fio: customer.fio.trim(),
      phone: customer.phone,
      passport: `${customer.passportSeries} ${customer.passportNumber}`,
      issued: customer.passportIssued.trim(),
      issuedDate: customer.passportDate,
      address: customer.address.trim(),
    },
    cargo: {
      car: car.car.trim(),
      vin: car.vin.trim().toUpperCase(),
      year: car.year,
      color: car.color.trim(),
      origin: ORIGIN,
      destination: car.city,
    },
    price: { delivery: q.delivery, insurance: q.insurance, total: q.total },
    consents: ["contract", "pep", "personal_data"],
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
