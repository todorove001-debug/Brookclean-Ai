import { useEffect, useRef } from "react";

// Яндекс SmartCaptcha. Сервер просит её только при подозрительной активности (много входов с одного адреса).
declare global {
  interface Window {
    smartCaptcha?: {
      render: (el: HTMLElement, o: { sitekey: string; hl?: string; callback: (token: string) => void }) => number;
      destroy: (id: number) => void;
    };
  }
}

let loading: Promise<void> | undefined;
function loadScript() {
  loading ??= new Promise<void>((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://smartcaptcha.yandexcloud.net/captcha.js?render=onload";
    s.async = true;
    s.onload = () => ok();
    s.onerror = () => {
      loading = undefined;
      fail(new Error("captcha"));
    };
    document.head.append(s);
  });
  return loading;
}

export function Captcha({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    let id: number | undefined;
    let alive = true;
    loadScript().then(() => {
      if (alive && box.current && window.smartCaptcha)
        id = window.smartCaptcha.render(box.current, { sitekey: siteKey, hl: "ru", callback: (t) => cb.current(t) });
    }, () => {});
    return () => {
      alive = false;
      if (id !== undefined) window.smartCaptcha?.destroy(id);
    };
  }, [siteKey]);

  return <div ref={box} className="captcha" />;
}
