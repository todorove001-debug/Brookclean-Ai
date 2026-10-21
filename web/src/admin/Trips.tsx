import { useEffect, useState } from "react";
import { CITIES, NET, can, routeFor, type StaffMe, type TripView } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { DEMO } from "../router.ts";
import { staffApi, type GoogleStatus } from "./api.ts";

const TRIP_STATUS = { loading: ["Погрузка", "gray"], in_transit: ["В пути", "info"], arrived: ["Прибыл", "ok"] } as const;
const fmt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function TripsScreen({ me }: { me: StaffMe }) {
  const [trips, setTrips] = useState<TripView[] | null>(null);
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState("");
  const canEdit = can(me.role, "trips.edit");
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
      {canEdit && <NewTrip onSave={(id, body) => act(() => staffApi.saveTrip(id, body))} />}
      <div className="trips">
        {trips.length === 0 && <p className="muted">Рейсов пока нет.</p>}
        {trips.map((t) => <TripCard key={t.id} t={t} canEdit={canEdit} canReport={canReport} driveOn={!!google?.connected} act={act} />)}
      </div>
    </div>
  );
}

function TripCard({ t, canEdit, canReport, driveOn, act }: {
  t: TripView; canEdit: boolean; canReport: boolean; driveOn: boolean; act: (fn: () => Promise<TripView>) => Promise<void>;
}) {
  const route = routeFor(t.dest);
  const [city, setCity] = useState(() => route.find((c) => NET[c][1] > t.km) ?? t.dest);
  const [note, setNote] = useState("");
  const [st, cls] = TRIP_STATUS[t.status];
  const last = t.events.at(-1);
  return (
    <section className="card">
      <div className="row-between">
        <h3>{t.id} · Владивосток → {t.dest}</h3>
        <span className={`pill ${cls}`}>{st}</span>
      </div>
      <p className="small muted">{t.truck}{t.driver ? ` · водитель ${t.driver}` : ""}{t.loadDate ? ` · погрузка ${new Date(t.loadDate).toLocaleDateString("ru-RU")}` : ""}</p>
      <p className="small">{last ? <>Сейчас: <b>{last.city}</b>, {fmt(last.at)}</> : "Ещё не выехал"} · машин: {t.orders.length}{t.orders.length ? ` (№ ${t.orders.join(", ")})` : ""}</p>
      {canEdit && (
        <div className="inline">
          <select value={city} onChange={(e) => setCity(e.target.value)} aria-label={`Текущая точка рейса ${t.id}`}>
            {route.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Комментарий" aria-label="Комментарий к отметке" />
          <button className="btn sm dark" onClick={() => act(() => staffApi.position(t.id, city, note)).then(() => setNote(""))}>Отметить</button>
        </div>
      )}
      {canReport && (
        <div className="report-row">
          <span className="small"><b>Рейсовый отчёт:</b>{" "}
            {t.driveUrl ? <a href={t.driveUrl} target="_blank" rel="noopener">Google Таблица</a> : driveOn ? "загрузится в течение минуты" : "Google Диск не подключён"}
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

function NewTrip({ onSave }: { onSave: (id: string, body: { dest: string; truck: string; driver: string; loadDate: string }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ id: "", dest: "Новосибирск", truck: "", driver: "", loadDate: "" });
  if (!open) return <button className="btn ghost self-start" onClick={() => setOpen(true)}>+ Новый рейс</button>;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <section className="card">
      <h3>Новый рейс</h3>
      <div className="grid4">
        <div className="field"><label htmlFor="nt-id">Номер рейса</label><input id="nt-id" value={f.id} onChange={set("id")} placeholder="R-04" /></div>
        <div className="field"><label htmlFor="nt-dest">Конечный город</label>
          <select id="nt-dest" value={f.dest} onChange={set("dest")}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field"><label htmlFor="nt-truck">Автовоз</label><input id="nt-truck" value={f.truck} onChange={set("truck")} placeholder="Volvo FH · А 482 КР 125" /></div>
        <div className="field"><label htmlFor="nt-driver">Водитель</label><input id="nt-driver" value={f.driver} onChange={set("driver")} /></div>
        <div className="field"><label htmlFor="nt-date">Дата погрузки</label><input id="nt-date" type="date" value={f.loadDate} onChange={set("loadDate")} /></div>
      </div>
      <div className="inline">
        <button className="btn sm primary" disabled={!f.id || !f.truck} onClick={() => onSave(f.id.trim(), f).then(() => setOpen(false))}>Создать рейс</button>
        <button className="btn sm ghost" onClick={() => setOpen(false)}>Отмена</button>
      </div>
      <p className="small muted">Машины ставятся в рейс в таблице заявок, колонка «Рейс». Отчёт по рейсу обновляется в Google Диске после каждого изменения.</p>
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
