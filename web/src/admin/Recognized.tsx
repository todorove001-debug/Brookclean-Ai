import { useState, type ReactNode } from "react";
import { checkDocument, checkReceipt, hasErrors, isDocKind, type CheckLevel, type FieldCheck, type RecognizeResult } from "@brookclean/shared";

/** Фото с телефона → JPEG не больше 2400 px по длинной стороне: QR-код чека ещё читается, а запрос лёгкий. */
export async function photoToJpeg(file: File, maxSide = 2400): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.9);
}

const RANK: Record<CheckLevel, number> = { ok: 0, warn: 1, error: 2 };
const PILL: Record<CheckLevel, string> = { ok: "ok", warn: "warn", error: "err" };

/**
 * Проверки для текущих значений. Поле, которое человек исправил, проверяется заново здесь;
 * у нетронутого остаются проверки сервера (второе прочтение, нижняя строка паспорта, QR-код).
 */
export function currentChecks(r: RecognizeResult, values: Record<string, string>, edited: Set<string>): FieldCheck[] {
  const copy = { ...values };
  const local = r.kind === "receipt" ? checkReceipt(copy, new Date(), (r.fromQr ?? []).filter((k) => !edited.has(k)))
    : isDocKind(r.kind) ? checkDocument(r.kind, copy) : [];
  return [
    ...r.checks.filter((c) => !edited.has(c.field)),
    ...local.filter((c) => edited.has(c.field) || !r.checks.some((s) => s.field === c.field)),
  ];
}

/**
 * Поля, прочитанные с фото, рядом с самим фото. Ошибки подсвечены и не дают сохранить;
 * сохранить можно только после отметки «Сверил с фото».
 */
export function RecognizedFields({ r, photo, fields, values, onChange, onConfirm, onCancel, confirmLabel, extra }: {
  r: RecognizeResult | null;
  photo: string;
  fields: ReadonlyArray<readonly [string, string]>;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
  extra?: ReactNode;
}) {
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState(false);
  const checks = r ? currentChecks(r, values, edited) : [];
  const forField = (k: string) => checks.filter((c) => c.field === k).sort((a, b) => RANK[b.level] - RANK[a.level]);
  const set = (k: string, v: string) => { setEdited((s) => new Set(s).add(k)); setChecked(false); onChange(k, v); };
  const blocked = hasErrors(checks);
  const other = checks.filter((c) => !fields.some(([k]) => k === c.field) && c.level !== "ok");

  return (
    <div className="recognized">
      <div className="recognized-photo"><img src={photo} alt="Фото, с которого прочитаны поля" /></div>
      <div className="stack">
        {r && <p className="small muted">Прочитано за {(r.ms / 1000).toFixed(0)} с. ИИ ошибается в отдельных цифрах: сверьте каждое поле с фото.</p>}
        {other.map((c, i) => <div key={i} className="callout warn">{c.msg}</div>)}
        <div className="grid4">
          {fields.map(([k, label]) => {
            const cs = forField(k);
            const worst = cs[0]?.level;
            return (
              <div key={k} className={`field${worst === "error" ? " bad" : ""}`}>
                <label htmlFor={`rf-${k}`}>{label} {worst && <span className={`pill ${PILL[worst]}`}>{worst === "ok" ? "✓" : worst === "warn" ? "сверьте" : "ошибка"}</span>}</label>
                <input id={`rf-${k}`} value={values[k] ?? ""} onChange={(e) => set(k, e.target.value)} />
                {cs.filter((c) => c.level !== "ok" || cs.length === 1).slice(0, 2).map((c, i) => (
                  <span key={i} className={c.level === "error" ? "err" : "hint"}>
                    {c.msg}
                    {c.suggest && c.suggest !== values[k] && <> <button type="button" className="linkbtn" onClick={() => set(k, c.suggest!)}>Подставить {c.suggest}</button></>}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        {extra}
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>Сверил поля с фото, данные верные</span>
        </label>
        {blocked && <p className="small err">Исправьте поля с ошибкой, потом подтвердите.</p>}
        <div className="inline">
          <button className="btn sm primary" disabled={blocked || !checked} onClick={onConfirm}>{confirmLabel}</button>
          <button className="btn sm ghost" onClick={onCancel}>Отмена</button>
        </div>
      </div>
    </div>
  );
}
