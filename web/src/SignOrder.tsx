import { useEffect, useState } from "react";
import type { CustomerForm } from "@brookclean/shared";
import { api, ApiError, type Order } from "./api.ts";
import { Documents, Done } from "./Checkout.tsx";
import { rememberOrder } from "./storage.ts";
import { navigate } from "./router.ts";

/** Заявку оформил менеджер: клиент открывает ссылку из SMS, читает договор и подписывает кодом. */
export function SignOrder({ id }: { id: string }) {
  const [order, setOrder] = useState<(Order & { documentCustomer?: CustomerForm }) | null>(null);
  const [signed, setSigned] = useState<Order | null>(null);
  const [agree, setAgree] = useState({ contract: false, pep: false, personalData: false });
  const [codeSent, setCodeSent] = useState<{ devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api.order(id).then((o) => (o.status === "draft" ? setOrder(o) : setSigned(o)), (e: ApiError) => setMessage(e.message));
  }, [id]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (signed) return <Done order={signed} onRestart={() => navigate("/")} />;
  if (!order) return <div className="card">{message || <span className="muted">Загружаем договор…</span>}</div>;

  const all = agree.contract && agree.pep && agree.personalData;
  return (
    <>
      <section className="card">
        <div className="eyebrow">Договор №{order.no}</div>
        <h2>Проверьте и подпишите</h2>
        <p className="small muted">Менеджер Brookclean Trucks подготовил договор по вашей заявке. Если что-то неверно, позвоните нам до подписания.</p>
      </section>
      <Documents car={order.car} customer={order.documentCustomer!} q={order.quote} agree={agree} setAgree={setAgree} />
      <section className="card">
        <h2>Подписание</h2>
        {!codeSent ? (
          <>
            <p className="small muted">Отправим код на {order.customer.phone}.</p>
            <button className="btn primary" disabled={!all || busy}
              onClick={() => run(async () => setCodeSent(await api.resend(order.id)))}>Получить код</button>
          </>
        ) : (
          <>
            {codeSent.devCode && <div className="callout warn">Тестовый режим, SMS не отправляется. Код: <b className="mono">{codeSent.devCode}</b></div>}
            <div className="field">
              <label htmlFor="code">Код из SMS</label>
              <input id="code" className="codebox" inputMode="numeric" maxLength={4} autoComplete="one-time-code" autoFocus
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </div>
            <button className="btn primary" disabled={code.length !== 4 || busy || !all} onClick={() => run(async () => {
              const o = await api.signWithConsents(order.id, code, agree);
              rememberOrder({ id: o.id, no: o.no, car: o.car.car, city: o.car.city, trackToken: o.trackToken! });
              setSigned(o);
              scrollTo(0, 0);
            })}>Подписать</button>
            <button className="linkbtn" disabled={busy} onClick={() => run(async () => setCodeSent(await api.resend(order.id)))}>Отправить код ещё раз</button>
          </>
        )}
        {message && <div className="callout warn" role="alert">{message}</div>}
      </section>
    </>
  );
}
