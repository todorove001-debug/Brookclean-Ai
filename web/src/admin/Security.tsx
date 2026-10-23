import { useEffect, useState } from "react";
import { SECURITY_KINDS, type SecurityReport } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { staffApi } from "./api.ts";

const when = (ms: number | string) => new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Защита цен: кто подозрительно часто считает цены, и чёрный список номеров и IP. */
export function SecurityScreen() {
  const [r, setR] = useState<SecurityReport | null>(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    staffApi.security().then(setR, (e: ApiError) => setError(e.message));
  }, []);

  async function act(fn: () => Promise<SecurityReport>) {
    setError("");
    try {
      setR(await fn());
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  if (!r) return <p className="muted">{error || "Загружаем…"}</p>;

  return (
    <div className="stack">
      <p className="small muted">
        Цену на сайте видят только клиенты, подтвердившие номер по SMS. Один номер может посчитать до 6 вариантов в сутки.
        Здесь видно, кто упирается в лимиты или перебирает города. Заблокированный номер или IP получает ответ «позвоните нам».
      </p>

      <section className="card">
        <h3>Подозрительные за 7 дней</h3>
        {r.suspects.length === 0 ? <p className="muted small">Пока никого.</p> : (
          <div className="tablewrap">
            <table className="sheet narrow">
              <thead><tr><th>Телефон или IP</th><th className="r">Событий</th><th className="r">Расчётов</th><th className="r">Городов</th><th>Последний раз</th><th /></tr></thead>
              <tbody>
                {r.suspects.map((s) => (
                  <tr key={s.kind + s.value}>
                    <td className="mono">{s.value}</td>
                    <td className="r">{s.events}</td>
                    <td className="r">{s.quotes}</td>
                    <td className="r">{s.cities}</td>
                    <td>{when(s.last)}</td>
                    <td>
                      {s.blocked
                        ? <span className="pill gray">заблокирован</span>
                        : <button className="btn sm ghost" onClick={() => act(() => staffApi.block(s.value, "из журнала"))}>Заблокировать</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Чёрный список</h3>
        <div className="inline">
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Телефон или IP" aria-label="Телефон или IP" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Заметка, например «конкурент»" aria-label="Заметка" />
          <button className="btn sm primary" disabled={!value.trim()}
            onClick={() => act(async () => { const res = await staffApi.block(value, note); setValue(""); setNote(""); return res; })}>
            Заблокировать
          </button>
        </div>
        {error && <div className="callout warn" role="alert">{error}</div>}
        {r.blocked.length > 0 && (
          <div className="tablewrap">
            <table className="sheet narrow">
              <thead><tr><th>Телефон или IP</th><th>Заметка</th><th>С</th><th /></tr></thead>
              <tbody>
                {r.blocked.map((b) => (
                  <tr key={b.value}>
                    <td className="mono">{b.value}</td><td>{b.note}</td><td>{when(b.at)}</td>
                    <td><button className="btn sm ghost" onClick={() => act(() => staffApi.unblock(b.value))}>Разблокировать</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Журнал</h3>
        {r.events.length === 0 ? <p className="muted small">Записей за 7 дней нет.</p> : (
          <div className="tablewrap">
            <table className="sheet narrow">
              <thead><tr><th>Когда</th><th>Что</th><th>Телефон</th><th>IP</th><th>Подробности</th></tr></thead>
              <tbody>
                {r.events.map((e) => (
                  <tr key={e.id}>
                    <td>{when(e.at)}</td><td>{SECURITY_KINDS[e.kind] ?? e.kind}</td><td className="mono">{e.phone || "—"}</td>
                    <td className="mono">{e.ip}</td><td>{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
