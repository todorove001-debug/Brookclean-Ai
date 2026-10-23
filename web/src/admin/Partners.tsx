import { useEffect, useState } from "react";
import { parseRub, rub, type PartnerRequestView } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { CLIENT_ORIGIN, staffApi, type PartnerLink } from "./api.ts";

export function PartnersScreen() {
  const [links, setLinks] = useState<PartnerLink[] | null>(null);
  const [partner, setPartner] = useState("");
  const [cashback, setCashback] = useState("");
  const [error, setError] = useState("");
  const [requests, setRequests] = useState<PartnerRequestView[]>([]);
  useEffect(() => {
    staffApi.partnerLinks().then(setLinks, (e: ApiError) => setError(e.message));
    staffApi.partnerRequests().then(setRequests, () => {});
  }, []);

  async function review(id: number, status: "approved" | "rejected") {
    try {
      const r = await staffApi.reviewPartner(id, status);
      setRequests((rs) => rs.map((x) => (x.id === id ? r : x)));
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  async function create() {
    setError("");
    try {
      const r = await staffApi.createPartnerLink(partner, parseRub(cashback));
      setLinks((ls) => [{ token: r.token, partner, cashback: parseRub(cashback), createdAt: new Date().toISOString() }, ...(ls ?? [])]);
      setPartner("");
      setCashback("");
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <h3>Карточки партнёров</h3>
        <p className="small muted">
          Обычный клиент может оформить один автомобиль в сутки. Кто хочет больше, присылает реквизиты компании.
          После одобрения ограничение снимается, клиенту уходит SMS.
        </p>
        {requests.length === 0 ? <p className="muted small">Заявок пока нет.</p> : (
          <div className="tablewrap">
            <table className="sheet narrow">
              <thead><tr><th>Компания</th><th>ИНН, КПП, ОГРН</th><th>Банк</th><th>Контакт</th><th>Статус</th></tr></thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>{r.company.name}<br /><small className="muted">{r.company.address}</small></td>
                    <td className="mono small">ИНН {r.company.inn}{r.company.kpp && <><br />КПП {r.company.kpp}</>}<br />ОГРН {r.company.ogrn}</td>
                    <td className="small">{r.company.bank}<br /><span className="mono muted">БИК {r.company.bik}<br />р/с {r.company.account}<br />к/с {r.company.corrAccount}</span></td>
                    <td>{r.company.contact}<br /><small className="muted">{r.phone}{r.company.email ? ` · ${r.company.email}` : ""}</small></td>
                    <td><div className="stack">
                      {r.status === "approved" ? <span className="pill ok">партнёр</span> : r.status === "rejected" ? <span className="pill gray">отклонена</span> : <span className="pill warn">ждёт проверки</span>}
                      {r.status !== "approved" && <button className="btn sm primary" onClick={() => review(r.id, "approved")}>Одобрить</button>}
                      {r.status === "pending" && <button className="btn sm ghost" onClick={() => review(r.id, "rejected")}>Отклонить</button>}
                      {r.status === "approved" && <button className="btn sm ghost" onClick={() => review(r.id, "rejected")}>Отключить</button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h3>Ссылка для партнёра</h3>
        <p className="small muted">Кэшбэк прибавляется к перевозке у клиентов, пришедших по ссылке. В договоре его отдельно не видно, в ссылке тоже.</p>
        <div className="inline">
          <input value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="Партнёр, например Роман · Монстеркар" aria-label="Партнёр" />
          <input value={cashback} onChange={(e) => setCashback(e.target.value)} placeholder="Кэшбэк, ₽" inputMode="numeric" aria-label="Кэшбэк" />
          <button className="btn sm primary" disabled={!partner} onClick={create}>Создать</button>
        </div>
        {error && <div className="callout warn" role="alert">{error}</div>}
      </section>
      <div className="tablewrap">
        <table className="sheet narrow">
          <thead><tr><th>Партнёр</th><th className="r">Кэшбэк</th><th>Ссылка</th><th>Создана</th></tr></thead>
          <tbody>
            {(links ?? []).map((l) => (
              <tr key={l.token}><td>{l.partner}</td><td className="r">{rub(l.cashback)}</td><td className="mono">{CLIENT_ORIGIN}/?p={l.token}</td><td>{new Date(l.createdAt).toLocaleDateString("ru-RU")}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
