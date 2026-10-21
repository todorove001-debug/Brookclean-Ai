import { useEffect, useState } from "react";
import { CARRIER, KM_PER_DAY, NET, routeFor, type TrackingView } from "@brookclean/shared";
import { api, ApiError } from "./api.ts";
import { Review } from "./Review.tsx";

const STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: "Не подписан", cls: "gray" },
  signed: { text: "Подписан", cls: "warn" },
  paid: { text: "Оплачен", cls: "ok" },
  loading: { text: "Ожидает погрузки", cls: "gray" },
  in_transit: { text: "В пути", cls: "info" },
  arrived: { text: "Прибыл", cls: "ok" },
  delivered: { text: "Выдан", cls: "ok" },
};

export function Track({ token }: { token: string }) {
  const [t, setT] = useState<TrackingView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const loadOnce = () =>
      api.track(token).then((v) => alive && (setT(v), setError("")), (e: ApiError) => alive && setError(e.message));
    loadOnce();
    // Позиция меняется не чаще раза в 30–60 минут — обновляем раз в 5 минут и при возврате в приложение
    const id = setInterval(loadOnce, 5 * 60_000);
    const onVis = () => document.visibilityState === "visible" && loadOnce();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [token]);

  if (error && !t) return <div className="card"><h2>Трекинг</h2><p>{error}</p></div>;
  if (!t) return <div className="card muted">Загружаем…</div>;

  const stops = routeFor(t.city);
  const pct = t.destKm ? Math.round((t.km / t.destKm) * 100) : 0;
  const left = Math.max(0, t.destKm - t.km);
  const moving = t.km > 0 && t.km < t.destKm;
  const lastIdx = stops.reduce((acc, c, i) => (NET[c][1] <= t.km ? i : acc), -1);
  const last = t.events.at(-1);
  const st = STATUS[t.status] ?? STATUS.signed;
  const big = t.km >= t.destKm && t.destKm ? `Прибыл в ${t.city}` : moving ? "В пути" : t.loadDate ? `Погрузка ${t.loadDate}` : "Ожидает погрузки";

  return (
    <>
      <section className="card">
        <div className="eyebrow">Договор №{t.orderNo} · {t.car}</div>
        <div className="bigstatus">{big}</div>
        <span className={`pill ${st.cls}`}>{st.text}</span>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Пройдено">
          <i style={{ width: pct + "%" }} />
        </div>
        <dl className="kv">
          <dt>Маршрут</dt><dd>Владивосток → {t.city}</dd>
          <dt>VIN</dt><dd className="mono">{t.vinMasked}</dd>
          <dt>Осталось</dt><dd>{left.toLocaleString("ru-RU")} км{moving ? ` · ≈ ${Math.ceil(left / KM_PER_DAY)} дн.` : ""}</dd>
          {t.truck && (<><dt>Автовоз</dt><dd>{t.truck}</dd></>)}
          <dt>Обновлено</dt><dd>{last ? `${new Date(last.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}, ${last.city}` : "—"}</dd>
        </dl>
        {error && <p className="muted small">Нет связи: показано последнее известное положение.</p>}
      </section>

      <section className="card">
        <h3>Маршрут</h3>
        <ol className="route">
          {stops.map((c, i) => {
            const passed = t.km > 0 && i <= lastIdx;
            return (
              <li key={c} className={`stop${passed ? " passed" : ""}${i === stops.length - 1 ? " dest" : ""}`}>
                <span className="dot" />
                <span className="name">{c}</span>
                <span className="km">{NET[c][1].toLocaleString("ru-RU")} км</span>
                {moving && i === lastIdx && (
                  <span className="truck-here">Автовоз {NET[c][1] === t.km ? `в пункте ${c}` : `между ${c} и ${stops[i + 1]}`}</span>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {t.status === "arrived" && (
        <section className="card attention">
          <h3>Автомобиль прибыл в {t.city}</h3>
          <p className="small">Когда заберёте машину с терминала и проверите её, отметьте получение.</p>
          <button className="btn primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await api.received(token);
              setT({ ...t, status: "delivered" });
            } catch (e) {
              setError((e as ApiError).message);
            } finally {
              setBusy(false);
            }
          }}>Автомобиль получил</button>
        </section>
      )}

      {t.status === "delivered" && <Review token={token} initial={t.review} />}

      {t.events.length > 0 && (
        <section className="card">
          <h3>История</h3>
          <ul className="events">
            {t.events.slice().reverse().map((e) => (
              <li key={e.at}>
                <time>{new Date(e.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>
                <span><b>{e.city}</b> · {e.note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>Вопросы по доставке</h3>
        <p>Перевозчик: <a href={`tel:${CARRIER.phone.replace(/\s/g, "")}`}>{CARRIER.phone}</a> (звонок, WhatsApp, Telegram)</p>
      </section>
    </>
  );
}
