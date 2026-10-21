import { useEffect, useState } from "react";
import { parseRub, rub } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { SITE_ORIGIN } from "../router.ts";
import { staffApi, type PartnerLink } from "./api.ts";

export function PartnersScreen() {
  const [links, setLinks] = useState<PartnerLink[] | null>(null);
  const [partner, setPartner] = useState("");
  const [cashback, setCashback] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    staffApi.partnerLinks().then(setLinks, (e: ApiError) => setError(e.message));
  }, []);

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
              <tr key={l.token}><td>{l.partner}</td><td className="r">{rub(l.cashback)}</td><td className="mono">{SITE_ORIGIN}/?p={l.token}</td><td>{new Date(l.createdAt).toLocaleDateString("ru-RU")}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
