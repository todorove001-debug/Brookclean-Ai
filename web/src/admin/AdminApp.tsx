import { useEffect, useState } from "react";
import { ROLES, type StaffMe } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { DEMO, navigate } from "../router.ts";
import { staffApi } from "./api.ts";
import { MODULES } from "./modules.tsx";

export function AdminApp({ path }: { path: string }) {
  const [me, setMe] = useState<StaffMe | null | undefined>(undefined);

  useEffect(() => {
    staffApi.me().then(setMe, () => setMe(null));
  }, []);

  if (me === undefined) return <div className="admin-loading muted">Загрузка…</div>;
  if (me === null) return (
    <div className="admin">
      <header className="admin-top">
        <span className="brand"><span className="plate">BC</span> Панель Brookclean</span>
        {DEMO && <a className="top-link" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>Сайт клиента</a>}
      </header>
      <Login onDone={setMe} />
    </div>
  );

  const allowed = MODULES.filter((m) => me.perms.includes(m.perm));
  const slug = path.split("?")[0].split("/")[2] ?? "";
  const current = allowed.find((m) => m.id === slug) ?? allowed[0];
  const Screen = current?.component;

  return (
    <div className="admin">
      <header className="admin-top">
        <a className="brand" href="/admin" onClick={(e) => { e.preventDefault(); navigate("/admin"); }}>
          <span className="plate">BC</span> Панель Brookclean
        </a>
        <div className="admin-user">
          {DEMO && <a className="top-link" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>Сайт клиента</a>}
          <span>{me.name} · <span className="muted-inv">{ROLES[me.role].name}</span></span>
          <button className="btn sm ghost-inv" onClick={async () => { await staffApi.logout(); setMe(null); }}>Выйти</button>
        </div>
      </header>
      <nav className="admin-nav" aria-label="Разделы">
        {allowed.map((m) => (
          <a key={m.id} href={`/admin/${m.id}`} aria-current={m === current ? "page" : undefined}
            onClick={(e) => { e.preventDefault(); navigate(`/admin/${m.id}`); }}>
            {m.title}
          </a>
        ))}
      </nav>
      <main className="admin-main">
        {Screen ? <Screen me={me} /> : <p className="muted">Для вашей роли разделов пока нет.</p>}
      </main>
    </div>
  );
}

const DEMO_USERS = [
  { login: "owner", label: "Владелец" },
  { login: "manager", label: "Менеджер" },
  { login: "accountant", label: "Бухгалтер" },
  { login: "acceptor", label: "Приёмщик" },
];

function Login({ onDone }: { onDone: (me: StaffMe) => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(l = login, p = password) {
    setBusy(true);
    setError("");
    try {
      onDone(await staffApi.login(l, p));
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col admin-login">
      <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>Вход для сотрудников</h2>
        <div className="field">
          <label htmlFor="login">Логин</label>
          <input id="login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Пароль</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="callout warn" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy || !login || !password}>Войти</button>
        <p className="small muted">Доступ выдаёт владелец в разделе «Сотрудники».</p>
      </form>
      {DEMO && (
        <section className="card demo-panel">
          <div className="eyebrow">Демо · войти как</div>
          <div className="row2">
            {DEMO_USERS.map((u) => (
              <button key={u.login} className="btn ghost" onClick={() => submit(u.login, "demo")}>{u.label}</button>
            ))}
          </div>
          <p className="small muted">У каждой роли свой набор разделов и полей.</p>
        </section>
      )}
    </div>
  );
}
