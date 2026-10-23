import { useEffect, useMemo, useState } from "react";
import { INS_RATE, PAY_FORM, PAY_TO, can, routeFor, rub, type OrderRowView, type OrderStatus, type StaffMe, type TripView } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { CLIENT_ORIGIN, staffApi, type OrderPatch } from "./api.ts";

export const STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: "Ждёт подписи", cls: "gray" },
  signed: { text: "Подписан", cls: "warn" },
  paid: { text: "Оплачен", cls: "ok" },
  loading: { text: "Погрузка", cls: "gray" },
  in_transit: { text: "В пути", cls: "info" },
  arrived: { text: "Прибыл", cls: "ok" },
  delivered: { text: "Выдан", cls: "ok" },
};
const MANUAL: OrderStatus[] = ["signed", "paid", "loading", "in_transit", "arrived", "delivered"];
const SV_SHARE = 0.4;
const fmtPhone = (p: string) => (/^\+7\d{10}$/.test(p) ? `+7 ${p.slice(2, 5)} ${p.slice(5, 8)}-${p.slice(8, 10)}-${p.slice(10)}` : p); // доля страховки «Спасские Ворота»

export function OrdersScreen({ me }: { me: StaffMe }) {
  const [rows, setRows] = useState<OrderRowView[] | null>(null);
  const [trips, setTrips] = useState<TripView[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [unpaid, setUnpaid] = useState(false);
  const [error, setError] = useState("");
  const canEdit = can(me.role, "orders.edit");
  const canPay = can(me.role, "payments.edit");

  useEffect(() => {
    staffApi.orders().then(setRows, (e: ApiError) => setError(e.message));
    if (can(me.role, "trips.read")) staffApi.trips().then(setTrips, () => {});
  }, [me.role]);

  const shown = useMemo(() => (rows ?? []).filter((r) => {
    if (status && r.status !== status) return false;
    if (unpaid && r.paidDelivery && r.paidInsurance) return false;
    if (!q) return true;
    const s = q.toLowerCase();
    return [r.no, r.car, r.vin, r.city, r.client, r.phone, r.partner ?? ""].some((v) => String(v).toLowerCase().includes(s));
  }), [rows, q, status, unpaid]);

  async function patch(no: number, p: OrderPatch) {
    setError("");
    const before = rows;
    setRows((rs) => rs!.map((r) => (r.no === no ? { ...r, ...p } as OrderRowView : r))); // сразу показываем изменение
    try {
      const fresh = await staffApi.patchOrder(no, p);
      setRows((rs) => rs!.map((r) => (r.no === no ? fresh : r)));
    } catch (e) {
      setRows(before);
      setError((e as ApiError).message);
    }
  }

  if (!rows) return <p className="muted">{error || "Загружаем заявки…"}</p>;

  const sum = (f: (r: OrderRowView) => number) => shown.reduce((s, r) => s + f(r), 0);
  const owed = sum((r) => (r.paidDelivery ? 0 : r.delivery) + (r.paidInsurance ? 0 : r.insurance));

  return (
    <div className="stack">
      {can(me.role, "reports.read") && <div className="kpis">
        <div className="kpi"><b>{shown.length}</b><span>заявок</span></div>
        <div className="kpi"><b>{rub(owed)}</b><span>ожидает оплаты</span></div>
        <div className="kpi"><b>{rub(sum((r) => r.insurance * SV_SHARE))}</b><span>страховка · Спасские Ворота 40%</span></div>
        <div className="kpi"><b>{rub(sum((r) => r.insurance * (1 - SV_SHARE)))}</b><span>страховка · ИП Тодоров 60%</span></div>
        <div className="kpi"><b>{rub(sum((r) => r.cashback))}</b><span>кэшбэк партнёрам</span></div>
      </div>}

      <div className="filters">
        <input className="search" placeholder="Поиск: №, авто, VIN, город, клиент" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Статус">
          <option value="">Все статусы</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.text}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} /> Только неоплаченные</label>
      </div>
      {error && <div className="callout warn" role="alert">{error}</div>}

      <div className="tablewrap">
        <table className="sheet">
          <thead>
            <tr>
              <th colSpan={3}>Договор</th><th className="grp" colSpan={5}>Автомобиль</th><th className="grp" colSpan={3}>Клиент</th>
              <th className="grp" colSpan={3}>Перевозка</th><th className="grp" colSpan={2}>Страховка 0,3%</th>
              <th className="grp" colSpan={4}>Оплата</th><th className="grp" colSpan={2}>Доставка</th>
            </tr>
            <tr>
              <th>№</th><th>Дата</th><th>Статус</th>
              <th className="bl">Авто</th><th>VIN / кузов</th><th className="r">Год</th><th>Цвет</th><th>Город</th>
              <th className="bl">Получатель</th><th>Телефон</th><th>Партнёр</th>
              <th className="r bl">Тариф</th><th className="r">Кэшбэк</th><th className="r">В договоре</th>
              <th className="r bl">Оценка</th><th className="r">Сумма</th>
              <th className="bl">Перевозка</th><th>Страховка</th><th>Кому</th><th>Форма</th>
              <th className="bl">Рейс</th><th>Трекинг</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const st = STATUS[r.status] ?? STATUS.signed;
              const tripOptions = trips.filter((t) => routeFor(t.dest).includes(r.city));
              return (
                <tr key={r.no}>
                  <td className="mono">{r.no}</td>
                  <td>{new Date(r.createdAt).toLocaleDateString("ru-RU")}</td>
                  <td>
                    {canEdit && r.status !== "draft" ? (
                      <select value={r.status} onChange={(e) => patch(r.no, { status: e.target.value as OrderStatus })} aria-label={`Статус №${r.no}`}>
                        {MANUAL.map((s) => <option key={s} value={s}>{STATUS[s].text}</option>)}
                      </select>
                    ) : <span className={`pill ${st.cls}`}>{st.text}</span>}
                  </td>
                  <td className="bl">{r.car}</td><td className="mono">{r.vin}</td><td className="r">{r.year}</td><td>{r.color}</td><td>{r.city}</td>
                  <td className="bl">{r.client}</td><td className="mono">{fmtPhone(r.phone)}</td><td>{r.partner ?? "—"}</td>
                  <td className="r bl">{rub(r.tariff)}</td><td className="r">{r.cashback ? rub(r.cashback) : "—"}</td><td className="r"><b>{rub(r.delivery)}</b></td>
                  <td className="r bl">{rub(r.value)}</td><td className="r">{rub(r.insurance)}</td>
                  <td className="bl c"><input type="checkbox" disabled={!canPay} checked={r.paidDelivery} aria-label={`Оплата перевозки №${r.no}`} onChange={(e) => patch(r.no, { paidDelivery: e.target.checked })} /></td>
                  <td className="c"><input type="checkbox" disabled={!canPay} checked={r.paidInsurance} aria-label={`Оплата страховки №${r.no}`} onChange={(e) => patch(r.no, { paidInsurance: e.target.checked })} /></td>
                  <td>
                    <select disabled={!canPay} value={r.payTo} onChange={(e) => patch(r.no, { payTo: e.target.value })} aria-label={`Кому оплата №${r.no}`}>
                      <option value="" />{PAY_TO.map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </td>
                  <td>
                    <select disabled={!canPay} value={r.payForm} onChange={(e) => patch(r.no, { payForm: e.target.value })} aria-label={`Форма оплаты №${r.no}`}>
                      <option value="" />{PAY_FORM.map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </td>
                  <td className="bl">
                    {canEdit && r.status !== "draft" ? (
                      <select value={r.tripId ?? ""} onChange={(e) => patch(r.no, { tripId: e.target.value || null })} aria-label={`Рейс №${r.no}`}>
                        <option value="">—</option>
                        {tripOptions.map((t) => <option key={t.id} value={t.id}>{t.id} → {t.dest}</option>)}
                      </select>
                    ) : r.tripId ?? "—"}
                  </td>
                  <td>{r.trackToken ? <a href={`${CLIENT_ORIGIN}/t/${r.trackToken}`} target="_blank" rel="noopener">открыть</a> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={11}>Итого по выборке</td>
              <td className="r bl">{rub(sum((r) => r.tariff))}</td><td className="r">{rub(sum((r) => r.cashback))}</td><td className="r">{rub(sum((r) => r.delivery))}</td>
              <td className="r bl">{rub(sum((r) => r.value))}</td><td className="r">{rub(sum((r) => r.insurance))}</td>
              <td colSpan={6} className="bl">не оплачено {rub(owed)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="small muted">Страховка {INS_RATE * 100}% от оценки. Строки добавляются сами, когда клиент подписывает договор.</p>
    </div>
  );
}
