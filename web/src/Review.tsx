import { useState } from "react";
import { GOOD_RATING, REVIEW_2GIS_URL } from "@brookclean/shared";
import { api, ApiError } from "./api.ts";

/**
 * Отзыв после получения автомобиля. Сохраняется у нас; клиенту с высокой оценкой
 * предлагаем продублировать его в 2ГИС (ссылка доступна при любой оценке).
 */
export function Review({ token, initial }: { token: string; initial: { rating: number; text: string } | null }) {
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [text, setText] = useState(initial?.text ?? "");
  const [sent, setSent] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api.review(token, rating, text);
      setSent({ rating, text });
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    const good = sent.rating >= GOOD_RATING;
    return (
      <section className="card" id="review">
        <span className="pill ok">Отзыв получен</span>
        {good ? (
          <>
            <h3>Спасибо за высокую оценку!</h3>
            <p className="small">
              Отзыв сохранён у нас. Если не трудно, опубликуйте его и в 2ГИС: так нас найдут другие клиенты.
              Текст можно скопировать и вставить.
            </p>
            {sent.text && (
              <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(sent.text).then(() => setCopied(true), () => {})}>
                {copied ? "Текст скопирован" : "Скопировать текст отзыва"}
              </button>
            )}
            <a className="btn primary" href={REVIEW_2GIS_URL} target="_blank" rel="noopener">Оставить отзыв в 2ГИС</a>
          </>
        ) : (
          <>
            <h3>Спасибо, что рассказали</h3>
            <p className="small">
              Ваш отзыв передан руководителю Brookclean Trucks. Мы разберёмся и свяжемся с вами по телефону.
            </p>
            <p className="small muted">
              Отзыв не публикуется автоматически. Публично оставить его можно в <a href={REVIEW_2GIS_URL} target="_blank" rel="noopener">2ГИС</a>.
            </p>
          </>
        )}
        <button className="linkbtn" onClick={() => setSent(null)}>Изменить отзыв</button>
      </section>
    );
  }

  return (
    <section className="card" id="review">
      <h3>Как прошла доставка?</h3>
      <div className="stars" role="radiogroup" aria-label="Оценка">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} из 5`}
            className={n <= rating ? "on" : ""} onClick={() => setRating(n)}>★</button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="review-text">Отзыв</label>
        <textarea id="review-text" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Что понравилось, что улучшить" />
      </div>
      {error && <div className="callout warn" role="alert">{error}</div>}
      <button className="btn primary" disabled={!rating || busy} onClick={submit}>{busy ? "Отправляем…" : "Отправить отзыв"}</button>
    </section>
  );
}
