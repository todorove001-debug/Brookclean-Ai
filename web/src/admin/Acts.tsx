import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CONDITIONS, DMG_CODES, PHOTO_GROUPS, PHOTO_SLOTS, PTS_TYPES, STAGES, VIDEO_SLOTS, can, isStage, slotLabel,
  type ActMark, type ActMedia, type ActRow, type ActSuggestion, type ActView, type Condition, type DmgCode, type StageId, type StaffMe,
} from "@brookclean/shared";
import { ApiError, call } from "../api.ts";
import { DEMO, navigate } from "../router.ts";
import { staffApi, type ActPatch } from "./api.ts";
import { uploadSlot } from "./actMedia.ts";
import { SignaturePad } from "./SignaturePad.tsx";
import diagram from "../assets/car-diagram.jpg";

const CODES = Object.keys(DMG_CODES) as DmgCode[];
/** Находки ИИ на схеме — этим цветом, пока приёмщик не решил. Подтверждённые — цветом передачи. */
const AI_COLOR = "#e11d48";
const fmt = (iso: string) => new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Vladivostok", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const stageNo = (a: ActView, st: StageId) => a.sections.findIndex((s) => s.stage === st) + 1;

export function ActsScreen({ me, path }: { me: StaffMe; path: string }) {
  const [, , , no, stage] = path.split("?")[0].split("/");
  if (no && isStage(stage)) return <ActScreen me={me} no={Number(no)} stage={stage} />;
  return <ActList me={me} />;
}

// --- Списки приёмщика ---

const GROUPS: Record<ActRow["group"], string> = {
  todo: "К приёмке",
  incoming: "Прибывают на перегрузку · Новосибирск",
  yard: "На площадке терминала · ждут погрузки",
  done: "Оформлены",
};

function ActList({ me }: { me: StaffMe }) {
  const [rows, setRows] = useState<ActRow[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { staffApi.acts().then(setRows, (e: ApiError) => setError(e.message)); }, []);
  if (!rows) return <p className="muted">{error || "Загружаем машины…"}</p>;

  const s = q.toLowerCase();
  const shown = rows.filter((r) => !s || [r.no, r.car, r.vin, r.client, r.city].some((v) => String(v).toLowerCase().includes(s)));
  const groups = (Object.keys(GROUPS) as Array<ActRow["group"]>).map((g) => [g, shown.filter((r) => r.group === g)] as const).filter(([g, l]) => l.length || g !== "done");

  return (
    <div className="stack">
      <div className="row-between">
        <h2>{me.site === "Новосибирск" ? "Терминал Новосибирск" : me.site ? `Приёмка · ${me.site}` : "Приёмка и перегруз"}</h2>
        <div className="inline" style={{ maxWidth: 320 }}><input placeholder="Номер, авто, VIN, клиент" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" /></div>
      </div>
      {groups.filter(([g, l]) => l.length || (g === "todo" && me.site !== "Новосибирск") || ((g === "incoming" || g === "yard") && me.site === "Новосибирск")).map(([g, list]) => (
        <section key={g} className="card">
          <h3>{GROUPS[g]} · {list.length}</h3>
          {!list.length && <p className="muted small">{g === "incoming" ? "Сейчас никто не едет на перегрузку." : g === "yard" ? "Площадка пуста." : "Новых машин нет."}</p>}
          {g === "incoming" && <IncomingTrips list={list} />}
          <div className="actlist">
            {list.map((r) => <ActRowCard key={`${r.no}-${r.stage}`} r={r} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Кто едет на терминал: рейс, водитель с телефоном, тягач, прицеп, перевозчик и сколько машин везёт. */
function IncomingTrips({ list }: { list: ActRow[] }) {
  const trips = [...new Map(list.filter((r) => r.trip).map((r) => [r.trip!.id, r.trip!])).values()];
  if (!trips.length) return null;
  return (
    <div className="stack" style={{ gap: 8, marginBottom: 10 }}>
      {trips.map((t) => (
        <div key={t.id} className="callout info">
          <b>Рейс {t.id}</b> · {list.filter((r) => r.trip?.id === t.id).length} авто · {t.kmLeft ? `${t.kmLeft.toLocaleString("ru-RU")} км до терминала` : "на терминале"}
          <br />Водитель: <b>{t.driver || "не назначен"}</b>{t.phone && <> · <a href={`tel:${t.phone}`}>{t.phone}</a></>}
          <br />Тягач: {t.truck || "—"}{t.trailer && <> · прицеп {t.trailer}</>}{t.carrier && <> · перевозчик {t.carrier}</>}
        </div>
      ))}
    </div>
  );
}

function ActRowCard({ r }: { r: ActRow }) {
  const open = () => navigate(`/admin/acts/${r.no}/${r.stage}`);
  const here = r.trip && r.trip.kmLeft === 0;
  return (
    <div className="actrow">
      <div className="stack" style={{ gap: 2 }}>
        <div><b>№{r.no} · {r.car}</b> {r.year}, {r.color}</div>
        <small className="muted"><span className="mono">{r.vin}</span> · {r.client} · в {r.city}</small>
        {r.group === "incoming" && <small className="muted">{r.trip ? `Рейс ${r.trip.id} · ${r.trip.truck} · ${r.trip.driver || "водитель не назначен"}` : "Рейс до терминала не назначен"}</small>}
        {r.note && <small>Примечание: {r.note}</small>}
        {r.group === "yard" && <small className="muted">{r.trip2 ? `Дальше рейсом ${r.trip2.id} · ${r.trip2.driver || "водитель не назначен"}` : "Рейс дальше не назначен: его ставит менеджер"}</small>}
      </div>
      <div className="actrow-side">
        <span className="pill gray">{STAGES[r.stage].name}</span>
        {r.group === "incoming" && r.trip && <span className={`pill ${here ? "warn" : "gray"}`}>{here ? "на терминале" : `${r.trip.kmLeft.toLocaleString("ru-RU")} км`}</span>}
        {r.closedAt ? <span className="pill ok">подписан {fmt(r.closedAt)}</span> : (
          <>
            {r.orderStatus === "draft" && <span className="pill warn">договор не подписан</span>}
            {(r.photos > 0 || r.videos > 0) && <small className="muted">фото {r.photos}/{PHOTO_SLOTS.length} · видео {r.videos}/{VIDEO_SLOTS.length}</small>}
            {r.pending > 0 && <span className="pill ai">ИИ: {r.pending} на проверку</span>}
          </>
        )}
        <button className={`btn sm ${r.closedAt ? "ghost" : "primary"}`} onClick={open}>{r.closedAt ? "Акт" : r.group === "incoming" ? "Принять" : r.group === "yard" ? "Погрузить" : "Открыть"}</button>
      </div>
    </div>
  );
}

// --- Раздел акта: одна передача машины ---

function ActScreen({ me, no, stage }: { me: StaffMe; no: number; stage: StageId }) {
  const [a, setA] = useState<ActView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const prev = useRef<ActView | null>(null);

  const accept = (v: ActView) => {
    const p = prev.current;
    if (p && !v.closedAt && ((p.give && !v.give) || (p.take && !v.take))) setNotice("Акт изменён после подписи: подписи сброшены, подпишите заново");
    prev.current = v;
    setA(v);
  };
  useEffect(() => { staffApi.act(no, stage).then(accept, (e: ApiError) => setError(e.message)); }, [no, stage]);

  // Пока ИИ проверяет фото, обновляем раздел: находки появятся сами
  const checking = !!a?.media.some((m) => m.ai?.status === "checking");
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(() => staffApi.act(no, stage).then(accept, () => {}), 3000);
    return () => clearInterval(t);
  }, [checking, no, stage]);

  async function run(f: () => Promise<ActView>) {
    setError("");
    setBusy(true);
    try {
      accept(await f());
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (!a) return <p className="muted">{error || "Загружаем акт…"}</p>;
  const gate = a.blockers.find((b) => b.startsWith("Сначала закройте"));
  const edit = can(me.role, "acts.edit") && !a.closedAt && (!me.site || me.site === STAGES[stage].site) && !gate;
  const manager = can(me.role, "acts.manage");
  const patch = (p: ActPatch) => run(() => staffApi.patchAct(no, stage, p));

  return (
    <div className="stack act">
      <a className="linkbtn" href="/admin/acts" onClick={(e) => { e.preventDefault(); navigate("/admin/acts"); }}>← Все машины</a>

      <section className="card actdoc">
        <div className="row-between">
          <div>
            <div className="eyebrow">Акт приёма-передачи · раздел {stageNo(a, stage)} из {a.sections.length}</div>
            <h2>{STAGES[stage].title}</h2>
            <div className="muted small">к договору № {a.no} от {a.contractDate.split("-").reverse().join(".")} · {STAGES[stage].site}</div>
          </div>
          {a.closedAt && <ActPdfButton a={a} />}
        </div>
        <div className="chainbar">
          {a.sections.map((s, i) => (
            <a key={s.stage} href={`/admin/acts/${no}/${s.stage}`} className={`chainstep${s.stage === stage ? " cur" : ""}${s.closedAt ? " done" : ""}`}
              style={{ ["--c" as string]: STAGES[s.stage].color }} onClick={(e) => { e.preventDefault(); navigate(`/admin/acts/${no}/${s.stage}`); }}>
              {i + 1} · {STAGES[s.stage].name}{s.closedAt ? " ✓" : ""}
            </a>
          ))}
        </div>
        <div className="transfer">
          <div><small className="muted">Сдаёт</small><b>{a.giveName || "—"}</b><small>{a.giveRole}</small></div>
          <span aria-hidden="true">→</span>
          <div><small className="muted">Принимает</small><b>{a.takeName || "—"}</b><small>{a.takeRole}</small></div>
        </div>
        <div className="small">
          <b>{a.car.car}</b> · <span className="mono">{a.car.vin}</span> · {a.car.year} · {a.car.color} · выдача в {a.car.city}
          {a.transfer && <> · <span className="pill warn">перегруз в {a.transfer}</span></>}
        </div>
        {a.note && <div className="callout info">Примечание к заявке: {a.note}</div>}
        {gate && <div className="callout warn">{gate}. Этот раздел можно посмотреть, но оформлять его пока нельзя.</div>}
        {!a.storage && <div className="callout warn">Хранилище фото (S3) не настроено на сервере: фото и видео загрузить нельзя.</div>}
      </section>

      {error && <div className="callout warn" role="alert">{error}</div>}
      {notice && <div className="callout warn" role="status">{notice} <button className="linkbtn" onClick={() => setNotice("")}>Понятно</button></div>}

      {DEMO && edit && a.media.length < PHOTO_SLOTS.length + VIDEO_SLOTS.length && (
        <div className="callout info demo-note">
          Демо: в браузере можно снять каждое фото по-настоящему или{" "}
          <button className="linkbtn" onClick={() => run(() => call<ActView>(`/api/staff/acts/${no}/${stage}/demo-fill`, { method: "POST" }))}>заполнить пустые ячейки примерами</button>.
          ИИ ответит заготовками через пару секунд.
        </div>
      )}

      <MediaSection a={a} edit={edit} setZoom={setZoom} onDone={accept} onError={setError}
        recheck={(slot) => run(() => staffApi.recheck(no, stage, slot))}
        remove={(slot) => run(() => staffApi.deleteMedia(no, stage, slot))} />

      <section className="card">
        <h3>Акт</h3>
        <p className="small">
          К договору № <b>{a.no}</b> от {a.contractDate.split("-").reverse().join(".")} · Заказчик: <b>{a.client}</b>
        </p>
        <p className="small muted">Легковой автомобиль, данные из заявки №{a.no}:</p>
        <div className="grid4">
          <Field label="Марка" value={a.car.car} edit={false} onSave={() => {}} />
          <Field label="VIN" value={a.car.vin} edit={false} onSave={() => {}} />
          <Field label="Год выпуска" value={a.car.year} edit={false} onSave={() => {}} />
          <Field label="Цвет" value={a.car.color} edit={false} onSave={() => {}} />
        </div>
        {stage === "priemka" ? (
          <>
            <div className="grid4">
              <Field label="Гос. номер" value={a.details.plate} edit={edit} onSave={(v) => patch({ details: { plate: v } })} />
              <div className="field">
                <label htmlFor="pts">ПТС</label>
                <select id="pts" value={a.details.ptsType} disabled={!edit} onChange={(e) => patch({ details: { ptsType: e.target.value } })}>
                  {PTS_TYPES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <Field label="№ ПТС / ЭПТС" value={a.details.ptsNo} edit={edit} onSave={(v) => patch({ details: { ptsNo: v } })} />
              <Field label="Ключей, шт." value={a.details.keys} edit={edit} numeric onSave={(v) => patch({ details: { keys: v } })} />
            </div>
            <Field label="Дополнительные документы" value={a.details.docs} edit={edit} onSave={(v) => patch({ details: { docs: v } })} />
          </>
        ) : (
          <p className="small muted">Гос. номер: {a.details.plate || "—"} · ПТС: {a.details.ptsType} {a.details.ptsNo} · ключей: {a.details.keys || "—"}{a.details.docs ? ` · ${a.details.docs}` : ""}</p>
        )}
        <p className="small">Проведена фото-видео съёмка: <b>{a.media.length ? "да" : "нет"}</b> · Внешний вид автомобиля: согласно схеме и фото-отчёту</p>
        <div className="field">
          <span className="label">Условия осмотра</span>
          <div className="checks">
            {(Object.keys(CONDITIONS) as Condition[]).map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={a.cond.includes(c)} disabled={!edit}
                  onChange={(e) => patch({ cond: e.target.checked ? [...a.cond, c] : a.cond.filter((x) => x !== c) })} /> {CONDITIONS[c]}
              </label>
            ))}
          </div>
          {a.cond.includes("other") && <Field label="Иное — что именно" value={a.condOther} edit={edit} onSave={(v) => patch({ condOther: v })} />}
        </div>
        {a.cond.length > 0 && <div className="callout warn">При наличии отметки в условиях осмотра тщательный осмотр ЛКП невозможен.</div>}
        <Field label="Дополнительные сведения" value={a.notes} edit={edit} multiline onSave={(v) => patch({ notes: v })} />
      </section>

      <DefectsSection a={a} stage={stage} edit={edit} manager={manager} me={me} busy={busy} setZoom={setZoom}
        decide={(id, state, code) => run(() => staffApi.decide(no, stage, id, state, code))}
        addMark={(code, part, x, y) => run(() => staffApi.addMark(no, stage, { code, part, x, y }))}
        refine={(id, code) => run(() => staffApi.patchMark(no, stage, id, { code }))}
        removeMark={(id, reason) => run(() => staffApi.removeMark(no, stage, id, reason))} />

      <SignSection a={a} edit={edit} busy={busy} patch={patch}
        sign={(who, img) => run(() => staffApi.sign(no, stage, who, img, navigator.userAgent.slice(0, 120)))} />

      {zoom && (
        <div className="lightbox" role="dialog" aria-label="Фото" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" />
          <button className="btn sm ghost-inv">Закрыть</button>
        </div>
      )}
    </div>
  );
}

/** Поле, которое сохраняется, когда приёмщик ушёл из него. */
function Field({ label, value, edit, onSave, numeric, multiline }: {
  label: string; value: string; edit: boolean; onSave: (v: string) => void; numeric?: boolean; multiline?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const id = useId();
  const save = () => v.trim() !== value && onSave(v.trim());
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {multiline
        ? <textarea id={id} rows={2} value={v} disabled={!edit} onChange={(e) => setV(e.target.value)} onBlur={save} />
        : <input id={id} value={v} disabled={!edit} inputMode={numeric ? "numeric" : undefined} onChange={(e) => setV(e.target.value)} onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />}
    </div>
  );
}

// --- Фото и видео ---

function MediaSection({ a, edit, setZoom, onDone, onError, recheck, remove }: {
  a: ActView; edit: boolean; setZoom: (u: string) => void; onDone: (v: ActView) => void; onError: (m: string) => void;
  recheck: (slot: string) => void; remove: (slot: string) => void;
}) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const bySlot = new Map(a.media.map((m) => [m.slot, m]));
  const photos = PHOTO_SLOTS.filter((s) => bySlot.has(s.id)).length;
  const videos = VIDEO_SLOTS.filter((s) => bySlot.has(s.id)).length;

  async function pick(slot: string, kind: "photo" | "video", file: File | undefined) {
    if (!file) return;
    onError("");
    setProgress((p) => ({ ...p, [slot]: 0 }));
    try {
      onDone(await uploadSlot(a.no, a.stage, slot, kind, file, (x) => setProgress((p) => ({ ...p, [slot]: x }))));
    } catch (e) {
      onError(`${slotLabel(slot)}: ${(e as ApiError).message}`);
    } finally {
      setProgress((p) => { const { [slot]: _, ...rest } = p; return rest; });
    }
  }

  const sugCount = (slot: string) => a.suggestions.filter((s) => s.slot === slot && s.state === "pending").length;
  const shoot = (slot: string, kind: "photo" | "video", text: ReactNode) => (
    <label className={`filebtn ${bySlot.has(slot) ? "linkbtn" : "shot-empty"}`}>
      {text}
      <input type="file" accept={kind === "photo" ? "image/*" : "video/*"} capture="environment" disabled={!edit || !a.storage || slot in progress}
        onChange={(e) => { pick(slot, kind, e.target.files?.[0]); e.target.value = ""; }} />
    </label>
  );

  return (
    <>
      <section className="card">
        <div className="row-between">
          <h3>Фото · {photos} из {PHOTO_SLOTS.length}</h3>
          <div className="progress" style={{ width: 140 }}><i style={{ width: `${(photos / PHOTO_SLOTS.length) * 100}%` }} /></div>
        </div>
        {a.ai ? <p className="small muted">Наружные фото проверяет ИИ: возможные повреждения появятся ниже, в «Дефектах», <span style={{ color: AI_COLOR, fontWeight: 600 }}>красным пунктиром</span>.{a.sections.length > 1 && a.stage !== "priemka" ? " На перегрузе ИИ сравнивает с тем же ракурсом прошлой передачи и ищет только новое." : ""}</p>
          : <p className="small muted">ИИ-проверка не настроена на сервере: осмотрите фото сами.</p>}
        {(Object.keys(PHOTO_GROUPS) as Array<keyof typeof PHOTO_GROUPS>).map((g) => (
          <div key={g} className="stack" style={{ gap: 6 }}>
            <div className="eyebrow">{PHOTO_GROUPS[g]}</div>
            <div className="shots">
              {PHOTO_SLOTS.filter((s) => s.group === g).map((s) => {
                const m = bySlot.get(s.id);
                const p = progress[s.id];
                return (
                  <div key={s.id} className={`shot${m ? " done" : ""}`}>
                    <small><b>{PHOTO_SLOTS.indexOf(s) + 1}.</b> {s.label}</small>
                    {p !== undefined ? <div className="shot-ph"><span className="spin" aria-hidden="true" /> {Math.round(p * 100)}%</div>
                      : m ? (m.url ? <button className="shot-img" onClick={() => setZoom(m.url)} aria-label={`Открыть фото: ${s.label}`}><img src={m.url} alt="" loading="lazy" /></button>
                        : <div className="shot-ph">✓ снято</div>)
                      : shoot(s.id, "photo", <span className="shot-ph">📷 Снять</span>)}
                    {m && <AiPill m={m} pending={sugCount(s.id)} retry={edit && a.ai ? () => recheck(s.id) : undefined} />}
                    {m && edit && p === undefined && shoot(s.id, "photo", "Переснять")}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="row-between">
          <h3>Видео · {videos} из {VIDEO_SLOTS.length}</h3>
          <div className="progress" style={{ width: 140 }}><i style={{ width: `${(videos / VIDEO_SLOTS.length) * 100}%` }} /></div>
        </div>
        <p className="small muted">Каждое видео не длиннее минуты. Снимайте медленно, при хорошем свете.</p>
        <div className="videos">
          {VIDEO_SLOTS.map((s) => {
            const m = bySlot.get(s.id);
            const p = progress[s.id];
            return (
              <div key={s.id} className={`shot${m ? " done" : ""}`}>
                <small><b>{s.label}</b><br /><span className="muted">{s.hint}</span></small>
                {p !== undefined ? <div className="progress"><i style={{ width: `${Math.round(p * 100)}%` }} /></div>
                  : m ? (m.url ? <video src={m.url} controls preload="metadata" playsInline /> : <div className="shot-ph">🎥 видео-пример</div>)
                  : shoot(s.id, "video", <span className="shot-ph">🎥 Снять видео</span>)}
                {m && <small className="muted">{m.durationSec ? `${Math.round(m.durationSec)} с · ` : ""}{(m.size / 1024 / 1024).toFixed(1)} МБ</small>}
                {m && edit && p === undefined && (
                  <div className="inline">
                    {shoot(s.id, "video", "Переснять")}
                    <button className="linkbtn" onClick={() => remove(s.id)}>Удалить</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function AiPill({ m, pending, retry }: { m: ActMedia; pending: number; retry?: () => void }) {
  if (!m.ai) return null;
  if (m.ai.status === "checking") return <span className="pill gray"><span className="spin" aria-hidden="true" /> ИИ смотрит…</span>;
  if (m.ai.status === "off") return null;
  if (m.ai.status === "error") return <span className="pill warn">ИИ не ответил {retry && <button className="linkbtn" onClick={retry}>ещё раз</button>}</span>;
  const q = m.ai.quality && m.ai.quality !== "ok" ? ({ blurry: "размыто, переснимите", dark: "темно, переснимите", partial: "машина не целиком" } as Record<string, string>)[m.ai.quality] : "";
  return (
    <>
      {q && <span className="pill warn">{q}</span>}
      {pending ? <span className="pill ai">ИИ: {pending} — проверьте</span> : <span className="pill ok">ИИ: не нашёл</span>}
    </>
  );
}

// --- Схема кузова и дефекты ---

function Diagram({ a, onPick, highlight }: { a: ActView; onPick?: (x: number, y: number) => void; highlight?: number | null }) {
  return (
    <div className={`diagram${onPick ? "" : " ro"}`} role="img" aria-label="Схема кузова с отметками дефектов"
      onClick={(e) => {
        if (!onPick) return;
        const r = e.currentTarget.getBoundingClientRect();
        onPick(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
      }}>
      <img src={diagram} alt="" draggable={false} />
      {a.marks.filter((m) => !m.removed).map((m) => (
        <span key={"m" + m.id} className="mark" title={`${DMG_CODES[m.code]}${m.part ? " · " + m.part : ""}`}
          style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, background: STAGES[m.stage].color }}>{m.code}</span>
      ))}
      {a.suggestions.filter((s) => s.state === "pending").map((s) => (
        <span key={"s" + s.id} className={`mark ai${highlight === s.id ? " hl" : ""}`} title={`ИИ: ${s.part}`}
          style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, borderColor: AI_COLOR, color: AI_COLOR }}>{s.code}?</span>
      ))}
    </div>
  );
}

function DefectsSection({ a, stage, edit, manager, me, busy, setZoom, decide, addMark, refine, removeMark }: {
  a: ActView; stage: StageId; edit: boolean; manager: boolean; me: StaffMe; busy: boolean; setZoom: (u: string) => void;
  decide: (id: number, state: "yes" | "no" | "pending", code?: string) => void;
  addMark: (code: DmgCode, part: string, x: number, y: number) => void;
  refine: (id: number, code: DmgCode) => void;
  removeMark: (id: number, reason: string) => void;
}) {
  const [code, setCode] = useState<DmgCode | null>(null);
  const [part, setPart] = useState("");
  const [hl, setHl] = useState<number | null>(null);
  const pending = a.suggestions.filter((s) => s.state === "pending");
  const decided = a.suggestions.filter((s) => s.state !== "pending");
  const urlOf = (slot: string) => a.media.find((m) => m.slot === slot)?.url;

  return (
    <section className="card">
      <h3>Схема и журнал дефектов</h3>
      <div className="inline small">
        {a.sections.map((s, i) => <span key={s.stage}><span className="stagedot" style={{ background: STAGES[s.stage].color }} />{i + 1} · {STAGES[s.stage].name}</span>)}
        <span><span className="stagedot ai" style={{ borderColor: AI_COLOR }} />находка ИИ, ждёт решения</span>
      </div>
      {edit && (
        <div className="stack" style={{ gap: 6 }}>
          <p className="small muted">{a.sections.length > 1 && stage !== "priemka" ? "Отметки с прошлых передач уже на схеме: проверьте машину по ним. " : ""}Новый дефект: выберите код, при желании напишите где, и нажмите на место на схеме.</p>
          <div className="codes">
            {CODES.map((c) => <button key={c} className="codebtn" aria-pressed={code === c} title={DMG_CODES[c]} onClick={() => setCode(code === c ? null : c)}>{c}</button>)}
          </div>
          {code && (
            <div className="inline">
              <span className="small"><b>{code}</b> {DMG_CODES[code]}</span>
              <input placeholder="Где: левая задняя дверь" value={part} onChange={(e) => setPart(e.target.value)} aria-label="Где дефект" />
            </div>
          )}
        </div>
      )}
      <Diagram a={a} highlight={hl} onPick={edit && code ? (x, y) => { addMark(code, part, x, y); setCode(null); setPart(""); } : undefined} />
      <details className="small"><summary className="muted">Коды оценки состояния кузова</summary>
        <div className="legend">{CODES.map((c) => <div key={c}><b>{c}</b> {DMG_CODES[c]}</div>)}</div>
      </details>

      {pending.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="callout ai">ИИ нашёл возможные повреждения: {pending.length}. Посмотрите фото и решите по каждому. Пока есть нерешённые, акт не подписать.</div>
          {pending.map((s) => <SuggestionCard key={s.id} s={s} url={urlOf(s.slot)} edit={edit} busy={busy} setZoom={setZoom} decide={decide} onHover={setHl} />)}
        </div>
      )}

      <div className="deflist">
        {a.marks.length === 0 && <p className="muted small">Дефектов не отмечено.</p>}
        {a.marks.map((m) => <MarkCard key={m.id} a={a} m={m} stage={stage} edit={edit} manager={manager && !!a.closedAt} me={me} refine={refine} removeMark={removeMark} />)}
      </div>

      {decided.length > 0 && (
        <details className="small"><summary className="muted">Решения по находкам ИИ · {decided.length}</summary>
          <ul className="hist">
            {decided.map((s) => (
              <li key={s.id}>
                {s.state === "yes" ? "Согласен" : "Нет повреждения"}: {s.code} {s.part} ({slotLabel(s.slot)}) · {s.by}, {s.at && fmt(s.at)}
                {edit && <> · <button className="linkbtn" onClick={() => decide(s.id, "pending")}>изменить</button></>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SuggestionCard({ s, url, edit, busy, setZoom, decide, onHover }: {
  s: ActSuggestion; url?: string; edit: boolean; busy: boolean; setZoom: (u: string) => void;
  decide: (id: number, state: "yes" | "no" | "pending", code?: string) => void; onHover: (id: number | null) => void;
}) {
  const [code, setCode] = useState<DmgCode>(s.code);
  return (
    <div className="aiitem" onMouseEnter={() => onHover(s.id)} onMouseLeave={() => onHover(null)}>
      {url && <button className="shot-img sm" onClick={() => setZoom(url)} aria-label="Открыть фото"><img src={url} alt="" /></button>}
      <div className="stack" style={{ gap: 4 }}>
        <div><span className="pill ai">ИИ</span> <b>{s.part}</b> <span className="muted small">· {slotLabel(s.slot)}</span></div>
        <small>{s.desc} · уверенность {({ high: "высокая", medium: "средняя", low: "низкая" })[s.confidence]}</small>
        {edit && (
          <div className="inline">
            <select value={code} onChange={(e) => setCode(e.target.value as DmgCode)} aria-label="Код дефекта">
              {CODES.map((c) => <option key={c} value={c}>{c} · {DMG_CODES[c]}</option>)}
            </select>
            <button className="btn sm primary" disabled={busy} onClick={() => decide(s.id, "yes", code)}>Согласен</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => decide(s.id, "no")}>Нет повреждения</button>
          </div>
        )}
      </div>
    </div>
  );
}

function MarkCard({ a, m, stage, edit, manager, me, refine, removeMark }: {
  a: ActView; m: ActMark; stage: StageId; edit: boolean; manager: boolean; me: StaffMe;
  refine: (id: number, code: DmgCode) => void; removeMark: (id: number, reason: string) => void;
}) {
  const [rm, setRm] = useState(false);
  const [reason, setReason] = useState("");
  const f = m.history[0];
  const n = stageNo(a, m.stage);
  const canRemove = !m.removed && ((edit && can(me.role, "acts.edit")) || manager);
  return (
    <div className={`defitem${m.removed ? " removed" : ""}`}>
      <div className="inline" style={{ gap: 6 }}>
        <span className="mk" style={{ background: STAGES[m.stage].color }}>{m.code}</span>
        <b>{DMG_CODES[m.code]}</b>
        <span className="muted">{m.part || "отмечено на схеме"}</span>
        {m.removed ? <span className="pill gray">снята</span> : m.stage === stage ? <span className="pill warn">новое на этой передаче</span> : <span className="pill gray">с передачи {n}</span>}
        {m.src === "ai" && <span className="pill ai">по находке ИИ</span>}
      </div>
      <small className="muted">Впервые: {n} · {STAGES[m.stage].name}, {f.who}, {fmt(f.at)}{m.history.length > 1 ? ` · изменений: ${m.history.length - 1}` : ""}</small>
      {m.history.length > 1 && (
        <details><summary className="muted small">История отметки</summary>
          <ul className="hist">{m.history.map((h, i) => (
            <li key={i}><span className="stagedot" style={{ background: STAGES[h.stage].color }} />{STAGES[h.stage].name} · {h.who} <small className="muted">({h.role})</small> · {fmt(h.at)} —{" "}
              {h.act === "add" ? `добавил${h.src === "ai" ? " по находке ИИ" : ""} ${h.code}` : h.act === "refine" ? `уточнил: ${h.from} → ${h.to}` : `снял отметку${h.manager ? " после подписей (менеджер)" : ""}: «${h.reason}»`}</li>
          ))}</ul>
        </details>
      )}
      {(edit && !m.removed) || canRemove ? (
        <div className="inline" style={{ gap: 6 }}>
          {edit && !m.removed && (
            <select value={m.code} onChange={(e) => refine(m.id, e.target.value as DmgCode)} aria-label="Уточнить код" style={{ flex: "0 0 auto", minWidth: 70 }}>
              {CODES.map((c) => <option key={c}>{c}</option>)}
            </select>
          )}
          {canRemove && (rm
            ? <>
                <input placeholder={manager ? "Комментарий менеджера — обязательно" : "Причина: ошибочная отметка…"} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Причина" />
                <button className="btn sm dark" disabled={!reason.trim()} onClick={() => removeMark(m.id, reason)}>Снять</button>
              </>
            : <button className="linkbtn" onClick={() => setRm(true)}>{manager ? "Снять отметку (менеджер)" : "Снять как ошибочную"}</button>)}
        </div>
      ) : null}
    </div>
  );
}

// --- Подписи ---

function SignSection({ a, edit, busy, patch, sign }: {
  a: ActView; edit: boolean; busy: boolean; patch: (p: ActPatch) => void; sign: (who: "give" | "take", img: string) => void;
}) {
  const blocked = a.blockers.length > 0;
  const sigBlock = (k: "give" | "take") => {
    const sig = a[k];
    const name = k === "give" ? a.giveName : a.takeName;
    const role = k === "give" ? a.giveRole : a.takeRole;
    const enabled = edit && !blocked && (k === "give" ? !a.absent : !!a.give || (a.absent && !!a.absentReason.trim()));
    return (
      <div className="field sigbox">
        <span className="label">{k === "give" ? "Сдал" : "Принял"} — {role}</span>
        {sig ? (
          <>
            <img src={sig.img} alt="Подпись" className="sigimg" />
            <small><b>{sig.name}</b> · {fmt(sig.at)} · подпись на экране, телефон: {sig.by}</small>
            {k === "give" && a.disagree && <div className="callout warn">Не согласен с отметками: {a.disComment}</div>}
          </>
        ) : k === "give" && a.absent ? (
          <div className="callout warn">Сдающая сторона не подписала: {a.absentReason || "причина не указана"}</div>
        ) : enabled ? (
          <SignaturePad label={name || role} busy={busy} onSign={(img) => sign(k, img)} />
        ) : (
          <div className="sig-ph">{blocked ? "Сначала заполните акт" : k === "take" ? "Сначала подпись сдающей стороны" : "—"}</div>
        )}
      </div>
    );
  };

  return (
    <section className="card">
      <h3>Подписи</h3>
      {a.closedAt ? (
        <div className="callout ok">Раздел подписан и закрыт {fmt(a.closedAt)}. С этого момента за машину отвечает: <b>{a.takeName}</b> ({a.takeRole}).</div>
      ) : blocked ? (
        <div className="callout warn"><b>Перед подписью:</b><ul>{a.blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>
      ) : edit ? (
        <p className="small muted">Порядок: сдающий проверяет акт и подписывает «Сдал», потом принимающий подписывает «Принял», и раздел закрывается. Изменение после подписи сбрасывает подписи.</p>
      ) : null}
      {edit && !a.give && (
        <div className="row2">
          <NameField label="Сдаёт (ФИО)" value={a.giveName} onSave={(v) => patch({ giveName: v })} />
          <NameField label="Принимает (ФИО)" value={a.takeName} onSave={(v) => patch({ takeName: v })} />
        </div>
      )}
      {edit && !a.give && (
        <div className="stack" style={{ gap: 6 }}>
          <label className="check"><input type="checkbox" checked={a.disagree} onChange={(e) => patch({ disagree: e.target.checked })} /> Сдающая сторона не согласна с отметками</label>
          {a.disagree && <NameField label="С чем не согласен" value={a.disComment} onSave={(v) => patch({ disComment: v })} />}
          <label className="check"><input type="checkbox" checked={a.absent} onChange={(e) => patch({ absent: e.target.checked })} /> Сдающая сторона отсутствует или отказалась подписать</label>
          {a.absent && <NameField label="Причина (снимите отказ на видео)" value={a.absentReason} onSave={(v) => patch({ absentReason: v })} />}
        </div>
      )}
      <div className="row2 sigs">{sigBlock("give")}{sigBlock("take")}</div>
    </section>
  );
}

function NameField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  return <Field label={label} value={value} edit onSave={onSave} />;
}

function ActPdfButton({ a }: { a: ActView }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn sm ghost" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const { downloadActPdf } = await import("./actPdf.ts");
        await downloadActPdf(a);
      } finally {
        setBusy(false);
      }
    }}>{busy ? "Готовим PDF…" : "Скачать акт PDF"}</button>
  );
}
