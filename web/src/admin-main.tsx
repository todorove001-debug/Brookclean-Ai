import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./admin/AdminApp.tsx";
import { currentPath } from "./router.ts";
import "./styles.css";

// Отдельная точка входа панели сотрудников (staff.<домен>), без кода сайта клиента и без service worker
function Root() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return <AdminApp path={path} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
