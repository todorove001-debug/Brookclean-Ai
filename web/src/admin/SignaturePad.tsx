import { useEffect, useRef, useState } from "react";

/** Подпись пальцем на экране телефона. Отдаёт PNG; пустую подпись отправить нельзя. */
export function SignaturePad({ label, onSign, busy }: { label: string; onSign: (png: string) => void; busy?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const pen = useRef<{ g: CanvasRenderingContext2D; r: DOMRect } | null>(null);

  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    g.lineWidth = 3;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#1d3fa0";
  }, []);

  const at = (e: React.PointerEvent, r: DOMRect) => {
    const c = ref.current!;
    return [((e.clientX - r.left) * c.width) / r.width, ((e.clientY - r.top) * c.height) / r.height] as const;
  };

  return (
    <div className="sigpad">
      <canvas
        ref={ref} width={600} height={200} aria-label={`Поле для подписи: ${label}`}
        onPointerDown={(e) => {
          e.preventDefault();
          const c = ref.current!;
          c.setPointerCapture(e.pointerId);
          const r = c.getBoundingClientRect(), g = c.getContext("2d")!;
          g.beginPath();
          g.moveTo(...at(e, r));
          pen.current = { g, r };
        }}
        onPointerMove={(e) => {
          if (!pen.current) return;
          pen.current.g.lineTo(...at(e, pen.current.r));
          pen.current.g.stroke();
          setDrawn(true);
        }}
        onPointerUp={() => (pen.current = null)}
        onPointerCancel={() => (pen.current = null)}
      />
      <div className="inline">
        <button type="button" className="btn sm dark" disabled={!drawn || busy} onClick={() => onSign(ref.current!.toDataURL("image/png"))}>Подписать</button>
        <button type="button" className="linkbtn" onClick={() => {
          const c = ref.current!;
          c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
          setDrawn(false);
        }}>Очистить</button>
      </div>
      <small className="muted">{label}: распишитесь пальцем в рамке</small>
    </div>
  );
}
