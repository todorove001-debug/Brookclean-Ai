import { CITIES, type BodyType } from "./tariffs.ts";

export interface CarForm {
  car: string;
  vin: string;
  year: string;
  color: string;
  body: BodyType;
  value: string;
  city: string;
}

export interface CustomerForm {
  fio: string;
  phone: string;
  passportSeries: string;
  passportNumber: string;
  passportIssued: string;
  passportDate: string;
  address: string;
}

export type OrderStatus = "draft" | "signed" | "paid" | "loading" | "in_transit" | "arrived" | "delivered";

/** То, что видит клиент по ссылке трекинга: без ФИО и телефона. */
export interface TrackingView {
  orderNo: number;
  car: string;
  vinMasked: string;
  city: string;
  status: OrderStatus;
  km: number;
  destKm: number;
  truck: string | null;
  loadDate: string | null;
  events: Array<{ at: string; city: string; note: string }>;
  review: { rating: number; text: string } | null;
}

export type Errors<T> = Partial<Record<keyof T, string>>;

const VIN17 = /^[A-HJ-NPR-Z0-9]{17}$/;
const FRAME = /^[A-Z0-9]{2,7}-\d{5,7}$/;
const digits = (v: string) => String(v).replace(/\D/g, "");

export function normalizePhone(v: string): string {
  let d = digits(v);
  if (d.length === 10) d = "7" + d;
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  return d.length === 11 ? "+" + d : "";
}

export function validateCar(f: CarForm, now = new Date()): Errors<CarForm> {
  const e: Errors<CarForm> = {};
  const maxYear = now.getFullYear() + 1;
  if (f.car.trim().length < 2) e.car = "Укажите марку и модель";
  const v = f.vin.trim().toUpperCase();
  if (!(VIN17.test(v) || FRAME.test(v))) e.vin = "Нужен VIN из 17 знаков или номер кузова вида ZVW51-6123456";
  const y = Number(f.year);
  if (!(y >= 1990 && y <= maxYear)) e.year = `Год от 1990 до ${maxYear}`;
  if (!f.color.trim()) e.color = "Укажите цвет";
  if (Number(digits(f.value)) < 100000) e.value = "Стоимость от 100 000 ₽";
  if (!CITIES.includes(f.city)) e.city = "Выберите город из списка";
  return e;
}

export function validateCustomer(f: CustomerForm): Errors<CustomerForm> {
  const e: Errors<CustomerForm> = {};
  if (f.fio.trim().split(/\s+/).length < 2) e.fio = "Фамилия, имя и отчество полностью";
  if (!normalizePhone(f.phone)) e.phone = "Номер в формате +7 900 000 00 00";
  if (!/^\d{4}$/.test(f.passportSeries)) e.passportSeries = "4 цифры";
  if (!/^\d{6}$/.test(f.passportNumber)) e.passportNumber = "6 цифр";
  if (f.passportIssued.trim().length < 5) e.passportIssued = "Кем выдан паспорт";
  if (!f.passportDate) e.passportDate = "Дата выдачи";
  if (f.address.trim().length < 8) e.address = "Адрес регистрации";
  return e;
}

export function maskVin(v: string): string {
  if (v.length <= 6) return v;
  return v.slice(0, 3) + "•".repeat(v.length - 7) + v.slice(-4);
}

export const parseRub = (v: string) => Number(digits(v)) || 0;
