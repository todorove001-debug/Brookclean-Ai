import { useEffect, useState } from "react";
import { GOOD_RATING } from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { staffApi, type ReviewRow } from "./api.ts";

export function ReviewsScreen() {
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    staffApi.reviews().then(setRows, (e: ApiError) => setError(e.message));
  }, []);
  if (!rows) return <p className="muted">{error || "Загружаем…"}</p>;
  if (!rows.length) return <p className="muted">Отзывов пока нет. Форма появляется у клиента после получения автомобиля.</p>;
  return (
    <div className="stack">
      <p className="small muted">Сначала низкие оценки: с этими клиентами нужно связаться. Клиентам с оценкой {GOOD_RATING}–5 сайт предлагает продублировать отзыв в 2ГИС.</p>
      {rows.map((r) => (
        <section key={r.no} className={`card ${r.rating < GOOD_RATING ? "attention" : ""}`}>
          <div className="row-between">
            <b>Договор №{r.no} · {r.client}</b>
            <span className="stars-sm" aria-label={`${r.rating} из 5`}>{"★".repeat(r.rating)}<span className="muted">{"★".repeat(5 - r.rating)}</span></span>
          </div>
          {r.text && <p>{r.text}</p>}
          <p className="small muted">{r.phone} · {new Date(r.createdAt).toLocaleString("ru-RU")}</p>
        </section>
      ))}
    </div>
  );
}
