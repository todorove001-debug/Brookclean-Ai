import { useEffect, useState } from "react";
import { EXPENSE_KINDS, NET, RECEIPT_FIELDS, REPORT_STATUS, can, routeFor, rub, type ExpenseKind, type RecognizeResult, type StaffMe, type TripReport, type WaitingCar } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { DEMO, navigate } from "../router.ts";
import { staffApi } from "./api.ts";
import { TRIP_STATUS, fmt } from "./Trips.tsx";
import { RecognizedFields, photoToJpeg } from "./Recognized.tsx";

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
  // Сданный отчёт водитель не меняет, пока менеджер не вернёт его на доработку
  const locked = !manager && (t.reportStatus === "submitted" || t.reportStatus === "accepted");
  const edit = t.editable && !locked;
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
          <div className="kpi"><b>{rub(t.advance)}</b><span>аванс водителю</span></div>
          <div className={`kpi${r.totals.balance < 0 ? " neg" : ""}`}><b>{rub(Math.abs(r.totals.balance))}</b>
            <span>{r.totals.balance < 0 ? "перерасход, вернуть водителю" : "остаток аванса у водителя"}</span></div>
          {r.finance && <>
            <div className="kpi"><b>{rub(r.totals.delivery!)}</b><span>перевозка по договорам</span></div>
            <div className="kpi"><b>{rub(r.totals.unpaid!)}</b><span>не оплачено</span></div>
            <div className="kpi"><b>{rub(r.totals.revenue!)}</b><span>выручка рейса по тарифам (перегруз — по доле км)</span></div>
            <div className={`kpi ${r.totals.revenue! - r.totals.expenses >= 0 ? "pos" : "neg"}`}><b>{rub(r.totals.revenue! - r.totals.expenses)}</b><span>результат рейса до зарплаты</span></div>
          </>}
        </div>
      </section>
      {error && <div className="callout warn" role="alert">{error}</div>}

      <Review r={r} me={me} manager={manager} act={act} />
      <Cars r={r} waiting={waiting} edit={t.editable} act={act} />
      <Route r={r} edit={t.editable} act={act} />
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
      {edit && <ReceiptPhoto tripId={t.id} act={act} />}
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

/** Вид расхода в отчёте по категории чека. */
const KIND_OF: Record<string, ExpenseKind> = { fuel: "fuel", toll: "toll", parking: "parking", food: "food", repair: "repair", wash: "wash" };
const RX_FIELDS = RECEIPT_FIELDS.filter(([k]) => k !== "category");

/** Чек по фото: Яндекс читает поля, водитель сверяет с фото и только потом расход сохраняется. */
function ReceiptPhoto({ tripId, act }: { tripId: string; act: Act }) {
  const [s, setS] = useState<null | { photo: string; busy: boolean; r: RecognizeResult | null; v: Record<string, string>; kind: ExpenseKind; msg: string }>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setS(null); return; }
    const photo = await photoToJpeg(file);
    setS({ photo, busy: true, r: null, v: {}, kind: "other", msg: "" });
    try {
      const r = await staffApi.recognize("receipt", photo);
      const msg = r.error === "not_receipt" ? "На фото не видно кассового чека. Сфотографируйте чек целиком при хорошем свете или заполните поля вручную."
        : r.error ? "Чек не прочитался. Заполните поля по фото." : "";
      setS({ photo, busy: false, r, v: r.fields, kind: KIND_OF[r.fields.category] ?? "other", msg });
    } catch (e) {
      setS({ photo, busy: false, r: null, v: {}, kind: "other", msg: (e as ApiError).message });
    }
  }

  async function save() {
    if (!s) return;
    const v = s.v;
    const fiscal = [v.fn && `ФН ${v.fn}`, v.fd && `ФД ${v.fd}`, v.fp && `ФП ${v.fp}`].filter(Boolean).join(" ");
    const note = [[v.seller, v.city].filter(Boolean).join(", "), [v.date, v.time].filter(Boolean).join(" "), v.description, fiscal].filter(Boolean).join(" · ");
    const ok = await act(() => staffApi.addExpense(tripId, {
      kind: s.kind, amount: Math.round(Number(String(v.amount ?? "").replace(/\s/g, "").replace(",", "."))),
      liters: s.kind === "fuel" && v.liters ? Number(String(v.liters).replace(",", ".")) : null, note,
    }));
    if (ok) setS(null);
  }

  if (!s) return (
    <div className="inline">
      <label className="btn sm dark filebtn">Чек по фото
        <input type="file" accept="image/*" capture="environment" aria-label="Сфотографировать чек" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      <span className="small muted">Сумма, дата, ФД и ФП подставятся с фото, вы сверите и сохраните.</span>
    </div>
  );
  if (s.busy) return <p className="small muted">Читаем чек… обычно 5–15 секунд.</p>;
  return (
    <div className="stack">
      {s.msg && <div className="callout warn">{s.msg}</div>}
      <RecognizedFields
        r={s.r} photo={s.photo} fields={RX_FIELDS} values={s.v}
        onChange={(k, val) => setS((x) => x && { ...x, v: { ...x.v, [k]: val } })}
        onConfirm={save} onCancel={() => setS(null)} confirmLabel="Сохранить расход"
        extra={
          <div className="field"><label htmlFor="rx-kind">Вид расхода</label>
            <select id="rx-kind" value={s.kind} onChange={(e) => setS((x) => x && { ...x, kind: e.target.value as ExpenseKind })}>
              {Object.entries(EXPENSE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select></div>
        }
      />
    </div>
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

/** Сдача отчёта водителем и решение менеджера: принять или вернуть с комментарием. */
function Review({ r, me, manager, act }: { r: TripReport; me: StaffMe; manager: boolean; act: Act }) {
  const t = r.trip;
  const [comment, setComment] = useState("");
  const [advance, setAdvance] = useState(String(t.advance || ""));
  const [label, cls] = REPORT_STATUS[t.reportStatus];
  const reviewer = can(me.role, "reports.read");
  const canSubmit = t.editable && (t.reportStatus === "draft" || t.reportStatus === "returned");
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
  return (
    <section className="card">
      <div className="row-between">
        <h3>Отчёт водителя</h3>
        <span className={`pill ${cls}`}>{label}</span>
      </div>
      {t.reportStatus === "returned" && t.reportComment && <div className="callout warn"><b>Менеджер вернул отчёт:</b> {t.reportComment}</div>}
      {t.reportStatus === "submitted" && <div className="callout info">Отчёт сдан {when(t.submittedAt)}. {reviewer ? "Проверьте чеки и пробег." : "Пока менеджер проверяет, изменения недоступны."}</div>}
      {t.reportStatus === "accepted" && <div className="callout ok">Отчёт принят {when(t.acceptedAt)}. {r.totals.balance >= 0
        ? `Водитель возвращает остаток аванса ${rub(r.totals.balance)}.` : `Водителю компенсируют перерасход ${rub(-r.totals.balance)}.`}{t.reportComment ? ` Комментарий: ${t.reportComment}` : ""}</div>}
      {t.reportStatus === "draft" && <p className="small muted">{canSubmit && !manager
        ? "Когда все чеки внесены, сдайте отчёт: менеджер проверит и примет его или вернёт с комментарием."
        : "Водитель заполняет отчёт. Чеки появляются здесь сразу после загрузки."}</p>}
      {canSubmit && <button className="btn dark self-start" disabled={!r.expenses.length} onClick={() => act(() => staffApi.submitReport(t.id))}>
        {t.reportStatus === "returned" ? "Сдать исправленный отчёт" : "Сдать отчёт на проверку"}</button>}
      {reviewer && t.reportStatus === "submitted" && <>
        <div className="field">
          <label htmlFor="rep-cmt">Комментарий водителю</label>
          <textarea id="rep-cmt" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: нет чека за стоянку в Чите" />
        </div>
        <div className="inline">
          <button className="btn ghost" disabled={!comment.trim()} onClick={() => act(() => staffApi.decideReport(t.id, false, comment))}>Вернуть на доработку</button>
          <button className="btn primary" onClick={() => act(() => staffApi.decideReport(t.id, true, comment))}>Принять отчёт</button>
        </div>
      </>}
      {manager && (
        <div className="inline">
          <div className="field">
            <label htmlFor="rep-adv">Аванс водителю, ₽</label>
            <input id="rep-adv" inputMode="numeric" value={advance} onChange={(e) => setAdvance(e.target.value)} />
          </div>
          <button className="btn sm ghost self-end" disabled={Number(advance.replace(/\D/g, "")) === t.advance}
            onClick={() => act(() => staffApi.tripMeta(t.id, { advance: Number(advance.replace(/\D/g, "")) || 0 }))}>Сохранить аванс</button>
        </div>
      )}
    </section>
  );
}
