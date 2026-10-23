import { useEffect, useState } from "react";
import { BODY, CITIES, parseRub, type BodyType, type CarForm, type CustomerForm, type Quote } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { Field, QuoteCard } from "../Checkout.tsx";
import { staffApi } from "./api.ts";

const EMPTY_CAR: CarForm = { car: "", vin: "", year: "", color: "", body: "sedan", value: "", city: "Новосибирск" };
const EMPTY_CUSTOMER: CustomerForm = { fio: "", phone: "", passportSeries: "", passportNumber: "", passportIssued: "", passportDate: "", address: "" };

/** Менеджер вносит заявку со слов клиента; клиенту уходит SMS со ссылкой на подпись. */
export function NewOrderScreen() {
  const [car, setCar] = useState(EMPTY_CAR);
  const [customer, setCustomer] = useState(EMPTY_CUSTOMER);
  const [cashback, setCashback] = useState("");
  const [partner, setPartner] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ no: number; signUrl: string; smsSent: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  // Тарифы есть только на сервере: расчёт запрашиваем при каждом изменении города, кузова, стоимости и кэшбэка
  const [q, setQ] = useState<Quote | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      staffApi.quote({ ...car }, parseRub(cashback)).then((r) => alive && setQ(r), () => alive && setQ(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [car.city, car.body, car.value, cashback]);
  const setC = (k: keyof CarForm) => (v: string) => setCar((s) => ({ ...s, [k]: v }));
  const setU = (k: keyof CustomerForm) => (v: string) => setCustomer((s) => ({ ...s, [k]: v }));

  async function submit() {
    setBusy(true);
    setMessage("");
    setErrors({});
    try {
      setDone(await staffApi.createOrder({ car, customer, cashback: parseRub(cashback), partner, note }));
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.message);
      if (err.errors) setErrors(err.errors);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="col">
        <section className="card">
          <span className="pill ok">Заявка №{done.no} создана</span>
          <p>{done.smsSent ? "Клиенту отправлена SMS со ссылкой на договор." : "SMS отправить не удалось — передайте ссылку клиенту сами."} Строка появится в таблице заявок сразу, статус «Ждёт подписи».</p>
          <div className="copyline">
            <code>{done.signUrl}</code>
            <button className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(done.signUrl).then(() => setCopied(true), () => {})}>{copied ? "Скопировано" : "Копировать"}</button>
          </div>
          <button className="btn ghost" onClick={() => { setDone(null); setCar(EMPTY_CAR); setCustomer(EMPTY_CUSTOMER); setCashback(""); setPartner(""); setCopied(false); }}>
            Оформить ещё одну
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="admin-form">
      <section className="card">
        <h2>Автомобиль</h2>
        <Field id="car" label="Марка и модель" value={car.car} onChange={setC("car")} errors={errors} />
        <Field id="vin" label="VIN или номер кузова" value={car.vin} onChange={(v) => setC("vin")(v.toUpperCase())} errors={errors} className="mono" />
        <div className="row2">
          <Field id="year" label="Год" value={car.year} onChange={setC("year")} errors={errors} inputMode="numeric" maxLength={4} />
          <Field id="color" label="Цвет" value={car.color} onChange={setC("color")} errors={errors} />
        </div>
        <div className="field">
          <span className="label" id="nb-body">Тип кузова</span>
          <div className="seg" role="group" aria-labelledby="nb-body">
            {(Object.keys(BODY) as BodyType[]).map((k) => (
              <button key={k} type="button" aria-pressed={car.body === k} onClick={() => setCar((s) => ({ ...s, body: k }))}>{BODY[k].name}</button>
            ))}
          </div>
        </div>
        <Field id="value" label="Стоимость автомобиля, ₽" value={car.value} onChange={setC("value")} errors={errors} inputMode="numeric" />
        <div className="field">
          <label htmlFor="nb-city">Город доставки</label>
          <select id="nb-city" value={car.city} onChange={(e) => setC("city")(e.target.value)}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
      </section>
      <section className="card">
        <h2>Клиент</h2>
        <Field id="fio" label="ФИО полностью" value={customer.fio} onChange={setU("fio")} errors={errors} />
        <Field id="phone" label="Телефон" value={customer.phone} onChange={setU("phone")} errors={errors} inputMode="tel" hint="Сюда придёт ссылка на договор и код" />
        <div className="row2">
          <Field id="passportSeries" label="Паспорт: серия" value={customer.passportSeries} onChange={setU("passportSeries")} errors={errors} inputMode="numeric" maxLength={4} />
          <Field id="passportNumber" label="Номер" value={customer.passportNumber} onChange={setU("passportNumber")} errors={errors} inputMode="numeric" maxLength={6} />
        </div>
        <Field id="passportIssued" label="Кем выдан" value={customer.passportIssued} onChange={setU("passportIssued")} errors={errors} />
        <Field id="passportDate" label="Дата выдачи" value={customer.passportDate} onChange={setU("passportDate")} errors={errors} type="date" />
        <Field id="address" label="Адрес регистрации" value={customer.address} onChange={setU("address")} errors={errors} />
      </section>
      <div className="stack">
        <section className="card">
          <h2>Партнёр</h2>
          <Field id="partner" label="Партнёр (если есть)" value={partner} onChange={setPartner} errors={errors} />
          <Field id="cashback" label="Кэшбэк партнёру, ₽" value={cashback} onChange={setCashback} errors={errors} inputMode="numeric"
            hint="Прибавляется к перевозке, в договоре отдельно не указывается" />
        </section>
        <section className="card">
          <h2>Примечание</h2>
          <Field id="note" label="Для приёмщиков и водителя (если есть)" value={note} onChange={setNote} errors={errors}
            hint="Например: нет запасного ключа, клиент заберёт сам. Клиент примечание не видит" />
        </section>
        {q ? <QuoteCard city={car.city} body={car.body} q={q} /> : <section className="card"><p className="muted">Считаем стоимость…</p></section>}
        {message && <div className="callout warn" role="alert">{message}</div>}
        <button className="btn primary" disabled={busy} onClick={submit}>{busy ? "Создаём…" : "Создать и отправить клиенту"}</button>
      </div>
    </div>
  );
}
