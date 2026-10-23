import { useEffect, useState } from "react";
import { PERMISSIONS, ROLES, SITES, type Permission, type Role, type StaffMe } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { staffApi, type StaffUser } from "./api.ts";

const ROLE_KEYS = Object.keys(ROLES) as Role[];

export function StaffScreen({ me }: { me: StaffMe }) {
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState("");
  const [f, setF] = useState({ name: "", login: "", password: "", role: "manager" as Role, site: "Владивосток" });
  const [reset, setReset] = useState<{ id: number; password: string } | null>(null);

  useEffect(() => {
    staffApi.users().then(setUsers, (e: ApiError) => setError(e.message));
  }, []);

  const run = async (fn: () => Promise<StaffUser>) => {
    setError("");
    try {
      const u = await fn();
      setUsers((us) => (us!.some((x) => x.id === u.id) ? us!.map((x) => (x.id === u.id ? u : x)) : [...us!, u]));
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    }
  };

  if (!users) return <p className="muted">{error || "Загружаем…"}</p>;
  return (
    <div className="stack">
      {error && <div className="callout warn" role="alert">{error}</div>}
      <div className="tablewrap">
        <table className="sheet narrow">
          <thead><tr><th>Сотрудник</th><th>Логин</th><th>Роль</th><th>Доступ</th><th>Пароль</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? "" : "off"}>
                <td>{u.name}{u.id === me.id ? " (вы)" : ""}</td>
                <td className="mono">{u.login}</td>
                <td>
                  <select value={u.role} onChange={(e) => run(() => staffApi.patchUser(u.id, { role: e.target.value as Role }))} aria-label={`Роль ${u.name}`}>
                    {ROLE_KEYS.map((r) => <option key={r} value={r}>{ROLES[r].name}</option>)}
                  </select>
                  {u.role === "acceptor" && (
                    <select value={u.site ?? "Владивосток"} onChange={(e) => run(() => staffApi.patchUser(u.id, { site: e.target.value }))} aria-label={`Площадка ${u.name}`}>
                      {SITES.map((s) => <option key={s} value={s}>{s === "Новосибирск" ? "Терминал Новосибирск" : s}</option>)}
                    </select>
                  )}
                </td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={u.active} onChange={(e) => run(() => staffApi.patchUser(u.id, { active: e.target.checked }))} />
                    {u.active ? "включён" : "выключен"}
                  </label>
                </td>
                <td>
                  {reset?.id === u.id ? (
                    <span className="inline">
                      <input value={reset.password} onChange={(e) => setReset({ id: u.id, password: e.target.value })} placeholder="Новый пароль" aria-label="Новый пароль" />
                      <button className="btn sm dark" onClick={async () => { if (await run(() => staffApi.patchUser(u.id, { password: reset.password }))) setReset(null); }}>Сохранить</button>
                    </span>
                  ) : <button className="linkbtn" onClick={() => setReset({ id: u.id, password: "" })}>Сменить</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="card">
        <h3>Добавить сотрудника</h3>
        <div className="grid4">
          <div className="field"><label htmlFor="su-name">Имя</label><input id="su-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="su-login">Логин (телефон или email)</label><input id="su-login" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></div>
          <div className="field"><label htmlFor="su-pass">Пароль, от 8 символов</label><input id="su-pass" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <div className="field"><label htmlFor="su-role">Роль</label>
            <select id="su-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLE_KEYS.map((r) => <option key={r} value={r}>{ROLES[r].name}</option>)}</select></div>
          {f.role === "acceptor" && (
            <div className="field"><label htmlFor="su-site">Площадка</label>
              <select id="su-site" value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })}>{SITES.map((s) => <option key={s} value={s}>{s === "Новосибирск" ? "Терминал Новосибирск" : s}</option>)}</select></div>
          )}
        </div>
        <button className="btn sm primary self-start" onClick={async () => { if (await run(() => staffApi.createUser(f))) setF({ name: "", login: "", password: "", role: "manager", site: "Владивосток" }); }}>Добавить</button>
        <p className="small muted">Передайте сотруднику логин и пароль лично. Выключенный сотрудник сразу теряет доступ.</p>
      </section>

      <section className="card">
        <h3>Что может каждая роль</h3>
        <div className="tablewrap">
          <table className="sheet narrow matrix">
            <thead><tr><th>Право</th>{ROLE_KEYS.map((r) => <th key={r} className="c">{ROLES[r].name}</th>)}</tr></thead>
            <tbody>
              {(Object.keys(PERMISSIONS) as Permission[]).map((p) => (
                <tr key={p}><td>{PERMISSIONS[p]}</td>{ROLE_KEYS.map((r) => <td key={r} className="c">{(ROLES[r].perms as readonly Permission[]).includes(p) ? "✓" : ""}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
