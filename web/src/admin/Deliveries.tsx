import { useEffect, useState } from "react";
import { CAPACITY, PAY_FORM, PAY_TO, SV_SHARE, can, rub, type BackhaulRow, type Deliveries, type DeliveryRow, type StaffMe } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { navigate } from "../router.ts";
import { staffApi, type OrderPatch } from "./api.ts";

const STATUS_RU: Record<string, [string, string]> = {
  draft: ["ждёт подписи", "gray"], signed: ["подписан", "gray"], paid: ["оплачен", "info"], loading: ["погрузка", "warn"],
  in_transit: ["в пути", "info"], arrived: ["прибыл", "ok"], delivered: ["выдан", "ok"],
};
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) : "");

/** Таблица доставок по рейсу — как лист «Рейс» в Google Таблице: машины, движение, деньги, страховка, оплата, обратка. */
export function DeliveriesScreen({ me, id }: { me: StaffMe; id: string }) {
  const [d, setD] = useState<Deliveries | null>(null);
  const [error, setError] = useState("");
  const pay = can(me.role, "payments.edit");
  const manager = can(me.role, "trips.edit");
  const load = () => staffApi.deliveries(id).then(setD, (e: ApiError) => setError(e.message));
  useEffect(() => {
    load();
  }, [id]);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  const patch = (no: number, p: OrderPatch) => run(() => staffApi.patchOrder(no, p));

  const href = `/admin/trips/${encodeURIComponent(id)}`;
  const back = <a className="small" href={href} onClick={(e) => { e.preventDefault(); navigate(href); }}>← Рейсовый отчёт {id}</a>;
  if (!d) return <div className="stack">{back}<p className="muted">{error || "Загружаем таблицу…"}</p></div>;

  const { trip: t, rows } = d;
  const sum = (f: (r: DeliveryRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const paidFull = rows.filter((r) => r.paidDelivery && r.paidInsurance).length;
  return (
    <div className="stack">
      {back}
      <section className="card">
        <div className="row-between">
          <h2>Доставки · рейс {t.id}{t.loadDate ? ` от ${new Date(t.loadDate).toLocaleDateString("ru-RU")}` : ""} · Владивосток → {t.dest}</h2>
          <span className={`pill ${t.formedAt ? "ok" : "warn"}`}>{t.formedAt ? "сформирован" : "формируется"}</span>
        </div>
        <div className="grid4">
          <MetaField label="Тягач" value={t.truck} edit={manager} save={(v) => run(() => staffApi.tripMeta(t.id, { truck: v }))} />
          <MetaField label="Прицеп" value={t.trailer} edit={manager} placeholder="марка, госномер" save={(v) => run(() => staffApi.tripMeta(t.id, { trailer: v }))} />
          <MetaField label="Перевозчик" value={t.carrier} edit={manager} placeholder="собственный или компания" save={(v) => run(() => staffApi.tripMeta(t.id, { carrier: v }))} />
          <div className="field"><label>Водитель</label><div>{t.driver || "не назначен"}{t.driverPhone && <span className="muted mono"> · {t.driverPhone}</span>}</div></div>
        </div>
      </section>
      {error && <div className="callout warn" role="alert">{error}</div>}
      <div className="kpis">
        <div className="kpi"><b>{rows.length} / {CAPACITY}</b><span>мест занято</span></div>
        <div className="kpi"><b>{rub(sum((r) => r.delivery))}</b><span>стоимость отправки по рейсу</span></div>
        <div className="kpi"><b>{rub(sum((r) => r.insurance))}</b><span>страховка · СВ {rub(sum((r) => r.insurance * SV_SHARE))}</span></div>
        <div className="kpi"><b>{rub(sum((r) => r.cashback))}</b><span>кэшбэк партнёрам</span></div>
        <div className={`kpi ${paidFull < rows.length ? "neg" : "pos"}`}><b>{paidFull} / {rows.length}</b><span>оплачено полностью</span></div>
      </div>
      <div className="tablewrap">
        <table className="sheet">
          <thead>
            <tr>
              <th colSpan={2} /><th className="grp" colSpan={4}>Автомобиль</th><th className="grp" colSpan={3}>Получатель и договор</th>
              <th className="grp" colSpan={d.throughTransfer ? 4 : 2}>Движение</th><th className="grp" colSpan={7}>Стоимость, страховка</th>
              <th className="grp" colSpan={5}>Оплата</th>
            </tr>
            <tr>
              <th className="r">№</th><th>Статус</th>
              <th className="bl">Авто</th><th>VIN номер</th><th className="r">Год</th><th>Город доставки</th>
              <th className="bl">Получатель</th><th>Телефон</th><th>Договор №, дата</th>
              {d.throughTransfer && <><th className="bl">Прибыл Нск</th><th>Убыл Нск</th></>}
              <th className={d.throughTransfer ? "" : "bl"}>Прибыл в пункт</th><th>Выдан</th>
              <th className="r bl">Стоимость отправки</th><th className="r">Оценочная</th><th className="r">Страховка</th><th className="r">СВ 40%</th><th className="r">ИП 60%</th><th className="r">Кэшбэк</th><th>№ страховки</th>
              <th className="bl">Отправка</th><th>Страховка</th><th>Кому оплата</th><th>Форма</th><th>Отправитель</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={27} className="muted">В рейсе нет машин</td></tr>}
            {rows.map((r, i) => {
              const [st, cls] = STATUS_RU[r.status] ?? [r.status, "gray"];
              return (
                <tr key={r.no}>
                  <td className="r">{i + 1}</td><td><span className={`pill ${cls}`}>{st}</span></td>
                  <td className="bl"><b>{r.car}</b></td><td className="mono">{r.vin}</td><td className="r">{r.year}</td>
                  <td>{r.city}{r.legNote && <><br /><small className="muted">{r.legNote}</small></>}</td>
                  <td className="bl">{r.client}</td><td className="mono">{r.phone}</td><td className="nowrap">{r.no} от {day(r.createdAt)}</td>
                  {d.throughTransfer && <><td className="bl mono">{day(r.arrivedTransfer)}</td><td className="mono">{day(r.leftTransfer)}</td></>}
                  <td className={`mono${d.throughTransfer ? "" : " bl"}`}>{day(r.arrivedCity)}</td><td className="mono">{day(r.deliveredAt)}</td>
                  <td className="r bl"><b>{rub(r.delivery)}</b></td><td className="r">{rub(r.value)}</td><td className="r">{rub(r.insurance)}</td>
                  <td className="r">{rub(r.insurance * SV_SHARE)}</td><td className="r">{rub(r.insurance * (1 - SV_SHARE))}</td><td className="r">{r.cashback ? rub(r.cashback) : "—"}</td>
                  <td>{pay ? <PolicyInput value={r.policyNo} save={(v) => patch(r.no, { policyNo: v })} /> : r.policyNo || "—"}</td>
                  <td className="bl c"><input type="checkbox" disabled={!pay} checked={r.paidDelivery} aria-label={`Оплата отправки №${r.no}`} onChange={(e) => patch(r.no, { paidDelivery: e.target.checked })} /></td>
                  <td className="c"><input type="checkbox" disabled={!pay} checked={r.paidInsurance} aria-label={`Оплата страховки №${r.no}`} onChange={(e) => patch(r.no, { paidInsurance: e.target.checked })} /></td>
                  <td>{pay ? <select value={r.payTo} aria-label="Кому оплата" onChange={(e) => patch(r.no, { payTo: e.target.value })}><option value="" />{PAY_TO.map((x) => <option key={x}>{x}</option>)}</select> : r.payTo}</td>
                  <td>{pay ? <select value={r.payForm} aria-label="Форма оплаты" onChange={(e) => patch(r.no, { payForm: e.target.value })}><option value="" />{PAY_FORM.map((x) => <option key={x}>{x}</option>)}</select> : r.payForm}</td>
                  <td>{r.partner ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={d.throughTransfer ? 13 : 11}>Итого · {rows.length} авто</td>
                <td className="r bl">{rub(sum((r) => r.delivery))}</td><td className="r">{rub(sum((r) => r.value))}</td><td className="r">{rub(sum((r) => r.insurance))}</td>
                <td className="r">{rub(sum((r) => r.insurance * SV_SHARE))}</td><td className="r">{rub(sum((r) => r.insurance * (1 - SV_SHARE)))}</td><td className="r">{rub(sum((r) => r.cashback))}</td>
                <td colSpan={7} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="small muted">Машина с перегрузкой стоит в таблицах обоих рейсов, как в вашем файле. Даты «Прибыл» берутся из отметок пути водителя, «Убыл Нск» для перегруза — из закрытого раздела акта «Погрузка с терминала».</p>
      <Backhaul tripId={t.id} list={d.backhaul} edit={manager} onChange={(b) => setD({ ...d, backhaul: b })} onError={setError} />
    </div>
  );
}

function MetaField({ label, value, edit, placeholder, save }: { label: string; value: string; edit: boolean; placeholder?: string; save: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const id = `meta-${label}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {edit ? <input id={id} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== value && save(v.trim())} />
        : <div>{value || "—"}</div>}
    </div>
  );
}

function PolicyInput({ value, save }: { value: string; save: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input className="mono" value={v} placeholder="№/СГ-2026" aria-label="Номер страховки" onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== value && save(v.trim())} />;
}

function Backhaul({ tripId, list, edit, onChange, onError }: {
  tripId: string; list: BackhaulRow[]; edit: boolean; onChange: (b: BackhaulRow[]) => void; onError: (m: string) => void;
}) {
  const empty = { car: "", vin: "", route: "", client: "", price: "" };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const run = async (fn: () => Promise<BackhaulRow[]>) => {
    try {
      onChange(await fn());
      return true;
    } catch (e) {
      onError((e as ApiError).message);
      return false;
    }
  };
  return (
    <section className="card">
      <div className="row-between"><h3>Обратка</h3><span className="small muted">тот же автовоз, обратный путь</span></div>
      {list.length > 0 && (
        <div className="tablewrap">
          <table className="sheet narrow">
            <thead><tr><th>Авто</th><th>VIN</th><th>Маршрут</th><th>Получатель</th><th className="r">Стоимость</th>{edit && <th />}</tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td>{b.car}</td><td className="mono">{b.vin}</td><td>{b.route}</td><td>{b.client}</td><td className="r">{b.price !== null ? rub(b.price) : "—"}</td>
                  {edit && <td><button className="btn sm ghost" aria-label="Удалить" onClick={() => run(() => staffApi.deleteBackhaul(tripId, b.id))}>×</button></td>}
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}>Итого · {list.length} авто</td><td className="r">{rub(list.reduce((s, b) => s + (b.price ?? 0), 0))}</td>{edit && <td />}</tr></tfoot>
          </table>
        </div>
      )}
      {list.length === 0 && <p className="small muted">Обратных машин пока нет.</p>}
      {edit && (
        <div className="grid4">
          <div className="field"><label htmlFor="bh-car">Авто</label><input id="bh-car" value={f.car} onChange={set("car")} placeholder="Mazda CX-9" /></div>
          <div className="field"><label htmlFor="bh-vin">VIN / кузов</label><input id="bh-vin" className="mono" value={f.vin} onChange={set("vin")} /></div>
          <div className="field"><label htmlFor="bh-route">Маршрут</label><input id="bh-route" value={f.route} onChange={set("route")} placeholder="Новосибирск → Уссурийск" /></div>
          <div className="field"><label htmlFor="bh-client">Получатель</label><input id="bh-client" value={f.client} onChange={set("client")} /></div>
          <div className="field"><label htmlFor="bh-price">Стоимость, ₽</label><input id="bh-price" inputMode="numeric" value={f.price} onChange={set("price")} /></div>
          <div className="field self-end">
            <button className="btn dark" disabled={!f.car.trim()} onClick={async () => {
              const price = f.price.replace(/\D/g, "");
              if (await run(() => staffApi.addBackhaul(tripId, { ...f, price: price ? Number(price) : null }))) setF(empty);
            }}>Добавить</button>
          </div>
        </div>
      )}
    </section>
  );
}
