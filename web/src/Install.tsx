import { useEffect, useState } from "react";
import { load, save } from "./storage.ts";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const standalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/**
 * «Как приложение»: на Android браузер сам предлагает установку (beforeinstallprompt),
 * на iPhone такой кнопки нет — показываем подсказку «Поделиться → На экран «Домой»».
 */
export function InstallBanner() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(() => standalone() || load("install", { dismissed: false }).dismissed);

  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    addEventListener("beforeinstallprompt", on);
    return () => removeEventListener("beforeinstallprompt", on);
  }, []);

  if (hidden || (!evt && !isIos())) return null;
  const close = () => {
    save("install", { dismissed: true });
    setHidden(true);
  };
  return (
    <aside className="install" role="dialog" aria-label="Установить на телефон">
      <img src="/icons/icon-192.png" alt="" width={40} height={40} />
      <div className="install-text">
        <b>Значок на экран телефона</b>
        {evt ? (
          <span>Трекинг автовоза будет открываться в одно касание</span>
        ) : (
          <span>Нажмите «Поделиться» <ShareIcon /> внизу Safari, затем «На экран „Домой“»</span>
        )}
      </div>
      {evt && (
        <button className="btn sm primary" onClick={async () => { await evt.prompt(); setEvt(null); close(); }}>
          Установить
        </button>
      )}
      <button className="install-x" aria-label="Закрыть" onClick={close}>×</button>
    </aside>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="значок «Поделиться»" style={{ verticalAlign: "-2px" }}>
      <path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8" />
    </svg>
  );
}
