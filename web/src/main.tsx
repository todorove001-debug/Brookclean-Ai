import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

if (import.meta.env.VITE_DEMO !== "1") import("virtual:pwa-register").then((m) => m.registerSW({ immediate: true }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
