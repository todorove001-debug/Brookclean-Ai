import { useEffect, useMemo, useState } from "react";
import {
  BODY, CARRIER, CITIES, GAME_URL, ORIGIN, parseRub, quote, rub, rubWords, validateCar, validateCustomer,
  type BodyType, type CarForm, type CustomerForm, type Errors,
} from "@brookclean/shared";
import { api, ApiError, type Order } from "./api.ts";
import { load, rememberOrder, remove, save } from "./storage.ts";
import { SITE_ORIGIN, navigate, searchParam } from "./router.ts";

const EMPTY_CAR: CarForm = { car: "", vin: "", year: "", color: "", body: "sedan", value: "", city: "Новосибирск" };
const EMPTY_CUSTOMER: CustomerForm = {
  fio: "", phone: "", passportSeries: "", passportNumber: "", passportIssued: "", passportDate: "", address: "",
};
const CARS = ["Toyota Prius", "Toyota Corolla Cross", "Toyota Yaris", "Toyota RAV4", "Honda Fit", "Honda Vezel", "Nissan Note", "Mazda CX-5", "Subaru Forester", "Suzuki Swift"];
const STEPS = ["Автомобиль", "Заказчик", "Документы", "Подпись"];

export function Checkout() {
  // Черновик сохраняется на устройстве, чтобы не потерять ввод при сворачивании браузера
  const [car, setCar] = useState<CarForm>(() => load("draft-car", EMPTY_CAR));
  const [customer, setCustomer] = useState<CustomerForm>(() => load("draft-customer", EMPTY_CUSTOMER));
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [agree, setAgree] = useState({ contract: false, pep: false, personalData: false });
  const [partner, setPartner] = useState<{ token: string; partner: string; cashback: number } | null>(null);
  const [draft, setDraft] = useState<{ id: string; no: number; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [signed, setSigned] = useState<Order | null>(null);

  useEffect(() => save("draft-car", car), [car]);
  useEffect(() => save("draft-customer", customer), [customer]);

  useEffect(() => {
    const p = searchParam("p");
    if (p) api.partnerLink(p).then((r) => setPartner({ token: p, ...r })).catch(() => {});
  }, []);

  const q = useMemo(
    () => quote({ city: car.city, body: car.body, value: parseRub(car.value), cashback: partner?.cashback }),
    [car.city, car.body, car.value, partner],
  );

  const go = (n: number) => {
    setMessage("");
    setStep(n);
    scrollTo(0, 0);
  };

  async function next() {
    if (step === 0) {
      const e = validateCar(car);
      setErrors(e as Record<string, string>);
      if (!Object.keys(e).length) go(1);
    } else if (step === 1) {
      const e = validateCustomer(customer);
      setErrors(e as Record<string, string>);
      if (!Object.keys(e).length) go(2);
    } else if (step === 2) {
      go(3);
    } else if (step === 3) {
      draft ? await sign() : await sendCode();
    }
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      const err = e as ApiError;
      setMessage(err.message);
      if (err.errors) {
        setErrors(err.errors);
        if (Object.keys(err.errors).some((k) => k in EMPTY_CAR)) go(0);
        else go(1);
      }
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () => run(async () => {
    const r = await api.createOrder({ car, customer, partnerToken: partner?.token, consents: agree });
    setDraft(r);
  });

  const resend = () => run(async () => {
    if (!draft) return;
    const r = await api.resend(draft.id);
    setDraft({ ...draft, devCode: r.devCode });
    setMessage("Код отправлен ещё раз");
  });

  const sign = () => run(async () => {
    if (!draft) return;
    const o = await api.sign(draft.id, code);
    rememberOrder({ id: o.id, no: o.no, car: o.car.car, city: o.car.city, trackToken: o.trackToken! });
    remove("draft-car");
    remove("draft-customer");
    setSigned(o);
    scrollTo(0, 0);
  });

  if (signed) return <Done order={signed} onRestart={() => navigate("/?new=" + Date.now())} />;

  const setC = (k: keyof CarForm) => (v: string) => setCar((s) => ({ ...s, [k]: v }));
  const setU = (k: keyof CustomerForm) => (v: string) => setCustomer((s) => ({ ...s, [k]: v }));
  const allAgreed = agree.contract && agree.pep && agree.personalData;
  const labels = ["Далее", "Далее", "К подписанию", draft ? "Подписать" : "Получить код"];
  const disabled = busy || (step === 2 && !allAgreed) || (step === 3 && !!draft && code.length !== 4);

  return (
    <>
      <ol className="steps" aria-label="Шаги оформления">
        {STEPS.map((n, i) => (
          <li key={n} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
            <i />{n}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <section className="card">
            <h2>Автомобиль</h2>
            {partner && <span className="pill info">Заявка от партнёра: {partner.partner}</span>}
            <Field id="car" label="Марка и модель" value={car.car} onChange={setC("car")} errors={errors} list="cars" autoComplete="off" />
            <datalist id="cars">{CARS.map((c) => <option key={c} value={c} />)}</datalist>
            <Field id="vin" label="VIN или номер кузова" value={car.vin} onChange={(v) => setC("vin")(v.toUpperCase())} errors={errors}
              hint="Для японских авто — номер кузова, например GS4-1009355" className="mono" autoCapitalize="characters" spellCheck={false} />
            <div className="row2">
              <Field id="year" label="Год выпуска" value={car.year} onChange={setC("year")} errors={errors} inputMode="numeric" maxLength={4} />
              <Field id="color" label="Цвет" value={car.color} onChange={setC("color")} errors={errors} />
            </div>
            <div className="field">
              <span className="label" id="body-label">Тип кузова</span>
              <div className="seg" role="group" aria-labelledby="body-label">
                {(Object.keys(BODY) as BodyType[]).map((k) => (
                  <button key={k} type="button" aria-pressed={car.body === k} onClick={() => setCar((s) => ({ ...s, body: k }))}>
                    {BODY[k].name}
                  </button>
                ))}
              </div>
            </div>
            <Field id="value" label="Стоимость автомобиля, ₽" value={car.value} errors={errors} inputMode="numeric"
              onChange={(v) => setC("value")(v.replace(/\D/g, "") ? new Intl.NumberFormat("ru-RU").format(parseRub(v)) : "")}
              hint="На эту сумму оформляется страховка" />
            <div className={"field" + (errors.city ? " bad" : "")}>
              <label htmlFor="f-city">Город доставки</label>
              <select id="f-city" value={car.city} onChange={(e) => setC("city")(e.target.value)}>
                {CITIES.map((c) => <option key={c}>{c}</option>)}
              </select>
              {errors.city && <span className="err">{errors.city}</span>}
            </div>
          </section>
          <QuoteCard city={car.city} body={car.body} q={q} />
        </>
      )}

      {step === 1 && (
        <section className="card">
          <h2>Данные заказчика</h2>
          <p className="muted small">Нужны для договора перевозки. Хранятся на серверах в России.</p>
          <Field id="fio" label="ФИО полностью" value={customer.fio} onChange={setU("fio")} errors={errors} autoComplete="name" />
          <Field id="phone" label="Телефон" value={customer.phone} onChange={setU("phone")} errors={errors} inputMode="tel" autoComplete="tel"
            hint="На этот номер придёт код для подписи" />
          <div className="row2">
            <Field id="passportSeries" label="Паспорт: серия" value={customer.passportSeries} onChange={setU("passportSeries")} errors={errors} inputMode="numeric" maxLength={4} />
            <Field id="passportNumber" label="Номер" value={customer.passportNumber} onChange={setU("passportNumber")} errors={errors} inputMode="numeric" maxLength={6} />
          </div>
          <Field id="passportIssued" label="Кем выдан" value={customer.passportIssued} onChange={setU("passportIssued")} errors={errors} />
          <Field id="passportDate" label="Дата выдачи" value={customer.passportDate} onChange={setU("passportDate")} errors={errors} type="date" />
          <Field id="address" label="Адрес регистрации" value={customer.address} onChange={setU("address")} errors={errors} autoComplete="street-address" />
        </section>
      )}

      {step === 2 && (
        <Documents car={car} customer={customer} q={q} agree={agree} setAgree={setAgree} />
      )}

      {step === 3 && (
        <section className="card">
          <h2>Подписание</h2>
          {!draft ? (
            <p className="muted small">
              Отправим код на {customer.phone}. Этим кодом вы подпишете договор перевозки и согласие на обработку данных.
            </p>
          ) : (
            <>
              <p className="muted small">Код для договора №{draft.no} отправлен на {customer.phone}.</p>
              {draft.devCode && <div className="callout warn">Тестовый режим, SMS не отправляется. Код: <b className="mono">{draft.devCode}</b></div>}
              <div className="field">
                <label htmlFor="code">Код из SMS</label>
                <input id="code" className="codebox" inputMode="numeric" maxLength={4} autoComplete="one-time-code" autoFocus
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              </div>
              <button className="linkbtn" onClick={resend} disabled={busy}>Отправить код ещё раз</button>
            </>
          )}
        </section>
      )}

      {message && <div className="callout warn" role="alert">{message}</div>}

      <div className="dock">
        <div className="dock-in">
          {step > 0 && !(step === 3 && draft) && <button className="btn ghost" onClick={() => go(step - 1)} aria-label="Назад">←</button>}
          <div className="dock-sum">
            <small>Итого к оплате</small>
            <b className="num">{q.needsManager ? "от " : ""}{rub(q.total)}</b>
          </div>
          <button className="btn primary" onClick={next} disabled={disabled}>{busy ? "Подождите…" : labels[step]}</button>
        </div>
      </div>
    </>
  );
}

type FieldProps = {
  id: string; label: string; value: string; onChange: (v: string) => void; errors: Record<string, string>; hint?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "id">;

export function Field({ id, label, value, onChange, errors, hint, ...rest }: FieldProps) {
  const err = errors[id];
  return (
    <div className={"field" + (err ? " bad" : "")}>
      <label htmlFor={`f-${id}`}>{label}</label>
      <input id={`f-${id}`} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!err}
        aria-describedby={err || hint ? `h-${id}` : undefined} {...rest} />
      {err ? <span className="err" id={`h-${id}`}>{err}</span> : hint ? <span className="hint" id={`h-${id}`}>{hint}</span> : null}
    </div>
  );
}

export function QuoteCard({ city, body, q }: { city: string; body: BodyType; q: ReturnType<typeof quote> }) {
  const from = q.needsManager ? "от " : "";
  return (
    <section className="card">
      <div className="eyebrow">Расчёт · Владивосток → {city}</div>
      <div className="quote">
        <div className="qrow"><span>Перевозка автовозом<br /><small className="muted">{BODY[body].name}</small></span><span>{from}{rub(q.delivery)}</span></div>
        <div className="qrow"><span>Страхование на время перевозки<br /><small className="muted">0,3% от стоимости авто</small></span><span>{rub(q.insurance)}</span></div>
        <div className="qrow qtotal"><span>Итого</span><span>{from}{rub(q.total)}</span></div>
      </div>
      {q.needsManager && (
        <div className="callout warn">Минивены, джипы и S-класс считаются по габаритам и весу. Менеджер подтвердит цену до подписания.</div>
      )}
      <p className="muted small">Срок доставки 10–60 дней с момента выхода автовоза из Владивостока. Оплата 100% в течение 3 дней после подписания.</p>
    </section>
  );
}

export function Documents({ car, customer, q, agree, setAgree }: {
  car: CarForm; customer: CustomerForm; q: ReturnType<typeof quote>;
  agree: { contract: boolean; pep: boolean; personalData: boolean };
  setAgree: (a: { contract: boolean; pep: boolean; personalData: boolean }) => void;
}) {
  const check = (k: keyof typeof agree, text: string) => (
    <label className="check">
      <input type="checkbox" checked={agree[k]} onChange={(e) => setAgree({ ...agree, [k]: e.target.checked })} /> {text}
    </label>
  );
  const today = new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  return (
    <>
      <section className="card">
        <h2>Проверьте документы</h2>
        <div className="eyebrow">1 · Договор перевозки</div>
        <div className="doc" tabIndex={0} aria-label="Текст договора">
          <p className="t">Договор перевозки груза автомобильным транспортом</p>
          <p className="row-between"><span>г. Владивосток</span><span>{today}</span></p>
          <p>{CARRIER.name} (ИНН {CARRIER.inn}), именуемый далее «Перевозчик», и гражданин <b>{customer.fio}</b>, именуемый далее «Заказчик», заключили настоящий Договор о нижеследующем.</p>
          <p className="fold">Разделы 1–5 (предмет договора, порядок перевозки и расчётов, условия перевозки, ответственность сторон) — по утверждённому шаблону договора.</p>
          <p className="new"><b>6.8.</b> Стороны признают простой электронной подписью Заказчика код подтверждения, направленный в SMS на номер {customer.phone}. Документ, подписанный таким кодом, равнозначен документу на бумаге с собственноручной подписью (ст. 6, 9 Федерального закона № 63-ФЗ).</p>
          <p className="t">Приложение №1 · Информация о грузе и условиях доставки</p>
          <table>
            <tbody>
              <tr><td>Марка, модель</td><td>{car.car} ({car.year}, {car.color})</td></tr>
              <tr><td>VIN (№ рамы, кузова)</td><td className="mono">{car.vin.toUpperCase()}</td></tr>
              <tr><td>Пункт отправления</td><td>{ORIGIN}</td></tr>
              <tr><td>Пункт назначения</td><td>{car.city} — адрес терминала выдачи</td></tr>
              <tr><td>Сроки доставки</td><td>10–60 дней с момента выхода автомобиля на маршрут из Владивостока</td></tr>
              <tr><td>Стоимость перевозки</td><td>{rubWords(q.delivery)}</td></tr>
              <tr><td>Страхование груза</td><td>{rubWords(q.insurance)}</td></tr>
              <tr><td><b>Итого</b></td><td><b>{rubWords(q.total)}</b></td></tr>
            </tbody>
          </table>
          <p className="fold">Заказчик: паспорт {customer.passportSeries} {customer.passportNumber}, выдан {customer.passportIssued}; адрес: {customer.address}.</p>
        </div>
        {check("contract", "Я прочитал договор перевозки и согласен с его условиями")}
        {check("pep", "Согласен подписывать документы кодом из SMS (простая электронная подпись)")}
      </section>
      <section className="card">
        <div className="eyebrow">2 · Отдельный документ</div>
        <div className="doc short" tabIndex={0} aria-label="Согласие на обработку персональных данных">
          <p className="t">Согласие на обработку персональных данных</p>
          <p>Я, <b>{customer.fio}</b>, действуя свободно, своей волей и в своём интересе, в соответствии с Федеральным законом № 152-ФЗ даю согласие {CARRIER.name} (ИНН {CARRIER.inn}) на обработку моих персональных данных: ФИО, паспортные данные, телефон, адрес, сведения о транспортном средстве.</p>
          <p>Цели: заключение и исполнение договора перевозки, организация транспортировки, связь со мной, оформление документов. Передача водителям, логистическим и страховым компаниям — только для исполнения договора.</p>
        </div>
        {check("personalData", "Даю согласие на обработку персональных данных")}
      </section>
    </>
  );
}

export function Done({ order, onRestart }: { order: Order; onRestart: () => void }) {
  const link = `${SITE_ORIGIN}/t/${order.trackToken}`;
  const [copied, setCopied] = useState(false);
  const at = order.signature ? new Date(order.signature.at).toLocaleString("ru-RU") : "";
  return (
    <>
      <section className="card">
        <span className="pill ok">Подписано</span>
        <h2>Договор №{order.no} подписан</h2>
        <p>Оплатите {rub(order.quote.total)} в течение 3 дней. Менеджер свяжется с вами и пришлёт реквизиты.</p>
        {order.signature && (
          <div className="stamp">
            <b>Подписано простой электронной подписью</b><br />
            Заказчик: {order.customer.fio}<br />
            Телефон: {order.customer.phone} · код подтверждён<br />
            Дата: {at}<br />
            SHA-256 документа: {order.signature.documentSha256}
          </div>
        )}
      </section>
      <section className="card">
        <h3>Где сейчас ваш автомобиль</h3>
        <div className="copyline">
          <code>{link}</code>
          <button className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true), () => {})}>
            {copied ? "Скопировано" : "Копировать"}
          </button>
        </div>
        <button className="btn primary" onClick={() => navigate(`/t/${order.trackToken}`)}>Открыть трекинг</button>
        <button className="btn ghost" onClick={onRestart}>Оформить ещё один автомобиль</button>
      </section>
      <section className="card game">
        <div className="eyebrow">Пока автовоз в пути</div>
        <h3>Игра Brookclean</h3>
        <p className="small">Скоротайте ожидание — сыграйте в нашу игру.</p>
        <a className="btn dark" href={GAME_URL} target="_blank" rel="noopener">Играть · brookcleangame.online</a>
      </section>
    </>
  );
}
