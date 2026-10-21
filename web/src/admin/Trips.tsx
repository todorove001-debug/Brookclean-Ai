import { useEffect, useState } from "react";
import { CITIES, NET, can, routeFor, rub, type StaffMe, type TripView } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { DEMO, navigate } from "../router.ts";
import { staffApi, type GoogleStatus, type NewTripBody } from "./api.ts";
import { TripReportScreen } from "./TripReport.tsx";

export const TRIP_STATUS = { loading: ["Погрузка", "gray"], in_transit: ["В пути", "info"], arrived: ["Прибыл", "ok"] } as const;
export const fmt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function TripsScreen({ me, path }: { me: StaffMe; path: string }) {
  const open = /^\/admin\/trips\/([\w-]+)/.exec(path.split("?")[0]);
  if (open) return <TripReportScreen key={open[1]} me={me} id={decodeURIComponent(open[1])} />;
  return <TripList me={me} />;
}

function TripList({ me }: { me: StaffMe }) {
  const [trips, setTrips] = useState<TripView[] | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState("");
  const canEdit = can(me.role, "trips.edit");
  const isDriver = !canEdit && can(me.role, "trips.driver");
  const canReport = can(me.role, "reports.read");

  useEffect(() => {
    staffApi.trips().then(setTrips, (e: ApiError) => setError(e.message));
    if (canReport) staffApi.google().then(setGoogle, () => {});
  }, [canReport]);

  const replace = (t: TripView) => setTrips((ts) => [t, ...(ts ?? []).filter((x) => x.id !== t.id)].sort((a, b) => (b.loadDate ?? "").localeCompare(a.loadDate ?? "")));
  const act = async (fn: () => Promise<TripView>) => {
    setError("");
    try {
      replace(await fn());
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  if (!trips) return <p className="muted">{error || "Загружаем рейсы…"}</p>;
  return (
    <div className="stack">
      {canReport && google && <GoogleCard status={google} me={me} onChange={setGoogle} />}
      {error && <div className="callout warn" role="alert">{error}</div>}
      {(canEdit || isDriver) && <NewTrip manager={canEdit} onSave={async (body) => {
        setError("");
        try {
          const t = await staffApi.createTrip(body);
          navigate(`/admin/trips/${encodeURIComponent(t.id)}`);
        } catch (e) {
          setError((e as ApiError).message);
          throw e;
        }
      }} />}
      <div className="trips">
        {trips.length === 0 && <p className="muted">{isDriver ? "У вас пока нет рейсов. Создайте рейс перед погрузкой." : "Рейсов пока нет."}</p>}
        {trips.map((t) => <TripCard key={t.id} t={t} canReport={canReport} driveOn={!!google?.connected} act={act} />)}
      </div>
    </div>
  );
}

function TripCard({ t, canReport, driveOn, act }: {
  t: TripView; canReport: boolean; driveOn: boolean; act: (fn: () => Promise<TripView>) => Promise<void>;
}) {
  const route = routeFor(t.dest);
  const [city, setCity] = useState(() => route.find((c) => NET[c][1] > t.km) ?? t.dest);
  const [note, setNote] = useState("");
  const [st, cls] = TRIP_STATUS[t.status];
  const last = t.events.at(-1);
  const canEdit = t.editable;
  const href = `/admin/trips/${encodeURIComponent(t.id)}`;
  return (
    <section className={`card${t.closedAt ? " closed" : ""}`}>
      <div className="row-between">
        <h3><a href={href} onClick={(e) => { e.preventDefault(); navigate(href); }}>{t.id} · Владивосток → {t.dest}</a></h3>
        {t.closedAt ? <span className="pill gray">Закрыт</span> : <span className={`pill ${cls}`}>{st}</span>}
      </div>
      <p className="small muted">{t.truck}{t.driver ? ` · водитель ${t.driver}` : ""}{t.loadDate ? ` · погрузка ${new Date(t.loadDate).toLocaleDateString("ru-RU")}` : ""}</p>
      <p className="small">{last ? <>Сейчас: <b>{last.city}</b>, {fmt(last.at)}</> : "Ещё не выехал"} · машин: {t.orders.length}{t.orders.length ? ` (№ ${t.orders.join(", ")})` : ""}
        {t.expensesTotal > 0 && <> · расходы {rub(t.expensesTotal)}</>}</p>
      {canEdit && (
        <div className="inline">
          <select value={city} onChange={(e) => setCity(e.target.value)} aria-label={`Текущая точка рейса ${t.id}`}>
            {route.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Комментарий" aria-label="Комментарий к отметке" />
          <button className="btn sm dark" onClick={() => act(() => staffApi.position(t.id, city, note)).then(() => setNote(""))}>Отметить</button>
        </div>
      )}
      <button className="btn sm primary self-start" onClick={() => navigate(href)}>Рейсовый отчёт</button>
      {canReport && (
        <div className="report-row">
          <span className="small"><b>Google Таблица:</b>{" "}
            {t.driveUrl ? <a href={t.driveUrl} target="_blank" rel="noopener">открыть</a> : driveOn ? "загрузится в течение минуты" : "Google Диск не подключён"}
            {t.driveSyncedAt && <span className="muted"> · обновлён {fmt(t.driveSyncedAt)}</span>}
          </span>
          <div className="inline">
            {!DEMO && <a className="btn sm ghost" href={`/api/staff/trips/${encodeURIComponent(t.id)}/report.csv`}>Скачать CSV</a>}
            {driveOn && <button className="btn sm ghost" onClick={() => act(() => staffApi.syncTrip(t.id))}>Обновить в Диске</button>}
          </div>
          {t.driveError && <span className="small err">Ошибка выгрузки: {t.driveError}</span>}
        </div>
      )}
    </section>
  );
}

function NewTrip({ manager, onSave }: { manager: boolean; onSave: (body: NewTripBody) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [drivers, setDrivers] = useState<Array<{ id: number; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ dest: "Новосибирск", truck: "", driverId: "", driver: "", loadDate: new Date().toISOString().slice(0, 10), odometerStart: "" });
  useEffect(() => {
    if (open && manager) staffApi.drivers().then(setDrivers, () => {});
  }, [open, manager]);
  if (!open) return <button className="btn primary self-start" onClick={() => setOpen(true)}>+ Новый рейс</button>;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  async function save() {
    setBusy(true);
    try {
      await onSave({
        dest: f.dest, truck: f.truck, loadDate: f.loadDate,
        driverId: f.driverId ? Number(f.driverId) : null, driver: f.driver,
        odometerStart: f.odometerStart ? Number(f.odometerStart.replace(/\D/g, "")) : null,
      });
    } catch {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h3>Новый рейс</h3>
      <div className="grid4">
        <div className="field"><label htmlFor="nt-dest">Конечный город</label>
          <select id="nt-dest" value={f.dest} onChange={set("dest")}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field"><label htmlFor="nt-truck">Автовоз</label><input id="nt-truck" value={f.truck} onChange={set("truck")} placeholder="Volvo FH · А 482 КР 125" /></div>
        {manager && (
          <div className="field"><label htmlFor="nt-driver">Водитель</label>
            {drivers.length > 0 ? (
              <select id="nt-driver" value={f.driverId} onChange={set("driverId")}>
                <option value="">— не назначен —</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            ) : <input id="nt-driver" value={f.driver} onChange={set("driver")} placeholder="Имя водителя" />}
          </div>
        )}
        <div className="field"><label htmlFor="nt-date">Дата погрузки</label><input id="nt-date" type="date" value={f.loadDate} onChange={set("loadDate")} /></div>
        <div className="field"><label htmlFor="nt-odo">Одометр при выезде, км</label>
          <input id="nt-odo" inputMode="numeric" value={f.odometerStart} onChange={set("odometerStart")} placeholder="412 300" /></div>
      </div>
      <div className="inline">
        <button className="btn sm primary" disabled={busy || !f.truck.trim()} onClick={save}>Создать рейс</button>
        <button className="btn sm ghost" onClick={() => setOpen(false)}>Отмена</button>
      </div>
      <p className="small muted">Номер рейса присвоится сам. {manager
        ? "Водитель увидит рейс у себя после входа. Машины грузятся в отчёте рейса или в таблице заявок."
        : "Рейс будет записан на вас. Дальше в отчёте отметите погруженные машины, точки маршрута и расходы."}</p>
    </section>
  );
}

function GoogleCard({ status, me, onChange }: { status: GoogleStatus; me: StaffMe; onChange: (s: GoogleStatus) => void }) {
  const owner = can(me.role, "staff.manage");
  if (status.connected) {
    return (
      <section className="card google ok-border">
        <div className="row-between">
          <span><b>Google Диск подключён.</b> Рейсовые отчёты загружаются сами.</span>
          <div className="inline">
            {status.folderUrl && <a className="btn sm ghost" href={status.folderUrl} target="_blank" rel="noopener">Открыть папку</a>}
            {owner && <button className="btn sm ghost" onClick={async () => { await staffApi.googleDisconnect(); onChange({ ...status, connected: false }); }}>Отключить</button>}
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="card google">
      <b>Google Диск не подключён</b>
      {DEMO ? (
        <p className="small muted">В демо Диск не подключается. На сервере владелец один раз входит в Google, и по каждому рейсу появляется Google Таблица с отчётом, которая обновляется сама.</p>
      ) : !status.configured ? (
        <p className="small muted">На сервере не заданы ключи Google (GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET). Инструкция в README.</p>
      ) : owner ? (
        <>
          <p className="small">Войдите в Google-аккаунт, на чей Диск класть отчёты. Сайт получит доступ только к своим файлам в папке «Brookclean · рейсовые отчёты».</p>
          <a className="btn sm primary self-start" href="/api/staff/google/connect">Подключить Google Диск</a>
        </>
      ) : (
        <p className="small muted">Подключить может владелец.</p>
      )}
    </section>
  );
}
