import { useEffect, useState } from "react";
import { EXPENSE_KINDS, NET, can, routeFor, rub, type ExpenseKind, type StaffMe, type TripReport, type WaitingCar } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { DEMO, navigate } from "../router.ts";
import { staffApi } from "./api.ts";
import { TRIP_STATUS, fmt } from "./Trips.tsx";

const km = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("ru-RU")} км`);
const digits = (v: string) => (v.trim() ? Number(v.replace(/[^\d]/g, "")) : null);

/** Рейсовый отчёт в панели: машины, путь, расходы, одометр, закрытие рейса. */
export function TripReportScreen({ me, id }: { me: StaffMe; id: string }) {
  const [r, setR] = useState<TripReport | null>(null);
  const [waiting, setWaiting] = useState<WaitingCar[]>([]);
  const [error, setError] = useState("");
  const manager = can(me.role, "trips.edit");

  const load = async () => {
    const rep = await staffApi.report(id);
    setR(rep);
    setWaiting(rep.trip.editable ? await staffApi.waiting(id).catch(() => []) : []);
  };
  useEffect(() => {
    load().catch((e: ApiError) => setError(e.message));
  }, [id]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      const res = await fn();
      if (res && typeof res === "object" && "cars" in res) setR(res as TripReport);
      else await load();
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    }
  };

  const back = <a className="small" href="/admin/trips" onClick={(e) => { e.preventDefault(); navigate("/admin/trips"); }}>← Все рейсы</a>;
  if (!r) return <div className="stack">{back}<p className="muted">{error || "Загружаем отчёт…"}</p></div>;

  const t = r.trip;
  const edit = t.editable;
  const [st, cls] = TRIP_STATUS[t.status];
  return (
    <div className="stack report">
      {back}
      <section className="card">
        <div className="row-between">
          <h2>Рейс {t.id} · Владивосток → {t.dest}</h2>
          {t.closedAt ? <span className="pill gray">Закрыт {fmt(t.closedAt)}</span> : <span className={`pill ${cls}`}>{st}</span>}
        </div>
        <p className="small muted">{t.truck}{t.driver ? ` · водитель ${t.driver}` : " · водитель не назначен"}
          {t.loadDate ? ` · погрузка ${new Date(t.loadDate).toLocaleDateString("ru-RU")}` : ""}</p>
        <div className="kpis">
          <div className="kpi"><b>{r.totals.cars}</b><span>машин в рейсе</span></div>
          <div className="kpi"><b>{km(r.totals.mileage)}</b><span>пробег по одометру</span></div>
          <div className="kpi"><b>{rub(r.totals.expenses)}</b><span>расходы рейса</span></div>
          <div className="kpi"><b>{r.totals.fuelLiters.toLocaleString("ru-RU")} л</b><span>топливо</span></div>
          {r.finance && <>
            <div className="kpi"><b>{rub(r.totals.delivery!)}</b><span>перевозка по договорам</span></div>
            <div className="kpi"><b>{rub(r.totals.unpaid!)}</b><span>не оплачено</span></div>
          </>}
        </div>
      </section>
      {error && <div className="callout warn" role="alert">{error}</div>}

      <Cars r={r} waiting={waiting} edit={edit} act={act} />
      <Route r={r} edit={edit} act={act} />
      <Expenses r={r} edit={edit} act={act} />
      <Odometer r={r} edit={edit} manager={manager} act={act} />

      <section className="card">
        <h3>Выгрузка</h3>
        <div className="inline">
          {!DEMO && <a className="btn sm ghost" href={`/api/staff/trips/${encodeURIComponent(t.id)}/report.csv`}>Скачать CSV</a>}
          {t.driveUrl && <a className="btn sm ghost" href={t.driveUrl} target="_blank" rel="noopener">Google Таблица</a>}
        </div>
        <p className="small muted">
          {DEMO ? "На сервере отчёт скачивается в CSV и сам обновляется в Google Таблице после каждой записи."
            : t.driveUrl ? `Google Таблица обновляется сама${t.driveSyncedAt ? `, последний раз ${fmt(t.driveSyncedAt)}` : ""}.`
            : "Google Таблица появится, когда владелец подключит Google Диск."}
          {!r.finance && " Суммы договоров в отчёте водителя не показываются."}
        </p>
      </section>
    </div>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<boolean>;

function Cars({ r, waiting, edit, act }: { r: TripReport; waiting: WaitingCar[]; edit: boolean; act: Act }) {
  const t = r.trip;
  return (
    <section className="card">
      <h3>Машины</h3>
      {r.cars.length === 0 ? <p className="small muted">В рейсе пока нет машин.</p> : (
        <div className="tablewrap">
          <table className="sheet narrow">
            <thead>
              <tr>
                <th>№</th><th>Автомобиль</th><th>VIN / кузов</th><th>Город</th><th className="r">Км</th><th>Получатель</th><th>Статус</th>
                {r.finance && <><th className="r bl">Перевозка</th><th className="r">Страховка</th><th>Оплата</th></>}
                {edit && <th />}
              </tr>
            </thead>
            <tbody>
              {r.cars.map((c) => (
                <tr key={c.no}>
                  <td className="mono">{c.no}</td><td>{c.car} {c.year}, {c.color}</td><td className="mono">{c.vin}</td><td>{c.city}</td>
                  <td className="r">{c.km.toLocaleString("ru-RU")}</td><td>{c.client}</td><td>{c.status}</td>
                  {r.finance && <>
                    <td className="r bl">{rub(c.delivery!)}</td><td className="r">{rub(c.insurance!)}</td>
                    <td>{c.paidDelivery && c.paidInsurance ? "оплачено" : c.paidDelivery || c.paidInsurance ? "частично" : "нет"}</td>
                  </>}
                  {edit && <td><button className="btn sm ghost" onClick={() => act(() => staffApi.loadCar(t.id, c.no, false))}>Снять</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <>
          <h4>Ждут погрузки по маршруту</h4>
          {waiting.length === 0 ? <p className="small muted">Подписанных машин по этому маршруту нет.</p> : (
            <ul className="plist waiting">
              {waiting.map((w) => (
                <li key={w.no} className="row-between">
                  <span><b className="mono">№{w.no}</b> {w.car} · <span className="mono">{w.vin}</span> → {w.city}</span>
                  <button className="btn sm dark" onClick={() => act(() => staffApi.loadCar(t.id, w.no, true))}>Погрузить</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Route({ r, edit, act }: { r: TripReport; edit: boolean; act: Act }) {
  const t = r.trip;
  const route = routeFor(t.dest);
  const [city, setCity] = useState(() => route.find((c) => NET[c][1] > t.km) ?? t.dest);
  const [note, setNote] = useState("");
  return (
    <section className="card">
      <h3>Путь</h3>
      {edit && (
        <div className="inline">
          <select value={city} onChange={(e) => setCity(e.target.value)} aria-label="Где сейчас автовоз">
            {route.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Комментарий" aria-label="Комментарий к отметке" />
          <button className="btn sm dark" onClick={() => act(() => staffApi.position(t.id, city, note)).then((ok) => ok && setNote(""))}>Отметить</button>
        </div>
      )}
      {t.events.length === 0 ? <p className="small muted">Ещё не выехал. Отметка видна клиентам рейса в трекинге.</p> : (
        <ol className="history">
          {[...t.events].reverse().map((e, i) => <li key={i}><b>{e.city}</b> <span className="muted">{fmt(e.at)}</span>{e.note && ` · ${e.note}`}</li>)}
        </ol>
      )}
    </section>
  );
}

function Expenses({ r, edit, act }: { r: TripReport; edit: boolean; act: Act }) {
  const t = r.trip;
  const [f, setF] = useState({ kind: "fuel" as ExpenseKind, amount: "", liters: "", note: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function add() {
    const ok = await act(() => staffApi.addExpense(t.id, {
      kind: f.kind, amount: digits(f.amount) ?? 0, liters: f.kind === "fuel" && f.liters ? Number(f.liters.replace(",", ".")) : null, note: f.note,
    }));
    if (ok) setF((s) => ({ ...s, amount: "", liters: "", note: "" }));
  }
  const kinds = Object.entries(r.totals.byKind) as Array<[ExpenseKind, number]>;
  return (
    <section className="card">
      <h3>Расходы</h3>
      {edit && (
        <div className="grid4 expense-form">
          <div className="field"><label htmlFor="ex-kind">Вид</label>
            <select id="ex-kind" value={f.kind} onChange={set("kind")}>
              {Object.entries(EXPENSE_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div className="field"><label htmlFor="ex-amount">Сумма, ₽</label><input id="ex-amount" inputMode="numeric" value={f.amount} onChange={set("amount")} placeholder="18 500" /></div>
          {f.kind === "fuel" && <div className="field"><label htmlFor="ex-liters">Литры</label><input id="ex-liters" inputMode="decimal" value={f.liters} onChange={set("liters")} placeholder="250" /></div>}
          <div className="field"><label htmlFor="ex-note">Где, комментарий</label><input id="ex-note" value={f.note} onChange={set("note")} placeholder="АЗС Роснефть, Хабаровск" /></div>
          <button className="btn sm primary self-end" disabled={!digits(f.amount)} onClick={add}>Добавить расход</button>
        </div>
      )}
      {r.expenses.length === 0 ? <p className="small muted">Расходов пока нет.</p> : (
        <>
          <div className="tablewrap">
            <table className="sheet narrow">
              <thead><tr><th>Когда</th><th>Вид</th><th className="r">Сумма</th><th className="r">Литры</th><th>Комментарий</th><th>Внёс</th>{edit && <th />}</tr></thead>
              <tbody>
                {r.expenses.map((e) => (
                  <tr key={e.id}>
                    <td>{fmt(e.at)}</td><td>{EXPENSE_KINDS[e.kind]}</td><td className="r">{rub(e.amount)}</td>
                    <td className="r">{e.liters ?? "—"}</td><td>{e.note}</td><td>{e.by}</td>
                    {edit && <td><button className="btn sm ghost" aria-label={`Удалить расход ${rub(e.amount)}`} onClick={() => act(() => staffApi.deleteExpense(t.id, e.id))}>Удалить</button></td>}
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={2}>Итого</td><td className="r">{rub(r.totals.expenses)}</td><td className="r">{r.totals.fuelLiters || "—"}</td><td colSpan={edit ? 3 : 2} /></tr></tfoot>
            </table>
          </div>
          <p className="small muted">{kinds.map(([k, v]) => `${EXPENSE_KINDS[k]}: ${rub(v)}`).join(" · ")}</p>
        </>
      )}
    </section>
  );
}

function Odometer({ r, edit, manager, act }: { r: TripReport; edit: boolean; manager: boolean; act: Act }) {
  const t = r.trip;
  const [start, setStart] = useState(t.odometerStart?.toString() ?? "");
  const [end, setEnd] = useState(t.odometerEnd?.toString() ?? "");
  const changed = digits(start) !== t.odometerStart || digits(end) !== t.odometerEnd;
  return (
    <section className="card">
      <h3>Одометр и закрытие рейса</h3>
      <div className="grid4">
        <div className="field"><label htmlFor="odo-start">При выезде, км</label>
          <input id="odo-start" inputMode="numeric" disabled={!edit} value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="field"><label htmlFor="odo-end">По возвращении, км</label>
          <input id="odo-end" inputMode="numeric" disabled={!edit} value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>
      <div className="inline">
        {edit && <button className="btn sm ghost" disabled={!changed} onClick={() => act(() => staffApi.patchTrip(t.id, { odometerStart: digits(start), odometerEnd: digits(end) }))}>Сохранить одометр</button>}
        {edit && !t.closedAt && (
          <button className="btn sm dark" disabled={!digits(end)} onClick={() => {
            if (confirm("Закрыть рейс? После закрытия водитель не сможет его менять.")) act(() => staffApi.patchTrip(t.id, { odometerStart: digits(start), odometerEnd: digits(end), closed: true }));
          }}>Закрыть рейс</button>
        )}
        {t.closedAt && manager && <button className="btn sm ghost" onClick={() => act(() => staffApi.patchTrip(t.id, { closed: false }))}>Открыть рейс снова</button>}
      </div>
      <p className="small muted">{t.closedAt
        ? `Рейс закрыт ${fmt(t.closedAt)}.${manager ? "" : " Исправить что-то может менеджер."}`
        : "Закройте рейс, когда вернулись: нужен одометр по возвращении. Пробег посчитается сам."}</p>
    </section>
  );
}
