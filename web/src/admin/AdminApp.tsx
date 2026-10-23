import { useEffect, useState } from "react";
import { ROLES, SITES, type Role, type StaffMe } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { DEMO, navigate } from "../router.ts";
import { staffApi } from "./api.ts";
import { visibleModules } from "./modules.tsx";

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

  const allowed = visibleModules(me);
  const slug = path.split("?")[0].split("/")[2] ?? "";
  // Приёмщик сразу попадает в свой кабинет: машины к приёмке или на перегрузку
  const home = me.role === "acceptor" ? allowed.find((m) => m.id === "acts") : undefined;
  const current = allowed.find((m) => m.id === slug) ?? home ?? allowed[0];
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
            {m.id === "trips" && me.role === "driver" ? "Мои рейсы" : m.id === "drivers" && me.role === "driver" ? "Моя карточка" : m.id === "acts" && me.site === "Новосибирск" ? "Терминал" : m.id === "acts" && me.role === "driver" ? "Погрузка и выдача" : m.title}
          </a>
        ))}
      </nav>
      <main className="admin-main">
        {Screen ? <Screen me={me} path={path} /> : <p className="muted">Для вашей роли разделов пока нет.</p>}
      </main>
    </div>
  );
}

const DEMO_USERS = [
  { login: "owner", label: "Владелец" },
  { login: "manager", label: "Менеджер" },
  { login: "accountant", label: "Бухгалтер" },
  { login: "acceptor", label: "Приёмщик · Владивосток" },
  { login: "terminal", label: "Приёмщик · терминал Новосибирск" },
  { login: "driver", label: "Водитель" },
  { login: "partner", label: "Партнёр" },
];

function Login({ onDone }: { onDone: (me: StaffMe) => void }) {
  const [reg, setReg] = useState(false);
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

  if (reg) return <div className="col admin-login"><Register onDone={(phone) => { setReg(false); setLogin(phone); }} onCancel={() => setReg(false)} /></div>;
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
        <p className="small muted">Доступ выдаёт владелец в разделе «Сотрудники». Водитель или приёмщик может{" "}
          <button type="button" className="linkbtn" onClick={() => setReg(true)}>зарегистрироваться сам</button>, менеджер подтвердит.</p>
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

/** Водитель или приёмщик заводит себе вход сам; войти можно после подтверждения менеджером. */
function Register({ onDone, onCancel }: { onDone: (phone: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: "", phone: "", password: "", role: "driver" as Role, site: "Владивосток" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    setError("");
    setErrors({});
    try {
      await staffApi.register({ ...f, site: f.role === "acceptor" ? f.site : undefined });
      setSent(true);
    } catch (e) {
      setError((e as ApiError).message);
      setErrors((e as ApiError).errors ?? {});
    } finally {
      setBusy(false);
    }
  }
  if (sent) return (
    <section className="card">
      <h2>Заявка отправлена</h2>
      <p>Менеджер проверит её и откроет доступ. После этого войдите по номеру телефона и паролю.</p>
      {DEMO && <p className="small muted">В демо войти можно после подтверждения в разделе «Водители» у менеджера, пароль: demo.</p>}
      <button className="btn primary" onClick={() => onDone(f.phone)}>Ко входу</button>
    </section>
  );
  const field = (k: "name" | "phone" | "password", label: string, attrs: Record<string, string> = {}) => (
    <div className={`field${errors[k] ? " bad" : ""}`}>
      <label htmlFor={`rg-${k}`}>{label}</label>
      <input id={`rg-${k}`} value={f[k]} onChange={set(k)} {...attrs} />
      {errors[k] && <span className="err">{errors[k]}</span>}
    </div>
  );
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2>Регистрация</h2>
      <div className="field"><label>Кто вы</label>
        <div className="seg" style={{ gridTemplateColumns: "1fr 1fr" }} role="group" aria-label="Роль">
          {(["driver", "acceptor"] as const).map((r) => (
            <button key={r} type="button" aria-pressed={f.role === r} onClick={() => setF((s) => ({ ...s, role: r }))}>{ROLES[r].name}</button>
          ))}
        </div>
      </div>
      {field("name", "ФИО полностью", { autoComplete: "name" })}
      {field("phone", "Телефон", { inputMode: "tel", autoComplete: "tel", placeholder: "+7 914 000 00 00" })}
      {field("password", "Пароль", { type: "password", autoComplete: "new-password" })}
      {f.role === "acceptor" && (
        <div className="field"><label htmlFor="rg-site">Площадка</label>
          <select id="rg-site" value={f.site} onChange={set("site")}>{SITES.map((s) => <option key={s}>{s}</option>)}</select></div>
      )}
      {error && <div className="callout warn" role="alert">{error}</div>}
      <button className="btn primary" disabled={busy}>Отправить заявку</button>
      <button type="button" className="btn ghost" onClick={onCancel}>Назад ко входу</button>
    </form>
  );
}
