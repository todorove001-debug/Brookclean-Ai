"use strict";
const state = { token: sessionStorage.getItem("cf_token") || "" };
const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") node.addEventListener("click", v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? "")));
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "Authorization": `Bearer ${state.token}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (res.status === 401) { logout(); throw new Error("Требуется вход"); }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof body === "object" ? JSON.stringify(body.detail) : body);
  return body;
}

function logout() { sessionStorage.removeItem("cf_token"); state.token = ""; $("#nav").hidden = true; $("#view").hidden = true; $("#login").hidden = false; }
function show(...nodes) { const v = $("#view"); v.replaceChildren(...nodes); v.hidden = false; }
function fmt(dt) { return dt ? new Date(dt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—"; }
function money(x) { return `$${Number(x || 0).toFixed(2)}`; }

async function viewStatus() {
  const [me, status, costs] = await Promise.all([api("/api/v1/me"), api("/api/v1/monitoring/status").catch(() => null), api("/api/v1/monitoring/costs").catch(() => null)]);
  const metrics = el("div", { class: "grid" });
  if (status) for (const [k, v] of Object.entries(status.items)) metrics.append(el("div", { class: "card metric" }, el("b", {}, v), k));
  show(
    el("h1", {}, `Здравствуйте, ${me.display_name}`), el("p", { class: "muted" }, `Роль: ${me.role}`),
    costs ? el("div", { class: "card" }, `Расходы: сегодня ${money(costs.day_usd)} из ${money(costs.daily_limit_usd)}, месяц ${money(costs.month_usd)} из ${money(costs.monthly_limit_usd)}`) : "",
    el("h2", {}, "Материалы по статусам"), metrics,
    status ? el("p", { class: "muted" }, `Очередь задач: ${JSON.stringify(status.queue)}; ожидание старейшей задачи ${Math.round(status.oldest_ready_task_s)} с`) : "",
  );
}

async function mediaPreview(asset) {
  if (!asset) return "";
  const res = await fetch(`/api/v1/media/${asset.asset_id}/content`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) return el("p", { class: "error" }, "Файл недоступен");
  const url = URL.createObjectURL(await res.blob());
  return asset.mime_type.startsWith("video/") ? el("video", { class: "preview", src: url, controls: "" }) : el("img", { class: "preview", src: url, alt: "" });
}

async function viewDrafts() {
  const items = await api("/api/v1/items?status=awaiting_approval");
  const cards = [];
  for (const it of items) {
    const detail = await api(`/api/v1/items/${it.id}`);
    const v = detail.versions.find((x) => x.id === it.current_version_id);
    if (!v) continue;
    const primary = detail.current_media.find((m) => m.role === "primary");
    const findings = (v.qa_report?.findings || []).filter((f) => f.severity !== "info");
    const comment = el("textarea", { rows: "2", placeholder: "Что изменить" });
    const act = async (path, body) => { try { const r = await api(`/api/v1/items/${it.id}/${path}`, { method: "POST", body: JSON.stringify({ version_id: v.id, ...body }) }); alert(r.message); viewDrafts(); } catch (e) { alert(e.message); } };
    cards.push(el("div", { class: "card" },
      el("h3", {}, v.title || it.topic), el("p", { class: "muted" }, `${it.format} · версия ${v.version_no} · QA: ${v.qa_status} · план ${fmt(it.planned_at)}`),
      await mediaPreview(primary),
      el("pre", { class: "post" }, v.body_html.replace(/<[^>]+>/g, "")),
      ...findings.slice(0, 12).map((f) => el("div", { class: "finding" }, `${f.severity === "blocking" ? "⛔" : f.severity === "manual_check" ? "🔎" : "⚠️"} ${f.message} ${f.quote ? "— «" + f.quote + "»" : ""}`)),
      el("div", { class: "row" },
        ["passed", "needs_review"].includes(v.qa_status) ? el("button", { onclick: () => act("approve", {}) }, "Одобрить") : "",
        el("button", { class: "secondary", onclick: () => act("regenerate-text", {}) }, "Переписать текст"),
        el("button", { class: "danger", onclick: () => confirm("Отклонить?") && act("reject", {}) }, "Отклонить")),
      comment, el("div", { class: "row" }, el("button", { class: "secondary", onclick: () => comment.value.trim() && act("request-changes", { comment: comment.value }) }, "Отправить правки")),
    ));
  }
  show(el("h1", {}, "Ждут согласования"), cards.length ? cards : el("p", {}, "Черновиков нет."));
}

async function viewPlan() {
  const items = await api("/api/v1/items?limit=100");
  const rows = items.map((i) => el("tr", {}, el("td", {}, fmt(i.scheduled_at || i.planned_at)), el("td", {}, i.format), el("td", {}, i.status), el("td", {}, i.topic), el("td", { class: "error" }, i.last_error || "")));
  const request = async (days) => { try { await api("/api/v1/plans", { method: "POST", body: JSON.stringify({ horizon_days: days }) }); alert("Генерация плана поставлена в очередь"); } catch (e) { alert(e.message); } };
  show(el("h1", {}, "Контент-план"), el("div", { class: "row" }, el("button", { onclick: () => request(7) }, "План на 7 дней"), el("button", { onclick: () => request(30) }, "План на 30 дней")),
    el("table", {}, el("tr", {}, el("th", {}, "Время"), el("th", {}, "Формат"), el("th", {}, "Статус"), el("th", {}, "Тема"), el("th", {}, "Ошибка")), rows));
}

async function viewBudget() {
  const data = await api("/api/v1/budget");
  const s = data.settings;
  const fields = [["daily_limit_usd", "Лимит в день, $"], ["monthly_limit_usd", "Лимит в месяц, $"], ["max_task_cost_usd", "Максимум на одну задачу, $"], ["video_generations_per_month", "Генераций видео в месяц"], ["max_retries_paid", "Повторов платной генерации"]];
  const inputs = Object.fromEntries(fields.map(([k]) => [k, el("input", { type: "number", step: "0.01", min: "0", value: s[k] })]));
  const thresholds = el("input", { value: s.warn_thresholds.join(", ") });
  const save = async () => {
    const body = { ...s, warn_thresholds: thresholds.value.split(",").map(Number).filter(Boolean) };
    for (const [k] of fields) body[k] = Number(inputs[k].value);
    try { await api("/api/v1/budget", { method: "PUT", body: JSON.stringify(body) }); alert("Сохранено"); viewBudget(); } catch (e) { alert(e.message); }
  };
  show(el("h1", {}, "Бюджет"), el("p", {}, `Потрачено сегодня ${money(data.spend.day_usd)}, за месяц ${money(data.spend.month_usd)}, генераций видео ${data.spend.video_generations_month}`),
    el("div", { class: "card" }, ...fields.map(([k, label]) => el("label", {}, label, inputs[k])), el("label", {}, "Пороги предупреждений (доли)", thresholds), el("div", { class: "row" }, el("button", { onclick: save }, "Сохранить"))));
}

async function viewErrors() {
  const e = await api("/api/v1/monitoring/errors");
  const list = (title, rows, render) => el("div", { class: "card" }, el("h3", {}, title), rows.length ? rows.map(render) : el("p", { class: "muted" }, "нет"));
  show(el("h1", {}, "Ошибки за 7 дней"),
    list("Материалы", e.failed_items, (i) => el("p", {}, `${fmt(i.at)} · ${i.topic} — `, el("span", { class: "error" }, i.error || ""))),
    list("Видео", e.video_jobs, (v) => el("p", {}, `${v.kind} ${v.status}: ${v.error || ""}`)),
    list("Публикации", e.publishing, (p) => el("p", {}, `${p.status}: ${p.error || ""}`)),
    list("Фоновые задачи", e.failed_tasks, (t) => el("p", {}, `${t.name}: ${t.count}`)));
}

const views = { status: viewStatus, drafts: viewDrafts, plan: viewPlan, budget: viewBudget, errors: viewErrors };
async function open(name) { try { await views[name](); } catch (e) { show(el("p", { class: "error" }, e.message)); } }

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  state.token = $("#token").value.trim();
  try { await api("/api/v1/me"); sessionStorage.setItem("cf_token", state.token); start(); } catch (e) { $("#login-error").textContent = e.message; }
});
$("#logout").addEventListener("click", logout);
document.querySelectorAll("nav button[data-view]").forEach((b) => b.addEventListener("click", () => open(b.dataset.view)));
function start() { $("#login").hidden = true; $("#nav").hidden = false; open("status"); }
if (state.token) api("/api/v1/me").then(start).catch(logout);
