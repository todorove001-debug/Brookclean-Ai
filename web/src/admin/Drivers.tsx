import { useEffect, useState } from "react";
import {
  DOC_KINDS, DOC_KEYS, HUB, SITES, can, parseDriverSheet, ROLES, terminalOf,
  type DocKind, type DriverCard, type DriverInput, type RecognizeResult, type StaffMe,
} from "@brookclean/shared";
import { ApiError } from "../api.ts";
import { navigate } from "../router.ts";
import { staffApi, type DriverPatch, type StaffUser } from "./api.ts";
import { RecognizedFields, photoToJpeg } from "./Recognized.tsx";

/** Пустые поля карточки заполняются из распознанного документа: ФИО из паспорта, тягач и прицеп из СТС, компания — собственник по СТС. */
function fromDoc(k: DocKind, v: Record<string, string>, f: Partial<Record<keyof DriverInput, unknown>>): DriverPatch {
  const out: DriverPatch = {};
  const fill = (key: keyof DriverInput, val: string | undefined) => { if (val?.trim() && !String(f[key] ?? "").trim()) Object.assign(out, { [key]: val.trim() }); };
  if (k === "p1") fill("name", [v.last_name, v.first_name, v.middle_name].filter(Boolean).join(" "));
  if (k === "t1f") { fill("tractorPlate", v.plate); fill("tractorModel", v.model); }
  if (k === "t2f") { fill("trailerPlate", v.plate); fill("trailerModel", v.model); }
  if (k === "t1b" || k === "t2b") fill("companyName", v.owner);
  return out;
}

/** Раздел «Водители»: реестр для менеджера, свой список у приёмщика терминала, своя карточка для водителя. */
export function DriversScreen({ me, path }: { me: StaffMe; path: string }) {
  const manager = can(me.role, "drivers.edit");
  const term = terminalOf(me);
  if (!manager && !term) return <MyCard />;
  const open = /^\/admin\/drivers\/(\d+)/.exec(path.split("?")[0]);
  if (open) return <DriverPage key={open[1]} id={Number(open[1])} manager={manager} />;
  return (
    <div className="stack">
      {can(me.role, "staff.approve") && <Registrations />}
      <Registry term={term} />
    </div>
  );
}

const FILTERS = [["all", "Все"], ["own", "Свои"], ["hired", "Наёмные"]] as const;

/** term — приёмщик терминала: сервер отдаёт только водителей его площадки, новые водители попадают туда же. */
function Registry({ term }: { term: string | null }) {
  const [list, setList] = useState<DriverCard[] | null>(null);
  const [q, setQ] = useState("");
  const [f, setF] = useState<(typeof FILTERS)[number][0]>("all");
  const [site, setSite] = useState<string>("all");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => staffApi.registry().then(setList, (e: ApiError) => setMsg({ ok: false, text: e.message }));
  useEffect(() => {
    load();
  }, []);

  async function importFile(file: File) {
    setMsg(null);
    try {
      const { readSheet } = await import("read-excel-file/browser");
      const parsed = parseDriverSheet((await readSheet(file)) as unknown[][]);
      if ("error" in parsed) return setMsg({ ok: false, text: parsed.error });
      const r = await staffApi.importDrivers(parsed.drivers);
      setMsg({ ok: true, text: `Импорт: добавлено водителей ${r.added}, компаний ${parsed.companies}${r.skipped ? `, повторов пропущено ${r.skipped}` : ""}` });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Файл не читается. Нужен .xlsx" });
    }
  }
  async function create(own: boolean) {
    const name = prompt(own ? "ФИО своего водителя" : "ФИО наёмного водителя")?.trim();
    if (!name) return;
    try {
      const d = await staffApi.createDriver({ name, own, ...(!term && site !== "all" && { site }) });
      navigate(`/admin/drivers/${d.id}`);
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    }
  }

  if (!list) return <p className="muted">{msg?.text || "Загружаем водителей…"}</p>;
  const ql = q.trim().toLowerCase();
  const shown = list.filter((d) => (f === "all" || (f === "own") === d.own) && (site === "all" || d.site === site) &&
    (!ql || [d.name, d.phone, d.tractorModel, d.tractorPlate, d.trailerModel, d.trailerPlate, d.companyName, d.companyInn, d.group].join(" ").toLowerCase().includes(ql)));
  const open = (id: number) => navigate(`/admin/drivers/${id}`);
  return (
    <section className="card">
      <div className="row-between">
        <h3>{term ? `Водители терминала ${term}` : "Водители"} · {shown.length}{shown.length !== list.length ? ` из ${list.length}` : ""}</h3>
        <div className="inline">
          <label className="btn sm ghost filebtn">Импорт из Excel
            <input type="file" accept=".xlsx" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) importFile(file); }} />
          </label>
          <button className="btn sm ghost" onClick={() => create(true)}>+ Свой водитель</button>
          <button className="btn sm dark" onClick={() => create(false)}>+ Наёмный водитель</button>
        </div>
      </div>
      {msg && <div className={`callout ${msg.ok ? "ok" : "warn"}`} role="status">{msg.text}</div>}
      <div className="filters">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: ФИО, госномер, компания, телефон" aria-label="Поиск водителя" />
        {FILTERS.map(([k, l]) => (
          <button key={k} className={`btn sm ${f === k ? "dark" : "ghost"}`} aria-pressed={f === k} onClick={() => setF(k)}>
            {l} · {k === "all" ? list.length : list.filter((d) => (k === "own") === d.own).length}
          </button>
        ))}
        {!term && (
          <select value={site} onChange={(e) => setSite(e.target.value)} aria-label="Площадка">
            <option value="all">Все площадки</option>
            {SITES.map((x) => <option key={x} value={x}>{x === HUB ? x : `Терминал ${x}`}</option>)}
          </select>
        )}
      </div>
      <div className="tablewrap">
        <table className="sheet narrow">
          <thead><tr><th>Водитель</th><th>Тип</th><th>Компания / автопарк</th><th>Телефон</th><th>Тягач</th><th>Прицеп</th><th>ВУ</th><th>Документы</th><th>Рейс</th></tr></thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className={d.active ? "" : "off"}>
                <td><button className="linkbtn" onClick={() => open(d.id)}>{d.name}</button>{d.pending && <> <span className="pill warn">ждёт доступа</span></>}
                  {!term && d.site !== HUB && <><br /><span className="pill info">терминал {d.site}</span></>}</td>
                <td><span className={`pill ${d.own ? "info" : "warn"}`}>{d.own ? "свой" : "наёмный"}</span></td>
                <td>{d.own ? d.group || "—" : <>{d.companyName || d.group || "не указана"}{d.companyInn && <><br /><small className="muted">ИНН {d.companyInn}</small></>}</>}</td>
                <td className="mono">{d.phone || "—"}</td>
                <td>{d.tractorModel}<br /><b className="mono">{d.tractorPlate || "—"}</b></td>
                <td>{d.trailerModel}<br /><b className="mono">{d.trailerPlate || "—"}</b></td>
                <td className="mono">{d.docs.lic?.number || "—"}{d.licExpired ? <> <span className="pill err">просрочено</span></> : d.docs.lic?.valid_until ? <><br /><small className="muted">до {d.docs.lic.valid_until}</small></> : null}</td>
                <td><span className={`pill ${d.docsFilled === DOC_KEYS.length ? "ok" : d.docsFilled ? "warn" : "gray"}`}>{d.docsFilled}/{DOC_KEYS.length}</span>{d.fromExcel && <><br /><small className="muted">из Excel</small></>}</td>
                <td>{d.tripId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {term && <p className="small muted">Здесь только ваши водители: Владивосток их не видит, вы не видите водителей Владивостока. Документы, телефон и данные компании можно заполнить по фото в карточке водителя.</p>}
      <p className="small muted">При назначении водителя на рейс его тягач, прицеп и компания подставляются сами. Excel: столбцы «Транспортное средство | … | Водители | Дата рождения | Паспорт | Дата выдачи | Телефон», строки-заголовки групп («Наёмники», компания с ИНН).</p>
    </section>
  );
}

function DriverPage({ id, manager }: { id: number; manager: boolean }) {
  const [d, setD] = useState<DriverCard | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    staffApi.registry().then((l) => {
      const x = l.find((c) => c.id === id);
      if (x) setD(x);
      else setError("Водитель не найден");
    }, (e: ApiError) => setError(e.message));
  }, [id]);
  const back = <a className="small" href="/admin/drivers" onClick={(e) => { e.preventDefault(); navigate("/admin/drivers"); }}>← К списку водителей</a>;
  if (!d) return <div className="stack">{back}<p className="muted">{error || "Загружаем…"}</p></div>;
  return (
    <div className="stack">
      {back}
      {manager && (
        <div className="inline">
          <label htmlFor="dv-site" className="small">Площадка</label>
          <select id="dv-site" value={d.site} onChange={(e) => staffApi.patchDriver(d.id, { site: e.target.value }).then(setD, (er: ApiError) => setError(er.message))}>
            {SITES.map((x) => <option key={x} value={x}>{x === HUB ? x : `Терминал ${x}`}</option>)}
          </select>
        </div>
      )}
      <CardEditor d={d} self={false} save={(b) => staffApi.patchDriver(d.id, b)} onSaved={setD} />
    </div>
  );
}

function MyCard() {
  const [d, setD] = useState<DriverCard | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    staffApi.myCard().then(setD, (e: ApiError) => setError(e.message));
  }, []);
  if (d === undefined) return <p className="muted">{error || "Загружаем…"}</p>;
  const card = d ?? ({ id: 0, site: HUB, name: "", phone: "", own: true, group: "", tractorModel: "", tractorPlate: "", trailerModel: "", trailerPlate: "", companyName: "", companyInn: "",
    companyPhone: "", docs: {}, staffId: null, pending: false, active: true, fromExcel: false, createdAt: "", tripId: null, docsFilled: 0, licExpired: false } satisfies DriverCard);
  return (
    <div className="stack">
      <p className="small muted">Ваши данные для актов приёмки и рейсовых листов. Сфотографируйте документы: поля заполнятся сами, сверьте их с фото.</p>
      <CardEditor d={card} self save={(b) => staffApi.patchMyCard(b)} onSaved={setD} />
    </div>
  );
}

type Draft = Omit<DriverInput, "docs">;
const pick = (d: DriverCard): Draft => ({
  name: d.name, phone: d.phone, own: d.own, group: d.group, tractorModel: d.tractorModel, tractorPlate: d.tractorPlate, trailerModel: d.trailerModel,
  trailerPlate: d.trailerPlate, companyName: d.companyName, companyInn: d.companyInn, companyPhone: d.companyPhone,
});

function CardEditor({ d, self, save, onSaved }: { d: DriverCard; self: boolean; save: (b: DriverPatch) => Promise<DriverCard>; onSaved: (d: DriverCard) => void }) {
  const [f, setF] = useState<Draft>(() => pick(d));
  const [docs, setDocs] = useState(d.docs);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(pick(d)) || JSON.stringify(docs) !== JSON.stringify(d.docs);

  async function run(b: DriverPatch, done = "Сохранено") {
    setBusy(true);
    setMsg(null);
    try {
      const x = await save(b);
      onSaved(x);
      setF(pick(x));
      setDocs(x.docs);
      setMsg({ ok: true, text: done });
    } catch (e) {
      setMsg({ ok: false, text: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  }
  const { name: _n, own: _o, group: _g, ...selfFields } = f;
  const input = (k: keyof Draft, label: string, attrs: { inputMode?: "tel" | "numeric"; mono?: boolean; disabled?: boolean } = {}) => (
    <div className="field">
      <label htmlFor={`dv-${k}`}>{label}</label>
      <input id={`dv-${k}`} className={attrs.mono ? "mono" : undefined} inputMode={attrs.inputMode} disabled={attrs.disabled}
        value={String(f[k] ?? "")} onChange={(e) => setF((s) => ({ ...s, [k]: e.target.value }))} />
    </div>
  );
  return (
    <>
      <section className="card">
        <div className="row-between">
          <h2>{d.name || "Моя карточка"}</h2>
          <span className={`pill ${f.own ? "info" : "warn"}`}>{f.own ? "свой водитель" : "наёмный"}</span>
        </div>
        <p className="small muted">{d.tripId ? `Рейс ${d.tripId}` : "Рейс не назначен"} · документы {d.docsFilled}/{DOC_KEYS.length}
          {d.licExpired && <> · <span className="pill err">ВУ просрочено</span></>}{d.pending && <> · <span className="pill warn">вход ждёт подтверждения</span></>}</p>
        <div className="grid4">
          {input("name", "ФИО", { disabled: self })}
          {input("phone", "Телефон", { inputMode: "tel" })}
        </div>
        {!self && (
          <label className="check">
            <input type="checkbox" checked={!f.own} onChange={(e) => setF((s) => ({ ...s, own: !e.target.checked }))} />
            <span>Наёмный водитель (не наш)</span>
          </label>
        )}
        <h3>Транспорт</h3>
        <div className="grid4">
          {input("tractorModel", "Тягач · марка, модель")}
          {input("tractorPlate", "Тягач · госномер", { mono: true })}
          {input("trailerModel", "Прицеп · марка, модель")}
          {input("trailerPlate", "Прицеп · госномер", { mono: true })}
        </div>
        <h3>{f.own ? "Компания" : "Компания-перевозчик"}</h3>
        <div className="grid4">
          {input("companyName", "Название")}
          {input("companyInn", "ИНН", { inputMode: "numeric" })}
          {input("companyPhone", "Телефон диспетчера / руководителя", { inputMode: "tel" })}
        </div>
        {msg && <div className={`callout ${msg.ok ? "ok" : "warn"}`} role="status">{msg.text}</div>}
        <div className="inline">
          <button className="btn primary" disabled={busy || !dirty} onClick={() => run(self ? { ...selfFields, docs } : { ...f, docs })}>Сохранить</button>
          {!self && <button className="btn ghost" disabled={busy} onClick={() => run({ active: !d.active }, d.active ? "Водитель скрыт из выбора на рейс" : "Водитель снова доступен")}>
            {d.active ? "Скрыть из выбора" : "Вернуть в работу"}</button>}
        </div>
      </section>
      <section className="card">
        <h3>Документы</h3>
        <p className="small muted">Сфотографируйте документ: ИИ прочитает поля, вы сверите их с фото. Сами фото не сохраняются, только данные.</p>
        {DOC_KEYS.map((k) => (
          <DocBlock key={k} kind={k} values={docs[k] ?? {}} onChange={(v) => setDocs((s) => ({ ...s, [k]: v }))}
            onRecognized={(v) => run({ docs: { [k]: v }, ...fromDoc(k, v, f) }, `${DOC_KINDS[k].label}: данные сохранены`)} />
        ))}
        <button className="btn primary self-start" disabled={busy || !dirty} onClick={() => run(self ? { ...selfFields, docs } : { ...f, docs })}>Сохранить</button>
      </section>
    </>
  );
}

function DocBlock({ kind, values, onChange, onRecognized }: {
  kind: DocKind; values: Record<string, string>; onChange: (v: Record<string, string>) => void; onRecognized: (v: Record<string, string>) => void;
}) {
  const [s, setS] = useState<null | { photo: string; busy: boolean; r: RecognizeResult | null; v: Record<string, string>; msg: string }>(null);
  const filled = Object.values(values).some(Boolean);
  async function shoot(file: File) {
    const photo = await photoToJpeg(file);
    setS({ photo, busy: true, r: null, v: {}, msg: "" });
    try {
      const r = await staffApi.recognize(kind, photo);
      setS({ photo, busy: false, r, v: { ...values, ...r.fields }, msg: "" });
    } catch (e) {
      setS({ photo, busy: false, r: null, v: { ...values }, msg: (e as ApiError).message });
    }
  }
  return (
    <div className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
      <div className="row-between">
        <b>{DOC_KINDS[kind].label} {filled && <span className="pill ok">заполнено</span>}</b>
        {!s && <label className="btn sm ghost filebtn">{filled ? "Переснять" : "Сфотографировать"}
          <input type="file" accept="image/*" capture="environment" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) shoot(file); }} />
        </label>}
      </div>
      {s ? (
        s.busy ? <p className="small"><span className="spin" /> Читаю документ…</p> : <>
          {s.msg && <div className="callout warn">{s.msg}</div>}
          <RecognizedFields r={s.r} photo={s.photo} fields={DOC_KINDS[kind].fields} values={s.v}
            onChange={(k, v) => setS((x) => x && { ...x, v: { ...x.v, [k]: v } })}
            onConfirm={() => { onRecognized(s.v); setS(null); }} onCancel={() => setS(null)} confirmLabel="Сохранить в карточку" />
        </>
      ) : (
        <div className="grid4">
          {DOC_KINDS[kind].fields.map(([k, label]) => (
            <div key={k} className="field">
              <label htmlFor={`dd-${kind}-${k}`}>{label}</label>
              <input id={`dd-${kind}-${k}`} value={values[k] ?? ""} onChange={(e) => onChange({ ...values, [k]: e.target.value })} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Заявки на доступ: водитель или приёмщик зарегистрировался сам, менеджер подтверждает. */
export function Registrations() {
  const [list, setList] = useState<StaffUser[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    staffApi.registrations().then(setList, (e: ApiError) => setError(e.message));
  }, []);
  if (!list?.length) return error ? <div className="callout warn">{error}</div> : null;
  const decide = async (id: number, approve: boolean) => {
    if (!approve && !confirm("Отклонить заявку? Номер освободится, человек сможет зарегистрироваться заново.")) return;
    try {
      setList(await staffApi.decideRegistration(id, approve));
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  return (
    <section className="card attention">
      <h3>Заявки на доступ · {list.length}</h3>
      {error && <div className="callout warn">{error}</div>}
      <ul className="plist">
        {list.map((u) => (
          <li key={u.id} className="row-between">
            <span><b>{u.name}</b> · {ROLES[u.role].name}{u.site ? `, ${u.site}` : ""}<br />
              <small className="muted"><span className="mono">{u.phone ?? u.login}</span> · {new Date(u.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></span>
            <span className="inline">
              <button className="btn sm primary" onClick={() => decide(u.id, true)}>Подтвердить</button>
              <button className="btn sm ghost" onClick={() => decide(u.id, false)}>Отклонить</button>
            </span>
          </li>
        ))}
      </ul>
      <p className="small muted">Водитель после подтверждения входит по телефону и паролю, его карточка уже в реестре.</p>
    </section>
  );
}
