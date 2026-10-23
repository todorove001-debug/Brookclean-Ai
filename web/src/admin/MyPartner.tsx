import { useEffect, useState } from "react";
import { BODY, CITIES, parseRub, rub, type BodyType, type PartnerCabinet, type PartnerPreview } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { CLIENT_ORIGIN, staffApi } from "./api.ts";
import { STATUS_RU } from "./Deliveries.tsx";

const linkUrl = (token: string) => `${CLIENT_ORIGIN}/?p=${token}`;

/** Кабинет партнёра: договорился с клиентом о кэшбэке, сделал ссылку, видит своих клиентов и кэшбэк. */
export function MyPartnerScreen() {
  const [cab, setCab] = useState<PartnerCabinet | null>(null);
  const [city, setCity] = useState("Краснодар");
  const [body, setBody] = useState<BodyType>("sedan");
  const [cashback, setCashback] = useState("15000");
  const [note, setNote] = useState("");
  const [pre, setPre] = useState<PartnerPreview | null>(null);
  const [made, setMade] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const load = () => staffApi.myPartner().then(setCab, (e: ApiError) => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    staffApi.partnerPreview(city, body, parseRub(cashback)).then(setPre, () => setPre(null));
  }, [city, body, cashback]);

  async function create() {
    setError("");
    try {
      const r = await staffApi.createMyLink(parseRub(cashback), note);
      setMade(linkUrl(r.token));
      setCopied(false);
      load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(made);
      setCopied(true);
    } catch {
      /* без доступа к буферу ссылку можно выделить вручную */
    }
  }

  if (!cab) return error ? <div className="callout warn" role="alert">{error}</div> : <p className="muted">Загрузка…</p>;
  return (
    <div className="stack">
      <section className="card">
        <h2>{cab.name}</h2>
        <p className="small muted">Договоритесь с клиентом о кэшбэке по телефону и отправьте ему ссылку. Цена в ссылке уже включает ваш кэшбэк.</p>
      </section>

      <section className="card stack">
        <h3>Ссылка для клиента</h3>
        <div className="field"><label htmlFor="pp-note">Клиент (для себя)</label>
          <input id="pp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например, Тагаева Л. Г." maxLength={80} /></div>
        <div className="row2">
          <div className="field"><label htmlFor="pp-city">Город</label>
            <select id="pp-city" value={city} onChange={(e) => setCity(e.target.value)}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label htmlFor="pp-body">Кузов</label>
            <select id="pp-body" value={body} onChange={(e) => setBody(e.target.value as BodyType)}>
              {(Object.keys(BODY) as BodyType[]).map((b) => <option key={b} value={b}>{BODY[b].name}</option>)}
            </select></div>
        </div>
        <div className="field"><label htmlFor="pp-cb">Ваш кэшбэк, ₽</label>
          <input id="pp-cb" value={cashback} onChange={(e) => setCashback(e.target.value)} inputMode="numeric" />
          <span className="hint">Сумма, о которой вы договорились с клиентом по телефону</span></div>
        {pre && (
          <div className="quote">
            <div className="qrow"><span className="muted">Тариф перевозчика</span><span>{rub(pre.tariff)}</span></div>
            <div className="qrow"><span className="muted">+ ваш кэшбэк</span><span>{rub(pre.cashback)}</span></div>
            <div className="qrow qtotal"><span>Клиент увидит и в договоре</span><span>{rub(pre.total)}</span></div>
          </div>
        )}
        <div className="callout info">В договоре будет только итоговая стоимость перевозки. Кэшбэк отдельно не указывается. Город и кузов здесь только для расчёта: клиент выберет свои.</div>
        <button className="btn primary" onClick={create}>Создать ссылку</button>
        {error && <div className="callout warn" role="alert">{error}</div>}
        {made && (
          <div className="copyline"><code>{made}</code>
            <button className="btn sm ghost" onClick={copy}>{copied ? "Скопировано" : "Копировать"}</button></div>
        )}
      </section>

      <section className="card stack">
        <h3>Мои клиенты</h3>
        {cab.clients.length === 0 ? <p className="muted small">Пока нет заказов по вашим ссылкам.</p> : (
          <ul className="plist">
            {cab.clients.map((c) => {
              const [st, cls] = STATUS_RU[c.status] ?? [c.status, "gray"];
              return (
                <li key={c.no} className="pi">
                  <span>№{c.no} · {c.car} → {c.city}<br /><small className="muted">{c.client}</small> <span className={`pill ${cls}`}>{st}</span></span>
                  <b>{rub(c.cashback)}</b>
                </li>
              );
            })}
            <li className="pi total"><span>Кэшбэк всего</span><b>{rub(cab.total)}</b></li>
          </ul>
        )}
      </section>

      {cab.links.length > 0 && (
        <section className="card stack">
          <h3>Мои ссылки</h3>
          <div className="tablewrap">
            <table className="sheet narrow">
              <thead><tr><th>Клиент</th><th className="r">Кэшбэк</th><th>Ссылка</th><th>Создана</th></tr></thead>
              <tbody>
                {cab.links.map((l) => (
                  <tr key={l.token}><td>{l.note ?? "—"}</td><td className="r">{rub(l.cashback)}</td><td className="mono">{linkUrl(l.token)}</td>
                    <td>{new Date(l.createdAt).toLocaleDateString("ru-RU")}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
