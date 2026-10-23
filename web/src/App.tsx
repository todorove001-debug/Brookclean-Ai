import { lazy, Suspense, useEffect, useState } from "react";
import { Checkout } from "./Checkout.tsx";
import { Track } from "./Track.tsx";
import { InstallBanner } from "./Install.tsx";
import { myOrders } from "./storage.ts";
import { DEMO, currentPath, navigate } from "./router.ts";
import { SignOrder } from "./SignOrder.tsx";

// Панель сотрудников собирается отдельно (admin.html) и в код сайта клиента не входит. Исключение — демо-страница.
const AdminApp = DEMO ? lazy(() => import("./admin/AdminApp.tsx").then((m) => ({ default: m.AdminApp }))) : null;

export { navigate };

function usePath() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  const track = /^\/t\/([\w-]+)/.exec(path);
  const sign = /^\/o\/([\w-]+)/.exec(path);
  if (AdminApp && path.startsWith("/admin")) {
    return <Suspense fallback={<div className="admin-loading muted">Загрузка…</div>}><AdminApp path={path} /></Suspense>;
  }
  return (
    <>
      <header className="top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          <span className="plate">ВЛ → РФ</span> Brookclean · Автовоз
        </a>
        {DEMO && <a className="top-link" href="/admin" onClick={(e) => { e.preventDefault(); navigate("/admin"); }}>Панель сотрудников</a>}
        {!DEMO && myOrders().length > 0 && !track && (
          <a className="top-link" href="/my" onClick={(e) => { e.preventDefault(); navigate("/my"); }}>Мои доставки</a>
        )}
      </header>
      <main className="col">
        {DEMO && (
          <p className="demo-note">
            <b>Демо-версия.</b> Сервер и SMS имитируются: код для подписи показан на экране, никуда ничего не отправляется.
          </p>
        )}
        {track ? <Track token={track[1]} /> : sign ? <SignOrder id={sign[1]} /> : path.startsWith("/my") ? <MyOrders /> : <Checkout key={path} />}
      </main>
      {!DEMO && <InstallBanner />}
    </>
  );
}

function MyOrders() {
  const list = myOrders();
  return (
    <div className="card">
      <h2>Мои доставки</h2>
      {list.length === 0 && <p className="muted">На этом устройстве пока нет оформленных заказов.</p>}
      <ul className="plist">
        {list.map((o) => (
          <li key={o.id}>
            <a href={`/t/${o.trackToken}`} onClick={(e) => { e.preventDefault(); navigate(`/t/${o.trackToken}`); }}>
              Договор №{o.no} · {o.car} → {o.city}
            </a>
          </li>
        ))}
      </ul>
      <button className="btn ghost" onClick={() => navigate("/")}>Оформить ещё автомобиль</button>
    </div>
  );
}
