import { useEffect, useState } from "react";
import { CARRIER, EMPTY_COMPANY, validateCompany, type CompanyForm, type PartnerRequestView } from "@brookclean/shared";
import { api, ApiError } from "./api.ts";
import { Field } from "./Checkout.tsx";

/** Карточка партнёра: реквизиты компании. После проверки менеджером можно оформлять больше одного автомобиля в сутки. */
export function PartnerCard({ ordersPerDay, onBack }: { ordersPerDay: number; onBack: () => void }) {
  const [req, setReq] = useState<PartnerRequestView | null | undefined>(undefined);
  const [f, setF] = useState<CompanyForm>(EMPTY_COMPANY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.partnerRequest().then((r) => {
      setReq(r);
      if (r) setF(r.company);
    }, () => setReq(null));
  }, []);

  async function submit() {
    const e = validateCompany(f) as Record<string, string>;
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setMessage("");
    try {
      setReq(await api.applyPartner(f));
    } catch (err) {
      const x = err as ApiError;
      setMessage(x.message);
      if (x.errors) setErrors(x.errors);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof CompanyForm) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const field = (k: keyof CompanyForm, label: string, extra: Record<string, unknown> = {}) =>
    <Field id={k} label={label} value={f[k]} onChange={set(k)} errors={errors} {...extra} />;

  if (req === undefined) return <section className="card"><p className="muted">Загрузка…</p></section>;

  if (req?.status === "pending") return (
    <section className="card">
      <span className="pill info">На проверке</span>
      <h2>Карточка партнёра отправлена</h2>
      <p>Менеджер проверит реквизиты {req.company.name} и пришлёт SMS. После этого вы сможете оформлять несколько автомобилей в день.</p>
      <p className="muted small">Срочно? Позвоните: {CARRIER.phone}</p>
      <button className="btn ghost" onClick={onBack}>Назад</button>
    </section>
  );

  return (
    <>
      <section className="card">
        <h2>Карточка партнёра</h2>
        <p className="muted small">
          Обычный клиент может оформить {ordersPerDay === 1 ? "один автомобиль" : `${ordersPerDay} автомобиля`} в сутки.
          Чтобы оформлять больше, укажите реквизиты компании. Менеджер проверит их и подключит вас как партнёра.
        </p>
        {req?.status === "rejected" && <div className="callout warn">Прошлая заявка отклонена. Проверьте реквизиты или позвоните: {CARRIER.phone}</div>}
        {field("name", "Название компании или ИП")}
        <div className="row2">
          {field("inn", "ИНН", { inputMode: "numeric", maxLength: 12 })}
          {field("kpp", "КПП", { inputMode: "numeric", maxLength: 9, hint: "Для ИП не нужен" })}
        </div>
        {field("ogrn", "ОГРН / ОГРНИП", { inputMode: "numeric", maxLength: 15 })}
        {field("address", "Юридический адрес")}
      </section>
      <section className="card">
        <h3>Банковские реквизиты</h3>
        {field("bank", "Банк")}
        {field("bik", "БИК", { inputMode: "numeric", maxLength: 9 })}
        {field("account", "Расчётный счёт", { inputMode: "numeric", maxLength: 20, className: "mono" })}
        {field("corrAccount", "Корреспондентский счёт", { inputMode: "numeric", maxLength: 20, className: "mono" })}
      </section>
      <section className="card">
        <h3>Контакт</h3>
        {field("contact", "Контактное лицо", { autoComplete: "name" })}
        {field("email", "Email (необязательно)", { inputMode: "email", autoComplete: "email" })}
        {message && <div className="callout warn" role="alert">{message}</div>}
        <button className="btn primary" disabled={busy} onClick={submit}>{busy ? "Отправляем…" : "Отправить на проверку"}</button>
        <button className="btn ghost" onClick={onBack}>Назад</button>
      </section>
    </>
  );
}
