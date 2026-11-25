// Up Closets dashboard. Reads from Supabase (which mirrors Workiz).
// Writes only: dashboard-only fields (costs, closet details, photos, crew rates) and
// "New lead", which creates ONE new lead in Workiz through the booking-to-workiz function.
// Nothing here edits or deletes anything in Workiz.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, WORKIZ_APP } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- helpers ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? 0 : Number(v));
const money = (v, d = 2) => "$" + num(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const money0 = (v) => money(v, 0);
const toDate = (v) => (v ? new Date(String(v).replace(" ", "T")) : null);
const fmtDate = (v, opts = { month: "short", day: "numeric", year: "numeric" }) => { const d = toDate(v); return d && !isNaN(d) ? d.toLocaleDateString("en-US", opts) : "—"; };
const fmtTime = (v) => { const d = toDate(v); return d && !isNaN(d) ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""; };
const fmtDT = (v) => { const d = toDate(v); return d && !isNaN(d) ? `${fmtDate(v)} ${fmtTime(v)}` : "—"; };
const phone = (p) => { const d = String(p ?? "").replace(/\D/g, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ""); };
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const relDays = (v) => { const d = toDate(v); if (!d) return ""; const n = Math.round((startOfDay(d) - startOfDay()) / 864e5); return n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`; };
const names = (team) => (Array.isArray(team) ? team.map((t) => t?.name).filter(Boolean) : []);
const tagNames = (tags) => (Array.isArray(tags) ? tags.map((t) => t?.name ?? t).filter(Boolean) : []);
const workizJobUrl = (uuid) => `${WORKIZ_APP}/root/job/${encodeURIComponent(uuid)}/1`;
const workizLeadUrl = (uuid) => `${WORKIZ_APP}/root/lead/${encodeURIComponent(uuid)}/1`;

function toast(msg, isErr = false) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 4000);
}

const STATUS_COLORS = {
  submitted: "b-blue", "in progress": "b-purple", pending: "b-yellow", "done pending approval": "b-yellow",
  done: "b-green", canceled: "b-red", cancelled: "b-red", new: "b-orange", "estimate sent": "b-purple",
  approved: "b-green", won: "b-green", declined: "b-red", unsent: "b-purple", archived: "", paid: "b-green", due: "b-orange",
  "lost lead": "b-red", "sold / in-production": "b-green", rescheduled: "b-yellow", "on hold": "b-yellow",
};
const badge = (s) => (s ? `<span class="badge ${STATUS_COLORS[String(s).toLowerCase()] ?? "b-purple"}">${esc(s)}</span>` : "");
const tagBadges = (tags) => tagNames(tags).map((t) => `<span class="badge ${/sold/i.test(t) ? "b-green" : /follow/i.test(t) ? "b-orange" : "b-purple"}">${esc(t)}</span>`).join("");

// ---------- data ----------
const D = { jobs: [], leads: [], clients: [], estimates: [], invoices: [], crew: [], sync: [], leadStatuses: [], user: null };

async function loadAll() {
  const q = (view, order) => sb.from(view).select("*").order(order.col, { ascending: order.asc ?? false, nullsFirst: false }).limit(5000);
  const [jobs, leads, clients, estimates, invoices, crew, sync, ls] = await Promise.all([
    q("v_jobs", { col: "start_local" }), q("v_leads", { col: "created_local" }), q("v_clients", { col: "created_local" }),
    q("v_estimates", { col: "created_local" }), q("v_invoices", { col: "created_local" }), q("v_crew", { col: "name", asc: true }),
    sb.from("v_sync_status").select("*"),
    sb.from("workiz_records").select("data").eq("entity", "leadstatus"),
  ]);
  const err = [jobs, leads, clients, estimates, invoices, crew, sync, ls].find((r) => r.error);
  if (err) throw err.error;
  Object.assign(D, { jobs: jobs.data, leads: leads.data, clients: clients.data, estimates: estimates.data, invoices: invoices.data, crew: crew.data, sync: sync.data, leadStatuses: ls.data.map((r) => r.data?.name).filter(Boolean) });
  const td = await sb.from("todos").select("id", { count: "exact", head: true }).eq("done", false);
  D.todosOpen = td.count || 0;
  renderSync(); renderNav();
}

// ---------- to-do ----------
async function viewTodo() {
  view(`<div class="empty">Loading…</div>`);
  const { data, error } = await sb.from("todos").select("*").order("section").order("sort").order("id");
  if (error) return view(`<div class="notice">${esc(error.message)}</div>`);
  const sections = [...new Set(data.map((t) => t.section))];
  const done = data.filter((t) => t.done).length;
  const gmail = (t) => `https://mail.google.com/mail/?authuser=rhodeisland@upclosets.com&view=cm&fs=1&to=${encodeURIComponent(/@/.test(t.email_to || "") ? t.email_to : "")}&cc=${encodeURIComponent(t.email_cc || "")}&su=${encodeURIComponent(t.email_subject || "")}&body=${encodeURIComponent(t.email_body || "")}`;
  view(`<div class="page-head"><h2>To-do</h2><span class="muted">${done} of ${data.length} done</span><div class="spacer"></div></div>
    <div class="card" style="margin-bottom:18px;padding:12px 16px"><div class="hbar" style="grid-template-columns:1fr 60px"><div class="track"><div class="fill" style="width:${data.length ? (done / data.length) * 100 : 0}%"></div></div><span class="right num">${data.length ? Math.round((done / data.length) * 100) : 0}%</span></div></div>
    ${sections.map((s) => `<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>${esc(s)}</h3><div class="spacer"></div><span class="muted small">${data.filter((t) => t.section === s && t.done).length}/${data.filter((t) => t.section === s).length}</span></div>
      <div class="card-b">${data.filter((t) => t.section === s).map((t) => `
        <div class="todo" style="border-bottom:1px solid var(--line);padding:12px 0;${t.done ? "opacity:.55" : ""}">
          <label style="flex-direction:row;align-items:flex-start;gap:12px;color:var(--text);font-size:14px;cursor:pointer">
            <input type="checkbox" data-done="${t.id}" ${t.done ? "checked" : ""} style="width:20px;height:20px;accent-color:var(--orange);margin-top:2px;flex-shrink:0" />
            <span style="${t.done ? "text-decoration:line-through" : ""}"><b>${esc(t.title)}</b>${t.details ? `<span class="muted small" style="display:block;margin-top:3px">${esc(t.details)}</span>` : ""}</span></label>
          ${t.email_body ? `<details style="margin:10px 0 0 32px"><summary style="cursor:pointer;color:var(--purple-2);font-size:13px">✉ Email draft: copy and paste</summary>
            <div class="note" style="margin-top:8px"><div class="kv" style="grid-template-columns:70px 1fr;font-size:12.5px"><div>To</div><div>${esc(t.email_to || "")}</div>${t.email_cc ? `<div>CC</div><div>${esc(t.email_cc)}</div>` : ""}<div>Subject</div><div>${esc(t.email_subject || "")}</div></div>
            <pre style="white-space:pre-wrap;font:12.5px/1.5 Poppins,sans-serif;margin:10px 0 0;color:var(--text)">${esc(t.email_body)}</pre></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button class="btn small" data-copy="${t.id}">⧉ Copy email</button><button class="btn small" data-copysub="${t.id}">⧉ Copy subject</button><a class="btn small primary" href="${gmail(t)}" target="_blank" rel="noopener">Open in Gmail ↗</a></div></details>` : ""}
          <textarea data-notes="${t.id}" rows="1" placeholder="Notes…" style="margin:8px 0 0 32px;width:calc(100% - 32px);min-height:34px">${esc(t.notes || "")}</textarea>
        </div>`).join("")}</div></div>`).join("")}
    <div class="card"><div class="card-h"><h3>Add a to-do</h3></div><div class="card-b"><div class="form-row">
      <label class="wide">Task<input id="td-title" /></label>
      <label>Section<select id="td-sec">${sections.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
      <button class="btn primary" id="td-add">＋ Add</button></div></div></div>`);
  const byId = (id) => data.find((t) => String(t.id) === String(id));
  $$("[data-done]").forEach((cb) => cb.onchange = async () => {
    const { error } = await sb.from("todos").update({ done: cb.checked, updated_at: new Date().toISOString() }).eq("id", cb.dataset.done);
    if (error) return toast(error.message, true);
    D.todosOpen = Math.max(0, (D.todosOpen || 0) + (cb.checked ? -1 : 1)); VIEWS.todo(); renderNav();
  });
  $$("[data-notes]").forEach((ta) => ta.onchange = async () => {
    const { error } = await sb.from("todos").update({ notes: ta.value, updated_at: new Date().toISOString() }).eq("id", ta.dataset.notes);
    error ? toast(error.message, true) : toast("Note saved");
  });
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy blocked by the browser. Select the text instead.", true); } };
  $$("[data-copy]").forEach((b) => b.onclick = () => copy(byId(b.dataset.copy).email_body));
  $$("[data-copysub]").forEach((b) => b.onclick = () => copy(byId(b.dataset.copysub).email_subject));
  $("#td-add").onclick = async () => {
    const title = $("#td-title").value.trim(); if (!title) return;
    const { error } = await sb.from("todos").insert({ title, section: $("#td-sec").value, sort: 999 });
    if (error) return toast(error.message, true);
    D.todosOpen = (D.todosOpen || 0) + 1; VIEWS.todo(); renderNav();
  };
}

function renderSync() {
  const last = D.sync.map((s) => toDate(s.finished_at)).filter(Boolean).sort((a, b) => b - a)[0];
  const errs = D.sync.filter((s) => s.status === "error" && !/permission/i.test(s.message || ""));
  $("#sync-status").innerHTML = `<div><span class="dot ${errs.length ? "err" : ""}"></span>Workiz sync ${errs.length ? "needs attention" : "OK"}</div>
    <div>Last update: ${last ? last.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}</div>
    <div>Refreshes every 10 min</div>`;
}

// ---------- navigation ----------
const PAGES = [
  { id: "home", label: "Home", ico: "⌂" },
  { id: "todo", label: "To-do", ico: "✓", count: () => D.todosOpen || 0 },
  { id: "schedule", label: "Schedule", ico: "▦" },
  { id: "crew", label: "Crew", ico: "☺" },
  { g: "Sales" },
  { id: "leads", label: "Leads", ico: "✦", count: () => D.leads.filter((l) => /^new$/i.test(l.status)).length },
  { id: "jobs", label: "Jobs", ico: "⚒", count: () => D.jobs.filter((j) => !/done|cancel/i.test(j.status)).length },
  { id: "clients", label: "Clients", ico: "☷" },
  { id: "marketing", label: "Marketing", ico: "📣" },
  { g: "Money" },
  { id: "quote", label: "Quick quote", ico: "⚡" },
  { id: "estimates", label: "Estimates", ico: "✎" },
  { id: "invoices", label: "Invoices", ico: "▤" },
  { id: "payments", label: "Payments", ico: "◎" },
  { id: "pricebook", label: "Price book", ico: "▥" },
  { id: "reports", label: "Reports & profit", ico: "↗" },
];
function renderNav() {
  const cur = (location.hash.slice(2) || "home").split("/")[0];
  $("#nav").innerHTML = PAGES.filter((p) => !p.hidden).map((p) => p.g ? `<div class="group">${p.g}</div>` :
    `<a href="#/${p.id}" class="${cur === p.id ? "active" : ""}"><span class="ico">${p.ico}</span>${p.label}${p.count && p.count() ? `<span class="count">${p.count()}</span>` : ""}</a>`).join("");
}

function route() {
  const [page = "home", id] = location.hash.slice(2).split("/");
  renderNav(); $("#sidebar").classList.remove("open");
  const p = PAGES.find((x) => x.id === page) ?? PAGES[0];
  $("#crumbs").textContent = `Up Closets of Rhode Island  ·  ${p.label}`;
  (VIEWS[p.id] ?? VIEWS.home)();
  if (id && page === "jobs") openJob(decodeURIComponent(id));
  else if (id && page === "leads") openLead(decodeURIComponent(id));
  else if (id && page === "clients") openClient(decodeURIComponent(id));
  else closeDrawer(false);
}

// ---------- reusable table ----------
const tblState = {};
function table(key, { rows, cols, onClick, search, tools = "" }) {
  const st = (tblState[key] ??= { q: "", sort: null, dir: -1 });
  const draw = () => {
    let r = rows;
    if (st.q) { const q = st.q.toLowerCase(); r = r.filter((x) => search(x).toLowerCase().includes(q)); }
    if (st.sort != null) { const c = cols[st.sort]; const sv = c.sort ?? ((x) => x[c.key]); r = [...r].sort((a, b) => { const A = sv(a), B = sv(b); return (A > B ? 1 : A < B ? -1 : 0) * st.dir; }); }
    $(`#tb-${key}`).innerHTML = r.length ? r.map((x, i) => `<tr class="${onClick ? "click" : ""}" data-i="${rows.indexOf(x)}">${cols.map((c) => `<td class="${c.right ? "right num" : ""}">${c.render ? c.render(x) : esc(x[c.key])}</td>`).join("")}</tr>`).join("")
      : `<tr><td colspan="${cols.length}"><div class="empty">Nothing here.</div></td></tr>`;
    $(`#cnt-${key}`).textContent = `${r.length} of ${rows.length}`;
    if (onClick) $$(`#tb-${key} tr.click`).forEach((tr) => tr.onclick = () => onClick(rows[tr.dataset.i]));
  };
  const html = `<div class="card"><div class="tbl-tools"><input id="q-${key}" placeholder="Search…" value="${esc(st.q)}" />${tools}<div class="spacer"></div><span class="muted small" id="cnt-${key}"></span></div>
    <div class="table-wrap"><table><thead><tr>${cols.map((c, i) => `<th data-c="${i}" class="${st.sort === i ? "sorted" : ""} ${c.right ? "right" : ""}">${c.label}${st.sort === i ? (st.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody id="tb-${key}"></tbody></table></div></div>`;
  return { html, mount() {
    draw();
    $(`#q-${key}`).oninput = (e) => { st.q = e.target.value; draw(); };
    $$(`th[data-c]`).forEach((th) => th.onclick = () => { const i = Number(th.dataset.c); st.dir = st.sort === i ? -st.dir : -1; st.sort = i; $$(`th[data-c]`).forEach((t) => t.classList.remove("sorted")); th.classList.add("sorted"); draw(); });
  } };
}

function tabs(key, items, onPick) {
  const st = (tblState["tab-" + key] ??= { active: items[0]?.id });
  return { html: `<div class="tabs" id="tabs-${key}">${items.map((t) => `<div class="tab ${st.active === t.id ? "active" : ""}" data-id="${esc(t.id)}" style="${t.color ? `border-left-color:${t.color}` : ""}"><div class="t">${esc(t.label)}</div><div class="s">${esc(t.sub ?? "")}</div></div>`).join("")}</div>`,
    active: () => st.active,
    mount() { $$(`#tabs-${key} .tab`).forEach((el) => el.onclick = () => { st.active = el.dataset.id; onPick(); }); } };
}

// ---------- charts ----------
function barChart(points, { h = 190, color = "var(--orange)", count = false } = {}) {
  const w = 640, pad = { l: 46, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.v));
  const step = (w - pad.l - pad.r) / Math.max(points.length, 1);
  const bw = Math.max(3, Math.min(28, step * 0.62));
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const every = Math.ceil(points.length / 8);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="#26262d"/><text x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${count ? Math.round(t) : t >= 1000 ? "$" + Math.round(t / 1000) + "k" : "$" + Math.round(t)}</text>`).join("")}
    ${points.map((p, i) => { const x = pad.l + i * step + (step - bw) / 2; return `<rect x="${x}" y="${y(p.v)}" width="${bw}" height="${Math.max(0, h - pad.b - y(p.v))}" rx="3" fill="${color}"><title>${esc(p.label)}: ${count ? p.v : money(p.v)}</title></rect>${i % every === 0 ? `<text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle">${esc(p.short ?? p.label)}</text>` : ""}`; }).join("")}
  </svg>`;
}
const PALETTE = ["#f28c28", "#8b5cf6", "#3fcf8e", "#5aa9ff", "#f5c542", "#f26464", "#ffa64d", "#a78bfa"];
function donut(items) {
  const total = items.reduce((s, i) => s + i.v, 0) || 1; let a = -Math.PI / 2; const R = 52, r = 32, cx = 60, cy = 60;
  const arcs = items.map((it, i) => { const da = (it.v / total) * Math.PI * 2; const a2 = a + da; const large = da > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${cx + rad * Math.cos(ang)} ${cy + rad * Math.sin(ang)}`;
    const d = items.length === 1 ? `M ${cx - R} ${cy} A ${R} ${R} 0 1 1 ${cx + R} ${cy} A ${R} ${R} 0 1 1 ${cx - R} ${cy} M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy}`
      : `M ${p(a, R)} A ${R} ${R} 0 ${large} 1 ${p(a2, R)} L ${p(a2, r)} A ${r} ${r} 0 ${large} 0 ${p(a, r)} Z`;
    a = a2; return `<path d="${d}" fill="${PALETTE[i % PALETTE.length]}" fill-rule="evenodd"><title>${esc(it.label)}: ${it.v}</title></path>`; }).join("");
  return `<div class="donut-wrap"><svg width="120" height="120" viewBox="0 0 120 120">${arcs}</svg><div class="legend">${items.map((it, i) => `<div><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(it.label)} · <b>${Math.round((it.v / total) * 100)}%</b></div>`).join("")}</div></div>`;
}
const hbars = (items, fmt = (v) => v) => { const max = Math.max(1, ...items.map((i) => i.v)); return `<div class="bars">${items.map((i) => `<div class="hbar"><span>${esc(i.label)}</span><div class="track"><div class="fill" style="width:${(i.v / max) * 100}%"></div></div><span class="right num">${fmt(i.v)}</span></div>`).join("") || `<div class="empty">No data yet</div>`}</div>`; };
const countBy = (rows, fn) => { const m = new Map(); rows.forEach((r) => { const k = fn(r) || "—"; m.set(k, (m.get(k) || 0) + 1); }); return [...m].map(([label, v]) => ({ label, v })).sort((a, b) => b.v - a.v); };
const sumBy = (rows, fn, val) => { const m = new Map(); rows.forEach((r) => { (Array.isArray(fn(r)) ? fn(r) : [fn(r)]).forEach((k) => { k = k || "—"; m.set(k, (m.get(k) || 0) + val(r)); }); }); return [...m].map(([label, v]) => ({ label, v })).sort((a, b) => b.v - a.v); };

function salesSeries(range) {
  const done = D.jobs.filter((j) => /done/i.test(j.status) && j.start_local);
  const today = startOfDay();
  if (range === "12m") {
    return Array.from({ length: 12 }, (_, i) => { const m = new Date(today.getFullYear(), today.getMonth() - 11 + i, 1);
      const v = done.filter((j) => { const d = toDate(j.start_local); return d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); }).reduce((s, j) => s + num(j.total_price), 0);
      return { label: m.toLocaleDateString("en-US", { month: "long", year: "numeric" }), short: m.toLocaleDateString("en-US", { month: "short" }), v }; });
  }
  const n = { "14d": 14, "30d": 30, "90d": 90 }[range] ?? 30;
  const map = new Map(); done.forEach((j) => { const k = dayKey(toDate(j.start_local)); map.set(k, (map.get(k) || 0) + num(j.total_price)); });
  return Array.from({ length: n }, (_, i) => { const d = addDays(today, i - n + 1); return { label: fmtDate(d), short: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), v: map.get(dayKey(d)) || 0 }; });
}

// ---------- views ----------
const VIEWS = {};
VIEWS.todo = viewTodo;
VIEWS.marketing = () => viewMarketing();
VIEWS.quote = () => viewQuote();
const view = (html) => { $("#view").innerHTML = html; };

VIEWS.home = () => {
  const today = startOfDay(), tomorrow = addDays(today, 1), monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const inMonth = (v) => { const d = toDate(v); return d && d >= monthStart && d < addDays(today, 1); };
  const doneMonth = D.jobs.filter((j) => /done/i.test(j.status) && inMonth(j.start_local));
  const revenueMonth = doneMonth.reduce((s, j) => s + num(j.total_price), 0);
  const withCosts = doneMonth.filter((j) => num(j.total_cost) > 0);
  const profitMonth = withCosts.reduce((s, j) => s + num(j.profit), 0);
  const openEst = D.estimates.filter((e) => /pending|unsent/i.test(e.status));
  const newLeads = D.leads.filter((l) => /^new$/i.test(l.status));
  const isToday = (v) => { const d = toDate(v); return d && d >= today && d < tomorrow; };
  const jobsToday = D.jobs.filter((j) => isToday(j.start_local));
  const leadsToday = D.leads.filter((l) => isToday(l.start_local));
  const upcoming = [...D.jobs.map((j) => ({ ...j, _t: "job" })), ...D.leads.filter((l) => !l.lost).map((l) => ({ ...l, _t: "lead" }))]
    .filter((x) => toDate(x.start_local) >= today && !/cancel|done/i.test(x.status)).sort((a, b) => toDate(a.start_local) - toDate(b.start_local)).slice(0, 7);
  const estBy = (re) => { const r = D.estimates.filter((e) => re.test(e.status)); return { n: r.length, v: r.reduce((s, e) => s + num(e.total), 0) }; };
  const jobStatus = ["Submitted", "In progress", "Pending", "done pending approval"].map((s) => ({ s, n: D.jobs.filter((j) => j.status === s).length }));
  const leadTop = countBy(D.leads.filter((l) => !l.lost || /cancel/i.test(l.status)), (l) => l.status).slice(0, 5);
  const range = (tblState.salesRange ??= "30d");
  const series = salesSeries(range);
  const since = range === "12m" ? new Date(today.getFullYear(), today.getMonth() - 11, 1) : addDays(today, -({ "14d": 14, "30d": 30, "90d": 90 }[range]) + 1);
  const periodJobs = D.jobs.filter((j) => /done/i.test(j.status) && toDate(j.start_local) >= since);
  const tech = sumBy(periodJobs, (j) => names(j.team), (j) => num(j.total_price)).slice(0, 5);
  const recent = [...D.leads.map((l) => ({ t: l.updated_local, what: `Lead ${l.status}`, who: l.client_name, href: `#/leads/${l.workiz_id}` })),
                  ...D.jobs.map((j) => ({ t: j.created_local, what: `Job ${j.status}`, who: j.client_name, href: `#/jobs/${j.workiz_id}` }))]
    .filter((x) => x.t && toDate(x.t) <= new Date()).sort((a, b) => toDate(b.t) - toDate(a.t)).slice(0, 6);

  view(`
  <div class="page-head"><h2>Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"} 👋</h2><div class="spacer"></div>
    <button class="btn" id="sync-now">⟳ Sync with Workiz now</button></div>
  <div class="grid g4">
    <div class="card kpi"><span class="label">Revenue this month</span><span class="value num">${money0(revenueMonth)}</span><span class="sub">${doneMonth.length} jobs done</span></div>
    <div class="card kpi green"><span class="label">Profit this month</span><span class="value num">${withCosts.length ? money0(profitMonth) : "—"}</span><span class="sub">${withCosts.length} of ${doneMonth.length} jobs have costs entered</span></div>
    <div class="card kpi purple"><span class="label">Open estimates</span><span class="value num">${money0(openEst.reduce((s, e) => s + num(e.total), 0))}</span><span class="sub">${openEst.length} pending or unsent</span></div>
    <div class="card kpi"><span class="label">New leads</span><span class="value num">${newLeads.length}</span><span class="sub">waiting for first contact</span></div>
  </div>
  <div class="grid g4" style="margin-top:16px">
    <div class="card span2"><div class="card-h"><h3>Sales</h3><span class="muted small">completed jobs</span><div class="spacer"></div>
      <select class="pill-select" id="sales-range">${[["14d", "Last 14 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["12m", "Last 12 months"]].map(([v, l]) => `<option value="${v}" ${v === range ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="card-b"><div class="muted small" style="margin-bottom:6px">Total <b class="num" style="color:var(--text)">${money(series.reduce((s, p) => s + p.v, 0))}</b></div>${barChart(series)}</div>
      <div class="card-f"><a href="#/reports">View reports →</a></div></div>
    <div class="card"><div class="card-h"><h3>Estimates</h3></div><div class="card-b statlist">
      ${[["Unsent", /unsent/i, "c-purple"], ["Pending", /pending/i, "c-orange"], ["Approved", /approved/i, "c-blue"], ["Won", /won/i, "c-green"], ["Declined", /declined/i, "c-red"]].map(([l, re, c]) => { const x = estBy(re); return `<div class="statrow ${c}"><div class="k">${l}<small>Worth ${money(x.v)}</small></div><div class="v num">${x.n}</div></div>`; }).join("")}
      </div><div class="card-f"><a href="#/estimates">View all →</a></div></div>
    <div class="card"><div class="card-h"><h3>Today</h3></div><div class="card-b statlist">
      <div class="statrow c-orange"><div class="k">Jobs scheduled</div><div class="v num">${jobsToday.length}</div></div>
      <div class="statrow c-purple"><div class="k">Consultations (leads)</div><div class="v num">${leadsToday.length}</div></div>
      <div class="statrow c-green"><div class="k">Jobs done</div><div class="v num">${jobsToday.filter((j) => /done/i.test(j.status)).length}</div></div>
      <div class="statrow c-red"><div class="k">Canceled</div><div class="v num">${jobsToday.filter((j) => /cancel/i.test(j.status)).length}</div></div>
      <div class="statrow c-blue"><div class="k">Leads created</div><div class="v num">${D.leads.filter((l) => isToday(l.created_local)).length}</div></div>
    </div></div>
  </div>
  <div class="grid g4" style="margin-top:16px">
    <div class="card"><div class="card-h"><h3>Jobs</h3></div><div class="card-b statlist">
      ${jobStatus.map((x, i) => `<div class="statrow ${["c-blue", "c-purple", "c-yellow", "c-red"][i]}"><div class="k">${esc(x.s)}</div><div class="v num">${x.n}</div></div>`).join("")}
    </div><div class="card-f"><a href="#/jobs">View all →</a></div></div>
    <div class="card"><div class="card-h"><h3>Coming up</h3></div><div class="card-b feed">
      ${upcoming.map((x) => `<a class="feed-item" href="#/${x._t === "job" ? "jobs" : "leads"}/${esc(x.workiz_id)}" style="color:inherit"><span class="when">${esc(relDays(x.start_local))}</span><span class="what">${esc(x.client_name)} ${x._t === "lead" ? '<span class="badge b-purple">consult</span>' : '<span class="badge b-orange">install</span>'}<small>${esc(fmtDT(x.start_local))} · ${esc(x.address || "")}</small></span></a>`).join("") || `<div class="empty">Nothing scheduled</div>`}
    </div><div class="card-f"><a href="#/schedule">Schedule →</a></div></div>
    <div class="card"><div class="card-h"><h3>Top job types</h3></div><div class="card-b">${donut(countBy(D.jobs, (j) => j.job_type).slice(0, 5))}</div></div>
    <div class="card"><div class="card-h"><h3>Top lead sources</h3></div><div class="card-b">${hbars(countBy(D.leads, (l) => l.source).slice(0, 6))}</div></div>
  </div>
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><div class="card-h"><h3>Leads</h3></div><div class="card-b statlist">
      ${leadTop.map((x, i) => `<div class="statrow ${["c-orange", "c-purple", "c-yellow", "c-blue", "c-red"][i]}"><div class="k">${esc(x.label)}</div><div class="v num">${x.v}</div></div>`).join("")}
    </div><div class="card-f"><a href="#/leads">View all →</a></div></div>
    <div class="card"><div class="card-h"><h3>Tech scoreboard</h3><span class="muted small">same period as Sales</span></div><div class="card-b">${hbars(tech, money0)}</div></div>
    <div class="card"><div class="card-h"><h3>Recent activity</h3></div><div class="card-b feed">
      ${recent.map((r) => `<a class="feed-item" href="${esc(r.href)}" style="color:inherit"><span class="when">${esc(relDays(r.t))}</span><span class="what">${esc(r.who)}<small>${esc(r.what)}</small></span></a>`).join("")}
    </div></div>
  </div>`);
  $("#sales-range").onchange = (e) => { tblState.salesRange = e.target.value; VIEWS.home(); };
  $("#sync-now").onclick = syncNow;
};

VIEWS.schedule = () => {
  const today = startOfDay(), end = addDays(today, 21);
  const items = [...D.jobs.map((j) => ({ ...j, _t: "job" })), ...D.leads.filter((l) => !l.lost).map((l) => ({ ...l, _t: "lead" }))]
    .filter((x) => { const d = toDate(x.start_local); return d && d >= today && d < end && !/cancel/i.test(x.status); })
    .sort((a, b) => toDate(a.start_local) - toDate(b.start_local));
  const byDay = new Map(); items.forEach((x) => { const k = dayKey(toDate(x.start_local)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(x); });
  view(`<div class="page-head"><h2>Schedule</h2><span class="muted">next 3 weeks · <span class="badge b-orange">installs</span> <span class="badge b-purple">consultations</span></span></div>
    ${[...byDay].map(([k, xs]) => { const d = toDate(k + " 00:00:00"); return `<div class="day"><h4>${dayKey(d) === dayKey(today) ? '<span class="today">Today · </span>' : ""}${d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</h4>
      ${xs.map((x) => `<a class="slot ${x._t === "lead" ? "lead" : ""}" href="#/${x._t === "job" ? "jobs" : "leads"}/${esc(x.workiz_id)}" style="color:inherit;text-decoration:none">
        <span class="time">${esc(fmtTime(x.start_local) || "All day")}</span>
        <span>${esc(x.client_name)} <span class="muted">· ${esc(x.job_type || "")}</span><span class="sub muted small" style="display:block">${esc(x.address || "")}</span></span>
        <span>${names(x.team).map((n) => `<span class="badge b-purple">${esc(n)}</span>`).join("")}</span></a>`).join("")}</div>`; }).join("") || `<div class="notice">Nothing on the schedule for the next 3 weeks.</div>`}`);
};

VIEWS.crew = () => {
  view(`<div class="page-head"><h2>Crew</h2><span class="muted">Hourly rates are used to work out labor cost on each job. They stay in the dashboard only.</span></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Email</th><th>Status</th><th class="right">Hourly rate</th></tr></thead><tbody>
  ${D.crew.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.role)}${c.field_tech ? ' <span class="badge b-orange">field</span>' : ""}</td><td>${esc(phone(c.phone))}</td><td>${esc(c.email)}</td><td>${c.active ? badge("Active") : '<span class="badge">Inactive</span>'}</td>
    <td class="right"><input type="number" min="0" step="0.5" data-rate="${esc(c.workiz_id)}" value="${c.dash_hourly_rate ?? ""}" placeholder="$/hr" style="max-width:110px;text-align:right" /></td></tr>`).join("")}
  </tbody></table></div></div>`);
  $$("input[data-rate]").forEach((inp) => inp.onchange = async () => {
    const { error } = await sb.from("crew").upsert({ workiz_id: inp.dataset.rate, dash_hourly_rate: inp.value === "" ? null : Number(inp.value) }, { onConflict: "workiz_id" });
    if (error) return toast(error.message, true);
    const c = D.crew.find((x) => x.workiz_id === inp.dataset.rate); if (c) c.dash_hourly_rate = inp.value === "" ? null : Number(inp.value);
    toast("Rate saved");
  });
};

VIEWS.leads = () => {
  const order = D.leadStatuses.length ? D.leadStatuses : [...new Set(D.leads.map((l) => l.status))];
  const counts = countBy(D.leads, (l) => l.status);
  const items = [{ id: "All", label: "All", sub: D.leads.length }, ...order.map((s) => ({ id: s, label: s, sub: counts.find((c) => c.label === s)?.v ?? 0 })).filter((t) => t.sub > 0)];
  const tb = tabs("leads", items, () => VIEWS.leads());
  const rows = D.leads.filter((l) => tb.active() === "All" || l.status === tb.active());
  const t = table("leads", { rows, search: (l) => [l.client_name, l.client_phone, l.client_email, l.address, l.uuid, l.source, l.description].join(" "),
    onClick: (l) => (location.hash = `#/leads/${l.workiz_id}`),
    cols: [
      { label: "ID", key: "uuid", render: (l) => `<b>${esc(l.uuid)}</b>` },
      { label: "Status", key: "status", render: (l) => badge(l.status) },
      { label: "Client", key: "client_name", render: (l) => `${esc(l.client_name)}<span class="sub">${esc(l.client_email || "")}</span>` },
      { label: "Location", key: "address" },
      { label: "Source", key: "source" },
      { label: "Phone", key: "client_phone", render: (l) => esc(phone(l.client_phone)) },
      { label: "Appointment", key: "start_local", sort: (l) => l.start_local || "", render: (l) => `${esc(fmtDT(l.start_local))}<span class="sub">${esc(relDays(l.start_local))}</span>` },
      { label: "Created", key: "created_local", sort: (l) => l.created_local || "", render: (l) => esc(fmtDate(l.created_local)) },
      { label: "Assigned", key: "team", sort: (l) => names(l.team).join(), render: (l) => names(l.team).map((n) => `<span class="badge b-purple">${esc(n)}</span>`).join("") },
    ] });
  view(`<div class="page-head"><h2>Leads</h2><div class="spacer"></div><button class="btn primary" id="add-lead">＋ Add lead</button></div>${tb.html}${t.html}`);
  tb.mount(); t.mount(); $("#add-lead").onclick = openNewLead;
};

VIEWS.jobs = () => {
  const statuses = ["All", "Submitted", "In progress", "Pending", "done pending approval", "Done", "Canceled"];
  const tb = tabs("jobs", statuses.map((s) => ({ id: s, label: s === "done pending approval" ? "Done – pending approval" : s, sub: s === "All" ? D.jobs.length : D.jobs.filter((j) => j.status === s).length })), () => VIEWS.jobs());
  const rows = D.jobs.filter((j) => tb.active() === "All" || j.status === tb.active());
  const t = table("jobs", { rows, search: (j) => [j.client_name, j.uuid, j.address, j.client_phone, j.job_type, names(j.team).join(" "), tagNames(j.tags).join(" ")].join(" "),
    onClick: (j) => (location.hash = `#/jobs/${j.workiz_id}`),
    cols: [
      { label: "Job ID", key: "uuid", render: (j) => `<b>${esc(j.uuid)}</b>` },
      { label: "Client", key: "client_name", render: (j) => `${esc(j.client_name)}<span class="sub">${esc(j.client_email || "")}</span>` },
      { label: "Status", key: "status", render: (j) => badge(j.status) + (j.sub_status ? `<span class="sub">${esc(j.sub_status)}</span>` : "") },
      { label: "Tags", key: "tags", sort: (j) => tagNames(j.tags).join(), render: (j) => tagBadges(j.tags) },
      { label: "Job type", key: "job_type" },
      { label: "Scheduled", key: "start_local", sort: (j) => j.start_local || "", render: (j) => `${esc(fmtDT(j.start_local))}<span class="sub">${esc(relDays(j.start_local))}</span>` },
      { label: "Tech", key: "team", sort: (j) => names(j.team).join(), render: (j) => names(j.team).map((n) => `<span class="badge b-purple">${esc(n)}</span>`).join("") },
      { label: "Address", key: "address" },
      { label: "Total", key: "total_price", right: true, render: (j) => money(j.total_price) },
      { label: "Profit", key: "profit", right: true, render: (j) => num(j.total_cost) ? `<span style="color:${num(j.profit) >= 0 ? "var(--green)" : "var(--red)"}">${money(j.profit)}</span>` : '<span class="muted small">add costs</span>' },
    ] });
  view(`<div class="page-head"><h2>Jobs</h2></div>${tb.html}${t.html}`);
  tb.mount(); t.mount();
};

VIEWS.clients = () => {
  const t = table("clients", { rows: D.clients, search: (c) => [c.name, c.company, c.email, c.phone, c.address, c.serial_id].join(" "),
    onClick: (c) => (location.hash = `#/clients/${c.workiz_id}`),
    cols: [
      { label: "ID", key: "serial_id", render: (c) => `<b>${esc(c.serial_id)}</b>` },
      { label: "Name", key: "name", render: (c) => `${esc(c.name)}<span class="sub">${esc(c.email || "")}</span>` },
      { label: "Company", key: "company" },
      { label: "Address", key: "address" },
      { label: "Phone", key: "phone", render: (c) => esc(phone(c.phone)) },
      { label: "Created", key: "created_local", sort: (c) => c.created_local || "", render: (c) => esc(fmtDate(c.created_local)) },
    ] });
  const pending = D.estimates.filter((e) => /pending/i.test(e.status));
  view(`<div class="page-head"><h2>Clients</h2></div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><span class="label">Clients</span><span class="value num">${D.clients.length}</span></div>
      <div class="card kpi purple"><span class="label">Estimates pending</span><span class="value num">${pending.length}</span><span class="sub">${money(pending.reduce((s, e) => s + num(e.total), 0))}</span></div>
      <div class="card kpi green"><span class="label">Due from clients</span><span class="value num">${money(D.invoices.reduce((s, i) => s + num(i.amount_due), 0))}</span></div>
      <div class="card kpi red"><span class="label">Jobs with balance due</span><span class="value num">${D.jobs.filter((j) => num(j.amount_due) > 0 && !/cancel/i.test(j.status)).length}</span></div>
    </div>${t.html}`);
  t.mount();
};

VIEWS.estimates = () => {
  const st = ["All", "Unsent", "Pending", "Approved", "Declined", "Won", "Archived"];
  const items = st.map((s) => { const r = s === "All" ? D.estimates : D.estimates.filter((e) => e.status === s); return { id: s, label: s, sub: `${r.length} · ${money0(r.reduce((a, e) => a + num(e.total), 0))}` }; });
  const tb = tabs("est", items, () => VIEWS.estimates());
  const rows = D.estimates.filter((e) => tb.active() === "All" || e.status === tb.active());
  const t = table("est", { rows, search: (e) => [e.serial_id, e.name, e.client_name, e.client_email, e.status, e.notes].join(" "),
    onClick: (e) => { const l = D.leads.find((x) => x.workiz_id === e.job_id); const j = D.jobs.find((x) => x.workiz_id === e.job_id); location.hash = l ? `#/leads/${l.workiz_id}` : j ? `#/jobs/${j.workiz_id}` : location.hash; },
    cols: [
      { label: "Estimate", key: "serial_id", render: (e) => `<b>${esc(e.serial_id)}</b><span class="sub">${esc(e.name || "")}</span>` },
      { label: "Client", key: "client_name", render: (e) => `${esc(e.client_name || "—")}<span class="sub">${esc(e.client_email || "")}</span>` },
      { label: "Created", key: "created_local", sort: (e) => e.created_local || "", render: (e) => esc(fmtDT(e.created_local)) },
      { label: "Amount", key: "total", right: true, render: (e) => money(e.total) },
      { label: "Status", key: "status", render: (e) => badge(e.status) },
      { label: "Deposit due", key: "deposit_due", right: true, render: (e) => money(e.deposit_due) },
      { label: "Notes", key: "notes", render: (e) => `<span class="muted small">${esc((e.notes || "").slice(0, 80))}</span>` },
    ] });
  view(`<div class="page-head"><h2>Estimates</h2><div class="spacer"></div><button class="btn primary" id="new-est-any">＋ New estimate</button></div>
    <div class="card" style="margin-bottom:18px"><div class="card-h"><h3>Dashboard estimates</h3><span class="muted small">built here from designer PDFs · click to edit</span></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Design</th><th>Customer</th><th class="right">Your cost</th><th class="right">Price</th><th class="right">Margin</th><th>Status</th><th>Updated</th></tr></thead><tbody id="dash-est"><tr><td colspan="8"><div class="empty">Loading…</div></td></tr></tbody></table></div></div>
    <h3 style="margin:0 0 10px">Workiz estimates</h3>${tb.html}${t.html}`);
  tb.mount(); t.mount();
  $("#new-est-any").onclick = () => openEstimate(null);
  sb.from("design_imports").select("*").order("created_at", { ascending: false }).then(({ data, error }) => {
    const el = $("#dash-est"); if (!el) return;
    if (error) return (el.innerHTML = `<tr><td colspan="8">${esc(error.message)}</td></tr>`);
    el.innerHTML = (data || []).map((d) => {
      const lead = D.leads.find((x) => x.workiz_id === d.lead_id);
      const cost = num(d.materials_cost) + num(d.labor_hours) * num(d.labor_rate) + (d.extras || []).reduce((s, x) => s + num(x.qty) * num(x.unit_cost), 0);
      return `<tr class="click" data-de="${d.id}"><td><b>${d.id}</b></td><td>${esc(d.design_name || "—")}<span class="sub">${(d.parts || []).length} parts${(d.extras || []).length ? ` · ${(d.extras || []).length} add-ons` : ""}</span></td>
        <td>${esc(lead?.client_name || "Not linked yet")}</td><td class="right num">${money(cost)}</td><td class="right num">${money(d.price)}</td>
        <td class="right num">${num(d.price) ? Math.round(((num(d.price) - cost) / num(d.price)) * 100) + "%" : "—"}</td><td>${badge(d.status)}</td><td>${esc(fmtDate(d.created_at))}</td></tr>`;
    }).join("") || `<tr><td colspan="8"><div class="empty">No dashboard estimates yet. Click "New estimate".</div></td></tr>`;
    $$("[data-de]").forEach((tr) => tr.onclick = () => { const d = data.find((x) => String(x.id) === tr.dataset.de); openEstimate(d.lead_id, d); });
  });
};

VIEWS.invoices = () => {
  const due = D.invoices.filter((i) => num(i.amount_due) > 0);
  const invoicedJobs = new Set(D.invoices.map((i) => i.job_id));
  const needInv = D.jobs.filter((j) => /done/i.test(j.status) && !invoicedJobs.has(j.workiz_id) && num(j.total_price) > 0);
  const t = table("inv", { rows: D.invoices, search: (i) => [i.uuid, i.client_name, i.client_email].join(" "),
    onClick: (i) => { if (D.jobs.find((j) => j.workiz_id === i.job_id)) location.hash = `#/jobs/${i.job_id}`; },
    cols: [
      { label: "Invoice", key: "uuid", render: (i) => `<b>${esc(i.uuid)}</b>` },
      { label: "Client", key: "client_name", render: (i) => `${esc(i.client_name || "—")}<span class="sub">${esc(i.client_email || "")}</span>` },
      { label: "Created", key: "created_local", sort: (i) => i.created_local || "", render: (i) => esc(fmtDate(i.created_local)) },
      { label: "Subtotal", key: "sub_total", right: true, render: (i) => money(i.sub_total) },
      { label: "Tax", key: "tax", right: true, render: (i) => money(i.tax) },
      { label: "Amount", key: "amount", right: true, render: (i) => money(i.amount) },
      { label: "Due", key: "amount_due", right: true, render: (i) => money(i.amount_due) },
      { label: "Status", key: "status", render: (i) => `<span class="badge ${i.status === "Paid" ? "b-green" : "b-orange"} dot-s">${esc(i.status)}</span>` },
    ] });
  view(`<div class="page-head"><h2>Invoices</h2><div class="spacer"></div><span class="muted small">Invoices are edited in Workiz (the API can't change them).</span></div>
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><span class="label">Due</span><span class="value num">${money(due.reduce((s, i) => s + num(i.amount_due), 0))}</span><span class="sub">from ${due.length} invoices</span></div>
      <div class="card kpi green"><span class="label">Invoiced total</span><span class="value num">${money0(D.invoices.reduce((s, i) => s + num(i.amount), 0))}</span><span class="sub">${D.invoices.length} invoices</span></div>
      <div class="card kpi purple"><span class="label">Paid</span><span class="value num">${D.invoices.length - due.length}</span></div>
      <div class="card kpi red"><span class="label">Done jobs without an invoice</span><span class="value num">${needInv.length}</span></div>
    </div>${t.html}`);
  t.mount();
};

const needsPermission = (what, perm) => `<div class="notice"><b>${what} isn't connected yet.</b><br/>Your Workiz API key doesn't have access to <b>${perm}</b>. In Workiz go to <b>Settings → Integrations → Developer → v2</b>, edit the "Dashboard" key and set <b>${perm}</b> to <b>Read</b>. It will show up here within 30 minutes.</div>`;
VIEWS.payments = () => {
  const paidJobs = D.jobs.filter((j) => num(j.total_price) > 0 && num(j.amount_due) === 0 && !/cancel/i.test(j.status));
  view(`<div class="page-head"><h2>Payments</h2></div>${needsPermission("Payments", "Payments")}
    <div class="grid g3" style="margin-top:16px">
      <div class="card kpi green"><span class="label">Jobs fully paid</span><span class="value num">${paidJobs.length}</span><span class="sub">${money0(paidJobs.reduce((s, j) => s + num(j.total_price), 0))}</span></div>
      <div class="card kpi"><span class="label">Balance due on jobs</span><span class="value num">${money0(D.jobs.filter((j) => !/cancel/i.test(j.status)).reduce((s, j) => s + num(j.amount_due), 0))}</span></div>
      <div class="card kpi purple"><span class="label">Deposits requested (pending estimates)</span><span class="value num">${money0(D.estimates.filter((e) => /pending/i.test(e.status)).reduce((s, e) => s + num(e.deposit_due), 0))}</span></div>
    </div>`);
};
// ---------- price book (dashboard-owned, from your pricing sheet) ----------
const PB = { items: null, parts: null, settings: null };
async function loadPricing(force = false) {
  if (PB.items && !force) return;
  const [a, b, c] = await Promise.all([
    sb.from("price_book").select("*").order("sheet").order("category").order("name").limit(5000),
    sb.from("part_prices").select("*").order("part_no").limit(5000),
    sb.from("pricing_settings").select("*").eq("id", 1).single(),
  ]);
  if (a.error) throw a.error;
  PB.items = a.data; PB.parts = b.data || []; PB.settings = c.data || { markup_pct: 100, labor_rate: 45 };
}
const sellPrice = (it) => (it.retail != null ? num(it.retail) : num(it.published_price));

VIEWS.pricebook = async () => {
  view(`<div class="empty">Loading price book…</div>`);
  try { await loadPricing(); } catch (e) { return view(`<div class="notice">${esc(e.message)}</div>`); }
  const sheets = ["Part costs", ...new Set(PB.items.map((i) => i.sheet))];
  const tb = tabs("pb", sheets.map((s) => ({ id: s, label: s, sub: s === "Part costs" ? `${PB.parts.length} parts` : `${PB.items.filter((i) => i.sheet === s).length} items` })), () => VIEWS.pricebook());
  const active = tb.active();
  let t;
  if (active === "Part costs") {
    t = table("parts", { rows: PB.parts, search: (p) => [p.part_no, p.description, p.supplier].join(" "),
      cols: [
        { label: "Part #", key: "part_no", render: (p) => `<b>${esc(p.part_no)}</b>` },
        { label: "Description", key: "description" },
        { label: "Supplier", key: "supplier", render: (p) => `<span class="badge ${p.supplier === "Tidy Squares" ? "b-orange" : p.supplier === "Häfele" ? "b-purple" : ""}">${esc(p.supplier || "Other")}</span>` },
        { label: "Your cost (each)", key: "unit_cost", right: true, render: (p) => `<input type="number" step="0.01" min="0" data-part="${esc(p.part_no)}" value="${p.unit_cost ?? ""}" placeholder="enter cost" style="max-width:120px;text-align:right" />` },
        { label: "Updated", key: "updated_at", render: (p) => esc(fmtDate(p.updated_at)) },
      ] });
  } else {
    t = table("pb-" + active, { rows: PB.items.filter((i) => i.sheet === active), search: (i) => [i.name, i.sku, i.category].join(" "),
      cols: [
        { label: "Category", key: "category" },
        { label: "Product", key: "name", render: (i) => `${esc(i.name)}<span class="sub">${esc(i.sku || "")}</span>` },
        { label: "Unit", key: "unit" },
        { label: "Published", key: "published_price", right: true, render: (i) => i.published_price != null ? money(i.published_price) : "—" },
        { label: "Dealer cost", key: "dealer_cost", right: true, render: (i) => `<input type="number" step="0.01" min="0" data-pb="${i.id}" data-f="dealer_cost" value="${i.dealer_cost ?? ""}" style="max-width:110px;text-align:right" />` },
        { label: "Your retail", key: "retail", right: true, render: (i) => `<input type="number" step="0.01" min="0" data-pb="${i.id}" data-f="retail" value="${i.retail ?? ""}" placeholder="${i.published_price ?? ""}" style="max-width:110px;text-align:right" />` },
        { label: "Margin", key: "retail", right: true, sort: (i) => (num(sellPrice(i)) ? (sellPrice(i) - num(i.dealer_cost)) / sellPrice(i) : 0), render: (i) => i.dealer_cost != null && sellPrice(i) ? `${Math.round(((sellPrice(i) - num(i.dealer_cost)) / sellPrice(i)) * 100)}%` : "—" },
      ] });
  }
  view(`<div class="page-head"><h2>Price book</h2><div class="spacer"></div>
      <label style="flex-direction:row;align-items:center;gap:8px">Default markup %<input id="set-markup" type="number" value="${PB.settings.markup_pct}" style="width:90px" /></label>
      <label style="flex-direction:row;align-items:center;gap:8px">Labor $/hr<input id="set-rate" type="number" value="${PB.settings.labor_rate}" style="width:90px" /></label></div>
    <div class="notice" style="margin-bottom:14px">Loaded from your <b>Product Pricing Working Sheet</b>. Those prices are historical (2024–2026), so treat them as <b>test prices</b>. "Your retail" overrides the published price on estimates. <b>Part costs</b> fill in automatically from designer imports: enter a part's cost once and every future design uses it.</div>
    ${tb.html}${t.html}`);
  tb.mount(); t.mount();
  $$("input[data-pb]").forEach((inp) => inp.onchange = async () => {
    const v = inp.value === "" ? null : Number(inp.value);
    const { error } = await sb.from("price_book").update({ [inp.dataset.f]: v, updated_at: new Date().toISOString() }).eq("id", inp.dataset.pb);
    if (error) return toast(error.message, true);
    const it = PB.items.find((x) => String(x.id) === inp.dataset.pb); if (it) it[inp.dataset.f] = v; toast("Saved");
  });
  $$("input[data-part]").forEach((inp) => inp.onchange = async () => {
    const v = inp.value === "" ? null : Number(inp.value);
    const { error } = await sb.from("part_prices").update({ unit_cost: v, updated_at: new Date().toISOString() }).eq("part_no", inp.dataset.part);
    if (error) return toast(error.message, true);
    const p = PB.parts.find((x) => x.part_no === inp.dataset.part); if (p) p.unit_cost = v; toast("Saved");
  });
  const saveSet = async () => {
    const patch = { markup_pct: num($("#set-markup").value), labor_rate: num($("#set-rate").value), updated_at: new Date().toISOString() };
    const { error } = await sb.from("pricing_settings").update(patch).eq("id", 1);
    if (error) return toast(error.message, true); Object.assign(PB.settings, patch); toast("Defaults saved");
  };
  $("#set-markup").onchange = saveSet; $("#set-rate").onchange = saveSet;
};

// ---------- estimate builder ----------
const supplierOf = (pn) => /^(TS|CTP)/i.test(pn) ? "Tidy Squares" : /^\d{3}\.\d{2}\.\d{3}$/.test(pn) ? "Häfele" : "Other";

async function parsePartsPdf(file) {
  const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const parts = new Map(); let designName = ""; const options = {};
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const rows = new Map();
    tc.items.forEach((it) => { if (!it.str.trim()) return; const y = Math.round(it.transform[5] / 2) * 2; if (!rows.has(y)) rows.set(y, []); rows.get(y).push({ x: it.transform[4], s: it.str.trim() }); });
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, cells]) => {
      cells.sort((a, b) => a.x - b.x); const s = cells.map((c) => c.s);
      if (!designName && /\d{1,2}\/\d{1,2}\/\d{4}/.test(s.join(" "))) designName = s[0];
      const opt = s.join(" ").match(/^(Tower Depth|Closet Finish|Base Notch|Closet Rod Profile|Closet Rod Finish|Total Inches of Hanging):\s*(.+)$/);
      if (opt) options[opt[1]] = opt[2];
      if (s.length < 3) return;
      const qty = Number(s[s.length - 1]); const pn = s[s.length - 2];
      if (!Number.isInteger(qty) || qty <= 0 || !/^[A-Z0-9][A-Z0-9.\-]{3,}$/i.test(pn) || !/\d/.test(pn)) return;
      const desc = s.slice(0, -2).join(" ");
      if (/^description$/i.test(desc)) return;
      const cur = parts.get(pn) || { part_no: pn, description: desc, qty: 0, supplier: supplierOf(pn) };
      cur.qty += qty; parts.set(pn, cur);
    });
  }
  return { designName, options, parts: [...parts.values()] };
}

async function openEstimate(leadId, existing = null) {
  await loadPricing();
  let l = D.leads.find((x) => x.workiz_id === leadId) || {};
  const E = existing ? structuredClone(existing) : { lead_id: leadId || null, design_name: "", files: [], parts: [], extras: [], labor_hours: 0, labor_rate: num(PB.settings.labor_rate), markup_pct: num(PB.settings.markup_pct), status: "draft" };
  E.parts ||= []; E.extras ||= []; E.files ||= [];
  // pricing fields (Tidy Squares margin/markup/multiplier method)
  E.multiplier ??= 1 + num(E.markup_pct ?? PB.settings.markup_pct) / 100;
  E.design_includes_parts ??= true;
  E.labor_marked_up ??= false;
  E.freight ??= 0; E.discount_pct ??= 0; E.deposit_pct ??= 50;
  E.tax_pct ??= 7; E.tax_mode ??= "materials";
  const costOf = (pn) => PB.parts.find((p) => p.part_no === pn)?.unit_cost;
  E.parts.forEach((p) => { if (p.unit_cost == null && costOf(p.part_no) != null) p.unit_cost = num(costOf(p.part_no)); });

  const calc = () => {
    const partsCost = E.parts.reduce((s, p) => s + num(p.qty) * num(p.unit_cost), 0);
    const laborCost = num(E.labor_hours) * num(E.labor_rate);
    const systemPrice = (partsCost + laborCost) * (1 + num(E.markup_pct) / 100);
    const extrasPrice = E.extras.reduce((s, x) => s + num(x.qty) * num(x.unit_price), 0);
    const extrasCost = E.extras.reduce((s, x) => s + num(x.qty) * num(x.unit_cost), 0);
    const total = systemPrice + extrasPrice, cost = partsCost + laborCost + extrasCost;
    return { partsCost, laborCost, systemPrice, extrasPrice, extrasCost, total, cost, profit: total - cost, missing: E.parts.filter((p) => p.unit_cost == null || p.unit_cost === "").length };
  };

  const render = () => {
    const c = calc();
    const bySup = ["Tidy Squares", "Häfele", "Other"].map((s) => ({ s, rows: E.parts.filter((p) => p.supplier === s) })).filter((g) => g.rows.length);
    $("#drawer-panel").innerHTML = `
      <div class="d-head"><div><div class="muted small">ESTIMATE ${E.id ? "#" + E.id : "(new)"} · ${esc(l.uuid || "")}</div><h2>${esc(l.client_name || "Estimate")}</h2>
        <div class="muted small">${esc(E.design_name || "No design imported yet")}</div></div><div class="spacer"></div><button class="icon-btn" id="d-close">✕</button></div>
      <div class="form-row" style="margin-bottom:14px"><label class="wide" style="grid-column:span 3">Customer (lead)<input id="e-lead" list="lead-list" placeholder="Type a name to link this estimate to a lead" value="${l.workiz_id ? esc(`${l.client_name} · ${l.uuid} #${l.workiz_id}`) : ""}" /></label>
        <datalist id="lead-list">${D.leads.filter((x) => !x.lost).map((x) => `<option value="${esc(`${x.client_name} · ${x.uuid} #${x.workiz_id}`)}">`).join("")}</datalist>
        <label>Design name<input id="e-name" value="${esc(E.design_name || "")}" /></label></div>

      <div class="profit-box">
        <div><div class="l">Customer price</div><div class="v num">${money(c.total)}</div></div>
        <div><div class="l">Your cost</div><div class="v num">${money(c.cost)}</div></div>
        <div><div class="l">Profit</div><div class="v num ${c.profit >= 0 ? "pos" : "neg"}">${money(c.profit)}</div></div>
        <div><div class="l">Margin</div><div class="v num">${c.total ? Math.round((c.profit / c.total) * 100) + "%" : "—"}</div></div></div>
      ${c.missing ? `<div class="warn" style="margin-top:10px">${c.missing} part${c.missing > 1 ? "s have" : " has"} no cost yet. Enter them below (from your Häfele cart or Tidy Squares invoice); they're remembered for next time.</div>` : ""}

      <div class="d-section"><h3>1 · Import design from the Up Closets designer</h3>
        <label class="dropzone" for="e-files">⇪ Drop or pick the designer PDFs (the "Installation with Elevations" PDF has the parts list). Pick several at once.</label>
        <input id="e-files" type="file" accept=".pdf,image/*" multiple class="hidden" />
        ${E.files.length ? `<div class="muted small" style="margin-top:6px">Files: ${E.files.map((f) => esc(f.name)).join(", ")}</div>` : ""}
        ${E.options && Object.keys(E.options).length ? `<div class="kv" style="margin-top:10px">${Object.entries(E.options).map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join("")}</div>` : ""}</div>

      <div class="d-section"><h3>2 · Closet system parts (your cost)</h3>
        ${bySup.map((g) => `<div class="card" style="margin-bottom:10px"><div class="card-h"><h3>${esc(g.s)}</h3><div class="spacer"></div><span class="muted small num">${money(g.rows.reduce((s, p) => s + num(p.qty) * num(p.unit_cost), 0))}</span></div>
          <div class="table-wrap"><table><thead><tr><th>Part #</th><th>Description</th><th class="right">Qty</th><th class="right">Cost each</th><th class="right">Line</th><th></th></tr></thead><tbody>
          ${g.rows.map((p) => { const i = E.parts.indexOf(p); return `<tr><td><b>${esc(p.part_no)}</b></td><td>${esc(p.description)}</td>
            <td class="right"><input type="number" min="0" step="1" data-pq="${i}" value="${p.qty}" style="width:70px;text-align:right" /></td>
            <td class="right"><input type="number" min="0" step="0.01" data-pc="${i}" value="${p.unit_cost ?? ""}" placeholder="cost?" style="width:100px;text-align:right;${p.unit_cost == null || p.unit_cost === "" ? "border-color:var(--orange)" : ""}" /></td>
            <td class="right num">${money(num(p.qty) * num(p.unit_cost))}</td><td class="right"><button class="btn small danger" data-pdel="${i}">✕</button></td></tr>`; }).join("")}
          </tbody></table></div></div>`).join("") || `<div class="muted small">Import a design above, or add parts by hand:</div>`}
        <div class="form-row" style="margin-top:8px"><label>Part #<input id="np-pn" /></label><label class="wide">Description<input id="np-desc" /></label><label>Qty<input id="np-qty" type="number" value="1" min="1" /></label></div>
        <button class="btn small" id="np-add" style="margin-top:8px">＋ Add part</button>
        ${E.parts.length ? `<button class="btn small" id="e-hafele-csv" style="margin-top:8px">⇩ Häfele cart spreadsheet</button>` : ""}</div>

      <div class="d-section"><h3>3 · Labor & markup</h3>
        <div class="form-row"><label>Install hours<input id="e-hours" type="number" min="0" step="0.5" value="${E.labor_hours}" /></label>
          <label>Labor $/hr<input id="e-rate" type="number" min="0" step="1" value="${E.labor_rate}" /></label>
          <label>Markup %<input id="e-markup" type="number" min="0" step="5" value="${E.markup_pct}" /></label>
          <label>Closet system price<input disabled value="${money(c.systemPrice)}" /></label></div>
        <p class="muted small">System price = (parts ${money(c.partsCost)} + labor ${money(c.laborCost)}) × (1 + markup).</p></div>

      <div class="d-section"><h3>4 · Accessories & add-ons (from your price book)</h3>
        <div class="card"><div class="table-wrap"><table><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price each</th><th class="right">Line</th><th></th></tr></thead><tbody>
        ${E.extras.map((x, i) => `<tr><td>${esc(x.name)}<span class="sub">${esc(x.sku || "")}${x.unit_cost != null ? ` · cost ${money(x.unit_cost)}` : ""}</span></td>
          <td class="right"><input type="number" min="0" data-xq="${i}" value="${x.qty}" style="width:70px;text-align:right" /></td>
          <td class="right"><input type="number" min="0" step="0.01" data-xp="${i}" value="${x.unit_price}" style="width:100px;text-align:right" /></td>
          <td class="right num">${money(num(x.qty) * num(x.unit_price))}</td><td class="right"><button class="btn small danger" data-xdel="${i}">✕</button></td></tr>`).join("") || `<tr><td colspan="5"><div class="empty">No add-ons</div></td></tr>`}
        </tbody></table></div></div>
        <div class="form-row" style="margin-top:8px"><label class="wide" style="grid-column:span 3">Add from price book<input id="x-search" list="pb-list" placeholder="Type to search: tie rack, basket, hook, LED…" /></label>
          <datalist id="pb-list">${PB.items.filter((i) => sellPrice(i) || i.dealer_cost).map((i) => `<option value="${esc(i.name)}${i.sku ? " · " + esc(i.sku) : ""} #${i.id}">`).join("")}</datalist>
          <button class="btn small purple" id="x-add">＋ Add</button></div></div>

      <div class="d-section"><h3>Summary</h3><div class="kv">
        <div>Closet system</div><div class="num">${money(c.systemPrice)}</div>
        <div>Accessories</div><div class="num">${money(c.extrasPrice)}</div>
        <div><b>Total to customer</b></div><div class="num"><b>${money(c.total)}</b></div>
        <div>Deposit (50%)</div><div class="num">${money(c.total / 2)}</div></div></div>

      <div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">
        <button class="btn primary" id="e-save">Save estimate</button>
        <button class="btn" id="e-print">Print / PDF</button>
        <button class="btn" disabled title="Turn on Estimates: Read & Write for the Workiz key first">Send to Workiz (needs Estimates permission)</button>
      </div>`;
    wire();
  };

  const upsertPartPrice = async (p) => {
    if (p.unit_cost == null || p.unit_cost === "") return;
    await sb.from("part_prices").upsert({ part_no: p.part_no, description: p.description, supplier: p.supplier, unit_cost: num(p.unit_cost), updated_at: new Date().toISOString() }, { onConflict: "part_no" });
    const ex = PB.parts.find((x) => x.part_no === p.part_no); if (ex) ex.unit_cost = num(p.unit_cost); else PB.parts.push({ part_no: p.part_no, description: p.description, supplier: p.supplier, unit_cost: num(p.unit_cost) });
  };

  const wire = () => {
    $("#d-close").onclick = () => closeDrawer();
    $("#e-lead").onchange = (ev) => { const m = ev.target.value.match(/#(LD-[\w-]+)$/); const nl = m && D.leads.find((x) => x.workiz_id === m[1]); E.lead_id = nl ? nl.workiz_id : null; l = nl || {}; render(); };
    $("#e-name").onchange = (ev) => { E.design_name = ev.target.value; };
    $("#e-files").onchange = async (ev) => {
      const files = [...ev.target.files]; if (!files.length) return;
      toast(`Reading ${files.length} file(s)…`);
      for (const f of files) {
        const path = `designs/${E.lead_id || "unassigned"}/${Date.now()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
        const up = await sb.storage.from("job-photos").upload(path, f, { contentType: f.type || "application/pdf" });
        E.files.push({ name: f.name, path: up.error ? null : path });
        if (/pdf$/i.test(f.name) || f.type === "application/pdf") {
          try {
            const r = await parsePartsPdf(f);
            if (r.designName && !E.design_name) E.design_name = r.designName;
            if (Object.keys(r.options).length) E.options = { ...(E.options || {}), ...r.options };
            r.parts.forEach((np) => { const cur = E.parts.find((p) => p.part_no === np.part_no); if (cur) cur.qty = Math.max(num(cur.qty), np.qty); else E.parts.push({ ...np, unit_cost: costOf(np.part_no) ?? null }); });
          } catch (e) { toast(`Couldn't read ${f.name}: ${e.message}`, true); }
        }
      }
      // remember every part number (cost may be blank) so it appears in Part costs
      const newParts = E.parts.filter((p) => !PB.parts.find((x) => x.part_no === p.part_no));
      if (newParts.length) { await sb.from("part_prices").upsert(newParts.map((p) => ({ part_no: p.part_no, description: p.description, supplier: p.supplier })), { onConflict: "part_no", ignoreDuplicates: true }); newParts.forEach((p) => PB.parts.push({ part_no: p.part_no, description: p.description, supplier: p.supplier, unit_cost: null })); }
      toast(`Found ${E.parts.length} parts`); render();
    };
    $$("[data-pq]").forEach((i) => i.onchange = () => { E.parts[i.dataset.pq].qty = num(i.value); render(); });
    $$("[data-pc]").forEach((i) => i.onchange = async () => { const p = E.parts[i.dataset.pc]; p.unit_cost = i.value === "" ? null : num(i.value); await upsertPartPrice(p); render(); });
    $$("[data-pdel]").forEach((b) => b.onclick = () => { E.parts.splice(Number(b.dataset.pdel), 1); render(); });
    $("#np-add").onclick = () => { const pn = $("#np-pn").value.trim(); if (!pn) return toast("Enter a part #", true); E.parts.push({ part_no: pn, description: $("#np-desc").value, qty: num($("#np-qty").value) || 1, supplier: supplierOf(pn), unit_cost: costOf(pn) ?? null }); render(); };
    $("#e-hours").onchange = (e) => { E.labor_hours = num(e.target.value); render(); };
    $("#e-rate").onchange = (e) => { E.labor_rate = num(e.target.value); render(); };
    $("#e-markup").onchange = (e) => { E.markup_pct = num(e.target.value); render(); };
    $$("[data-xq]").forEach((i) => i.onchange = () => { E.extras[i.dataset.xq].qty = num(i.value); render(); });
    $$("[data-xp]").forEach((i) => i.onchange = () => { E.extras[i.dataset.xp].unit_price = num(i.value); render(); });
    $$("[data-xdel]").forEach((b) => b.onclick = () => { E.extras.splice(Number(b.dataset.xdel), 1); render(); });
    $("#x-add").onclick = () => {
      const m = $("#x-search").value.match(/#(\d+)$/); const it = m && PB.items.find((i) => String(i.id) === m[1]);
      if (!it) return toast("Pick an item from the list", true);
      E.extras.push({ id: it.id, name: it.name, sku: it.sku, qty: 1, unit_price: sellPrice(it) || num(it.dealer_cost) * (1 + num(E.markup_pct) / 100), unit_cost: it.dealer_cost });
      render();
    };
    const csv = $("#e-hafele-csv");
    if (csv) csv.onclick = () => {
      const rows = E.parts.filter((p) => p.supplier === "Häfele");
      if (!rows.length) return toast("No Häfele parts in this design", true);
      const text = "Item Number,Quantity\n" + rows.map((p) => `${p.part_no},${p.qty}`).join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      a.download = `hafele-${(l.client_name || "design").replace(/\W+/g, "-")}.csv`; a.click();
    };
    $("#e-save").onclick = async () => {
      const c = calc();
      const row = { lead_id: E.lead_id, design_name: E.design_name, options: E.options || null, files: E.files, parts: E.parts, extras: E.extras, labor_hours: E.labor_hours, labor_rate: E.labor_rate, markup_pct: E.markup_pct, materials_cost: c.partsCost, price: c.total, status: "draft" };
      const res = E.id ? await sb.from("design_imports").update(row).eq("id", E.id).select().single() : await sb.from("design_imports").insert(row).select().single();
      if (res.error) return toast(res.error.message, true);
      E.id = res.data.id; toast("Estimate saved"); render();
      if (location.hash.startsWith("#/estimates")) VIEWS.estimates();
    };
    $("#e-print").onclick = () => printEstimate(E, l, calc());
  };
  openDrawer(""); render();
}

function printEstimate(E, l, c) {
  const w = window.open("", "_blank");
  w.document.write(`<!doctype html><html><head><title>Estimate · ${esc(l.client_name || "")}</title><style>
    body{font:14px/1.5 Poppins,Arial,sans-serif;color:#111;max-width:780px;margin:30px auto;padding:0 20px}
    h1{font-size:22px;margin:0} .muted{color:#666} table{width:100%;border-collapse:collapse;margin:14px 0} td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left} .r{text-align:right}
    .tot td{font-weight:700;font-size:16px;border-top:2px solid #111} img{width:200px}</style></head><body>
    <img src="${location.origin}/assets/logo-dark.png" style="background:#111;padding:10px;border-radius:8px" />
    <h1>Estimate</h1><div class="muted">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
    <p><b>${esc(l.client_name || "")}</b><br>${esc(l.address || "")}<br>${esc(phone(l.client_phone))} ${esc(l.client_email || "")}</p>
    <p><b>${esc(E.design_name || "Custom closet")}</b>${E.options ? "<br><span class='muted'>" + Object.entries(E.options).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ") + "</span>" : ""}</p>
    <table><tr><th>Description</th><th class="r">Qty</th><th class="r">Amount</th></tr>
      <tr><td>Custom closet system, designed, supplied and installed</td><td class="r">1</td><td class="r">${money(c.systemPrice)}</td></tr>
      ${E.extras.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${num(x.qty)}</td><td class="r">${money(num(x.qty) * num(x.unit_price))}</td></tr>`).join("")}
      <tr class="tot"><td>Total</td><td></td><td class="r">${money(c.total)}</td></tr>
      <tr><td>Deposit due to schedule (50%)</td><td></td><td class="r">${money(c.total / 2)}</td></tr></table>
    <p class="muted">Up Closets of Rhode Island · rhodeisland@upclosets.com</p><script>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}

VIEWS.reports = () => {
  const done = D.jobs.filter((j) => /done/i.test(j.status));
  const costed = done.filter((j) => num(j.total_cost) > 0);
  const rev = costed.reduce((s, j) => s + num(j.total_price), 0), cost = costed.reduce((s, j) => s + num(j.total_cost), 0);
  const won = D.estimates.filter((e) => /won|approved/i.test(e.status)).length, lost = D.estimates.filter((e) => /declined/i.test(e.status)).length;
  const months = salesSeries("12m");
  const t = table("profit", { rows: done, search: (j) => [j.client_name, j.uuid].join(" "), onClick: (j) => (location.hash = `#/jobs/${j.workiz_id}`),
    cols: [
      { label: "Job", key: "uuid", render: (j) => `<b>${esc(j.uuid)}</b><span class="sub">${esc(fmtDate(j.start_local))}</span>` },
      { label: "Client", key: "client_name" },
      { label: "Price", key: "total_price", right: true, render: (j) => money(j.total_price) },
      { label: "Materials", key: "materials", right: true, render: (j) => money(j.materials) },
      { label: "Labor", key: "labor", right: true, render: (j) => money(j.labor) },
      { label: "Overhead", key: "overhead", right: true, render: (j) => money(j.overhead) },
      { label: "Profit", key: "profit", right: true, render: (j) => num(j.total_cost) ? `<b style="color:${num(j.profit) >= 0 ? "var(--green)" : "var(--red)"}">${money(j.profit)}</b>` : '<span class="muted small">no costs yet</span>' },
      { label: "Margin", key: "profit", right: true, sort: (j) => (num(j.total_price) ? num(j.profit) / num(j.total_price) : 0), render: (j) => num(j.total_cost) && num(j.total_price) ? `${Math.round((num(j.profit) / num(j.total_price)) * 100)}%` : "—" },
    ] });
  view(`<div class="page-head"><h2>Reports & profit</h2></div>
    <div class="grid g4">
      <div class="card kpi"><span class="label">Revenue (done jobs)</span><span class="value num">${money0(done.reduce((s, j) => s + num(j.total_price), 0))}</span><span class="sub">${done.length} jobs</span></div>
      <div class="card kpi green"><span class="label">Average margin</span><span class="value num">${costed.length ? Math.round(((rev - cost) / rev) * 100) + "%" : "—"}</span><span class="sub">on ${costed.length} jobs with costs</span></div>
      <div class="card kpi purple"><span class="label">Estimate win rate</span><span class="value num">${won + lost ? Math.round((won / (won + lost)) * 100) + "%" : "—"}</span><span class="sub">${won} won/approved · ${lost} declined</span></div>
      <div class="card kpi"><span class="label">Average job size</span><span class="value num">${done.length ? money0(done.reduce((s, j) => s + num(j.total_price), 0) / done.length) : "—"}</span></div>
    </div>
    <div class="grid g3" style="margin-top:16px">
      <div class="card span2"><div class="card-h"><h3>Revenue by month</h3></div><div class="card-b">${barChart(months, { color: "var(--purple)" })}</div></div>
      <div class="card"><div class="card-h"><h3>Revenue by tech</h3></div><div class="card-b">${hbars(sumBy(done, (j) => names(j.team), (j) => num(j.total_price)), money0)}</div></div>
      <div class="card"><div class="card-h"><h3>Leads by source</h3></div><div class="card-b">${hbars(countBy(D.leads, (l) => l.source).slice(0, 8))}</div></div>
      <div class="card"><div class="card-h"><h3>Leads by status</h3></div><div class="card-b">${hbars(countBy(D.leads, (l) => l.status).slice(0, 8))}</div></div>
      <div class="card"><div class="card-h"><h3>Jobs by type</h3></div><div class="card-b">${donut(countBy(D.jobs, (j) => j.job_type))}</div></div>
    </div>
    <h3 style="margin:22px 0 10px">Profit per job</h3>${t.html}`);
  t.mount();
};

VIEWS.search = () => {
  const q = (tblState.globalQ || "").toLowerCase();
  const hit = (s) => String(s || "").toLowerCase().includes(q);
  const jobs = D.jobs.filter((j) => [j.client_name, j.uuid, j.address, j.client_phone].some(hit)).slice(0, 15);
  const leads = D.leads.filter((l) => [l.client_name, l.uuid, l.address, l.client_phone].some(hit)).slice(0, 15);
  const clients = D.clients.filter((c) => [c.name, c.email, c.phone, c.address].some(hit)).slice(0, 15);
  const block = (title, rows, href, line) => `<div class="card"><div class="card-h"><h3>${title}</h3><span class="muted small">${rows.length}</span></div><div class="card-b feed">${rows.map((r) => `<a href="${href(r)}" style="color:inherit">${line(r)}</a>`).join("") || '<div class="empty">No matches</div>'}</div></div>`;
  view(`<div class="page-head"><h2>Search: “${esc(tblState.globalQ)}”</h2></div><div class="grid g3">
    ${block("Clients", clients, (c) => `#/clients/${c.workiz_id}`, (c) => `${esc(c.name)} <span class="muted small">${esc(c.address || "")}</span>`)}
    ${block("Leads", leads, (l) => `#/leads/${l.workiz_id}`, (l) => `${esc(l.client_name)} ${badge(l.status)}`)}
    ${block("Jobs", jobs, (j) => `#/jobs/${j.workiz_id}`, (j) => `${esc(j.client_name)} ${badge(j.status)} <span class="muted small">${esc(j.uuid)}</span>`)}</div>`);
};

// ---------- drawer: job ----------
const CLOSET_TYPES = ["Walk-in", "Reach-in", "Pantry", "Garage", "Laundry", "Home office", "Entertainment / media", "Murphy bed", "Mudroom", "Other"];
function openDrawer(html) { $("#drawer-panel").innerHTML = html; $("#drawer").classList.remove("hidden"); }
function closeDrawer(updateHash = true) { $("#drawer").classList.add("hidden"); if (updateHash) { const page = location.hash.slice(2).split("/")[0]; if (location.hash.split("/").length > 2) history.replaceState(null, "", `#/${page}`); } }

async function openJob(id) {
  const j = D.jobs.find((x) => x.workiz_id === id);
  if (!j) return toast("Job not found", true);
  const [{ data: costs }, { data: photos }] = await Promise.all([
    sb.from("job_costs").select("*").eq("job_id", id).order("created_at"),
    sb.from("job_photos").select("*").eq("job_id", id).order("created_at"),
  ]);
  const signed = await Promise.all((photos || []).map(async (p) => ({ ...p, url: (await sb.storage.from("job-photos").createSignedUrl(p.storage_path, 3600)).data?.signedUrl })));
  const price = num(j.total_price), total = (costs || []).reduce((s, c) => s + num(c.total), 0), profit = price - total;
  const notes = Array.isArray(j.workiz_notes) ? j.workiz_notes : [];
  const items = Array.isArray(j.line_items) ? j.line_items : [];
  const rateOpts = D.crew.filter((c) => c.active).map((c) => `<option value="${esc(c.dash_hourly_rate ?? "")}" data-name="${esc(c.name)}">${esc(c.name)}${c.dash_hourly_rate ? ` · $${c.dash_hourly_rate}/hr` : ""}</option>`).join("");
  openDrawer(`
    <div class="d-head"><div><div class="muted small">JOB ${esc(j.uuid)} · #${esc(j.serial_id)}</div><h2>${esc(j.client_name)}</h2><div style="margin-top:6px">${badge(j.status)} ${j.sub_status ? `<span class="badge">${esc(j.sub_status)}</span>` : ""} ${tagBadges(j.tags)}</div></div>
      <div class="spacer"></div><a class="btn small" href="${workizJobUrl(j.uuid)}" target="_blank" rel="noopener">Open in Workiz ↗</a><button class="icon-btn" id="d-close">✕</button></div>

    <div class="d-section"><h3>Profit</h3><div class="profit-box">
      <div><div class="l">Price</div><div class="v num">${money(price)}</div></div>
      <div><div class="l">Costs</div><div class="v num">${money(total)}</div></div>
      <div><div class="l">Profit</div><div class="v num ${profit >= 0 ? "pos" : "neg"}">${money(profit)}</div></div>
      <div><div class="l">Margin</div><div class="v num">${price ? Math.round((profit / price) * 100) + "%" : "—"}</div></div></div></div>

    <div class="d-section"><h3>Details</h3><div class="kv">
      <div>Scheduled</div><div>${esc(fmtDT(j.start_local))} ${j.end_local ? "– " + esc(fmtTime(j.end_local)) : ""} <span class="muted small">${esc(relDays(j.start_local))}</span></div>
      <div>Address</div><div>${j.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(j.address)}" target="_blank" rel="noopener">${esc(j.address)}</a>` : "—"}</div>
      <div>Phone</div><div>${j.client_phone ? `<a href="tel:${esc(j.client_phone)}">${esc(phone(j.client_phone))}</a>` : "—"}</div>
      <div>Email</div><div>${esc(j.client_email || "—")}</div>
      <div>Job type</div><div>${esc(j.job_type || "—")}</div>
      <div>Crew</div><div>${names(j.team).map((n) => `<span class="badge b-purple">${esc(n)}</span>`).join("") || "—"}</div>
      <div>Source</div><div>${esc(j.source || "—")}</div>
      <div>Balance due</div><div class="num">${money(j.amount_due)}</div>
      <div>Description</div><div style="white-space:pre-wrap">${esc(j.description || "—")}</div></div></div>

    <div class="d-section"><h3>Closet details <span class="muted small">(dashboard only)</span></h3>
      <div class="form-row"><label class="wide">Closet type<select id="f-type"><option value="">—</option>${CLOSET_TYPES.map((t) => `<option ${t === j.dash_closet_type ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
      <label style="margin-top:10px">Measurements<textarea id="f-meas" rows="3" placeholder="e.g. Back wall 96&quot;, left 60&quot;, right 60&quot;, ceiling 96&quot;">${esc(j.dash_measurements || "")}</textarea></label>
      <label style="margin-top:10px">Notes<textarea id="f-notes" rows="2">${esc(j.dash_notes || "")}</textarea></label>
      <div style="margin-top:10px"><button class="btn primary small" id="f-save">Save details</button></div></div>

    <div class="d-section"><h3>Job costs</h3>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Type</th><th>Description</th><th class="right">Hours × rate</th><th class="right">Amount</th><th></th></tr></thead><tbody>
      ${(costs || []).map((c) => `<tr><td>${badge(c.kind)}</td><td>${esc(c.description || "")}</td><td class="right num">${c.kind === "labor" ? `${num(c.hours)} × ${money(c.rate)}` : ""}</td><td class="right num">${money(c.total)}</td><td class="right"><button class="btn small danger" data-del="${c.id}">Remove</button></td></tr>`).join("") || `<tr><td colspan="5"><div class="empty">No costs yet. Add materials, labor and overhead below.</div></td></tr>`}
      </tbody></table></div></div>
      <div class="form-row" style="margin-top:12px">
        <label>Type<select id="c-kind"><option value="materials">Materials</option><option value="labor">Labor</option><option value="overhead">Overhead</option><option value="other">Other</option></select></label>
        <label class="wide">Description<input id="c-desc" placeholder="e.g. Melamine panels, hardware" /></label>
        <label id="c-amt-wrap">Amount ($)<input id="c-amt" type="number" min="0" step="0.01" /></label>
      </div>
      <div class="form-row hidden" id="c-labor" style="margin-top:10px">
        <label class="wide">Crew member<select id="c-crew"><option value="">Pick to fill rate…</option>${rateOpts}</select></label>
        <label>Hours<input id="c-hours" type="number" min="0" step="0.25" /></label>
        <label>Rate ($/hr)<input id="c-rate" type="number" min="0" step="0.5" /></label>
      </div>
      <div style="margin-top:10px"><button class="btn purple small" id="c-add">＋ Add cost</button></div></div>

    <div class="d-section"><h3>Photos</h3>
      <label class="dropzone" for="p-file">📷 Click to add photos (before / during / after)</label><input id="p-file" type="file" accept="image/*" multiple class="hidden" />
      <div class="photos" style="margin-top:10px">${signed.map((p) => `<figure><a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="" loading="lazy" /></a><figcaption>${esc(p.caption || fmtDate(p.created_at))}</figcaption></figure>`).join("")}</div>
      <p class="muted small">Photos are stored privately in your dashboard. Sending them to the Workiz job comes in the two-way sync step.</p></div>

    ${items.length ? `<div class="d-section"><h3>Line items (from Workiz)</h3><div class="card"><div class="table-wrap"><table><thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Price</th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.name ?? i.title ?? "")}<span class="sub">${esc(i.description ?? "")}</span></td><td class="right num">${esc(i.quantity ?? i.qty ?? "")}</td><td class="right num">${money(i.price ?? i.total ?? 0)}</td></tr>`).join("")}</tbody></table></div></div></div>` : ""}
    <div class="d-section"><h3>Workiz notes</h3>${notes.map((n) => `<div class="note">${esc(n.text ?? n.note ?? n.content ?? JSON.stringify(n))}<div class="muted small">${esc(n.createdBy?.name ?? n.user ?? "")} ${esc(fmtDT(n.createdAt ?? n.created ?? n.date))}</div></div>`).join("") || '<div class="muted small">No notes</div>'}</div>`);

  $("#d-close").onclick = () => closeDrawer();
  $("#f-save").onclick = async () => {
    const patch = { dash_closet_type: $("#f-type").value || null, dash_measurements: $("#f-meas").value || null, dash_notes: $("#f-notes").value || null };
    const { error } = await sb.from("jobs").update(patch).eq("workiz_id", id);
    if (error) return toast(error.message, true);
    Object.assign(j, patch); toast("Saved");
  };
  const kindSel = $("#c-kind");
  kindSel.onchange = () => { const lab = kindSel.value === "labor"; $("#c-labor").classList.toggle("hidden", !lab); $("#c-amt-wrap").classList.toggle("hidden", lab); };
  $("#c-crew").onchange = (e) => { if (e.target.value) $("#c-rate").value = e.target.value; if (!$("#c-desc").value) $("#c-desc").value = e.target.selectedOptions[0]?.dataset.name ?? ""; };
  $("#c-add").onclick = async () => {
    const kind = kindSel.value;
    const row = { job_id: id, kind, description: $("#c-desc").value || null };
    if (kind === "labor") { row.hours = num($("#c-hours").value); row.rate = num($("#c-rate").value); if (!row.hours || !row.rate) return toast("Enter hours and rate", true); }
    else { row.amount = num($("#c-amt").value); if (!row.amount) return toast("Enter an amount", true); }
    const { error } = await sb.from("job_costs").insert(row);
    if (error) return toast(error.message, true);
    toast("Cost added"); await refreshJob(id);
  };
  $$("[data-del]").forEach((b) => b.onclick = async () => {
    const { error } = await sb.from("job_costs").delete().eq("id", b.dataset.del);
    if (error) return toast(error.message, true);
    await refreshJob(id);
  });
  $("#p-file").onchange = async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    toast(`Uploading ${files.length} photo(s)…`);
    for (const f of files) {
      const path = `${id}/${Date.now()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
      const up = await sb.storage.from("job-photos").upload(path, f, { contentType: f.type });
      if (up.error) { toast(up.error.message, true); continue; }
      await sb.from("job_photos").insert({ job_id: id, storage_path: path, caption: f.name });
    }
    toast("Photos added"); openJob(id);
  };
}
async function refreshJob(id) {
  const { data } = await sb.from("v_jobs").select("*").eq("workiz_id", id).single();
  if (data) { const i = D.jobs.findIndex((x) => x.workiz_id === id); D.jobs[i] = data; }
  openJob(id);
}

// ---------- drawer: lead ----------
function openLead(id) {
  const l = D.leads.find((x) => x.workiz_id === id);
  if (!l) return toast("Lead not found", true);
  const ests = D.estimates.filter((e) => e.job_id === id);
  openDrawer(`
    <div class="d-head"><div><div class="muted small">LEAD ${esc(l.uuid)} · #${esc(l.serial_id)}</div><h2>${esc(l.client_name)}</h2><div style="margin-top:6px">${badge(l.status)} ${tagBadges(l.tags)}</div></div>
      <div class="spacer"></div><a class="btn small" href="${workizLeadUrl(l.uuid)}" target="_blank" rel="noopener">Open in Workiz ↗</a><button class="icon-btn" id="d-close">✕</button></div>
    <div class="d-section"><h3>Details</h3><div class="kv">
      <div>Appointment</div><div>${esc(fmtDT(l.start_local))} <span class="muted small">${esc(relDays(l.start_local))}</span></div>
      <div>Address</div><div>${l.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(l.address)}" target="_blank" rel="noopener">${esc(l.address)}</a>` : "—"}</div>
      <div>Phone</div><div>${l.client_phone ? `<a href="tel:${esc(l.client_phone)}">${esc(phone(l.client_phone))}</a>` : "—"}</div>
      <div>Email</div><div>${esc(l.client_email || "—")}</div>
      <div>Type</div><div>${esc(l.job_type || "—")}</div>
      <div>Source</div><div>${esc(l.source || "—")}</div>
      <div>Assigned</div><div>${names(l.team).map((n) => `<span class="badge b-purple">${esc(n)}</span>`).join("") || "—"}</div>
      <div>Created</div><div>${esc(fmtDT(l.created_local))}</div>
      <div>Description</div><div style="white-space:pre-wrap">${esc(l.description || "—")}</div></div></div>
    <div class="d-section"><h3>Closet details <span class="muted small">(dashboard only)</span></h3>
      <div class="form-row"><label class="wide">Closet type<select id="f-type"><option value="">—</option>${CLOSET_TYPES.map((t) => `<option ${t === l.dash_closet_type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="wide">Estimated price ($)<input id="f-price" type="number" min="0" step="1" value="${esc(l.dash_estimated_price ?? "")}" /></label></div>
      <label style="margin-top:10px">Measurements<textarea id="f-meas" rows="3">${esc(l.dash_measurements || "")}</textarea></label>
      <label style="margin-top:10px">Notes<textarea id="f-notes" rows="2">${esc(l.dash_notes || "")}</textarea></label>
      <div style="margin-top:10px"><button class="btn primary small" id="f-save">Save details</button></div></div>
    <div class="d-section"><h3>Estimates</h3>${ests.map((e) => `<div class="note">${badge(e.status)} <b>${esc(e.serial_id)}</b> · ${money(e.total)} <span class="muted small">· ${esc(fmtDate(e.created_local))}</span>${e.notes ? `<div class="muted small">${esc(e.notes)}</div>` : ""}</div>`).join("") || '<div class="muted small">No estimates yet</div>'}
      <h3 style="margin-top:14px">Dashboard estimates</h3><div id="lead-drafts" class="muted small">Loading…</div>
      <button class="btn primary small" id="new-est" style="margin-top:8px">＋ New estimate (import design)</button></div>`);
  $("#d-close").onclick = () => closeDrawer();
  $("#new-est").onclick = () => openEstimate(id);
  sb.from("design_imports").select("*").eq("lead_id", id).order("created_at", { ascending: false }).then(({ data }) => {
    const el = $("#lead-drafts"); if (!el) return;
    el.innerHTML = (data || []).map((d) => `<a class="note" style="display:block;color:inherit;cursor:pointer" data-draft="${d.id}">${badge(d.status)} <b>${esc(d.design_name || "Estimate")}</b> · ${money(d.price)} <span class="muted small">· ${esc(fmtDate(d.created_at))}</span></a>`).join("") || "None yet";
    $$("[data-draft]").forEach((a) => a.onclick = () => openEstimate(id, data.find((d) => String(d.id) === a.dataset.draft)));
  });
  $("#f-save").onclick = async () => {
    const patch = { workiz_id: id, dash_closet_type: $("#f-type").value || null, dash_measurements: $("#f-meas").value || null, dash_notes: $("#f-notes").value || null, dash_estimated_price: $("#f-price").value === "" ? null : Number($("#f-price").value) };
    const { error } = await sb.from("leads").upsert(patch, { onConflict: "workiz_id" });
    if (error) return toast(error.message, true);
    Object.assign(l, patch); toast("Saved");
  };
}

function openClient(id) {
  const c = D.clients.find((x) => x.workiz_id === id);
  if (!c) return toast("Client not found", true);
  const nm = (c.name || "").toLowerCase();
  const jobs = D.jobs.filter((j) => j.raw_client_id === id || (j.client_name || "").toLowerCase() === nm);
  const leads = D.leads.filter((l) => (l.client_name || "").toLowerCase() === nm);
  const ests = D.estimates.filter((e) => e.client_id === id);
  openDrawer(`<div class="d-head"><div><div class="muted small">CLIENT #${esc(c.serial_id)}</div><h2>${esc(c.name)}</h2></div><div class="spacer"></div><button class="icon-btn" id="d-close">✕</button></div>
    <div class="d-section"><div class="kv"><div>Phone</div><div>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(phone(c.phone))}</a>` : "—"}</div><div>Email</div><div>${esc(c.email || "—")}</div><div>Address</div><div>${esc(c.address || "—")}</div><div>Client since</div><div>${esc(fmtDate(c.created_local))}</div></div>
    <p class="muted small">Client details are edited in Workiz (the API can't change clients).</p></div>
    <div class="d-section"><h3>Leads</h3>${leads.map((l) => `<a class="note" style="display:block;color:inherit" href="#/leads/${esc(l.workiz_id)}">${badge(l.status)} ${esc(l.uuid)} · ${esc(fmtDate(l.start_local))}</a>`).join("") || '<div class="muted small">None</div>'}</div>
    <div class="d-section"><h3>Jobs</h3>${jobs.map((j) => `<a class="note" style="display:block;color:inherit" href="#/jobs/${esc(j.workiz_id)}">${badge(j.status)} ${esc(j.uuid)} · ${money(j.total_price)} · ${esc(fmtDate(j.start_local))}</a>`).join("") || '<div class="muted small">None</div>'}</div>
    <div class="d-section"><h3>Estimates</h3>${ests.map((e) => `<div class="note">${badge(e.status)} ${esc(e.serial_id)} · ${money(e.total)}</div>`).join("") || '<div class="muted small">None</div>'}</div>`);
  $("#d-close").onclick = () => closeDrawer();
}

// ---------- new lead -> Workiz ----------
function openNewLead() {
  const d = addDays(new Date(), 1);
  $("#modal-card").innerHTML = `<h3>New lead → Workiz</h3>
    <div class="grid g2">
      <label class="span2">Customer name *<input id="n-name" required /></label>
      <label>Phone<input id="n-phone" type="tel" /></label>
      <label>Email<input id="n-email" type="email" /></label>
      <label class="span2">Address<input id="n-addr" placeholder="Street, city, zip" /></label>
      <label>Date *<input id="n-date" type="date" value="${dayKey(d)}" /></label>
      <label>Time *<input id="n-time" type="time" value="09:00" /></label>
      <label>Length<select id="n-dur"><option value="60">1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="180">3 hours</option></select></label>
      <label>Closet type<select id="n-type"><option value="">—</option>${CLOSET_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></label>
      <label class="span2">Notes<textarea id="n-desc" rows="2"></textarea></label>
    </div>
    <div class="warn" style="margin-top:14px">This creates a <b>real lead in Workiz</b> and puts the appointment on your Workiz calendar. It never changes or deletes anything already in Workiz. If the same phone and time were already booked, it's skipped.</div>
    <div class="modal-actions"><button class="btn ghost" id="n-cancel">Cancel</button><button class="btn primary" id="n-send">Create lead in Workiz</button></div>`;
  $("#modal").classList.remove("hidden");
  $("#n-cancel").onclick = () => $("#modal").classList.add("hidden");
  $("#n-send").onclick = async () => {
    const name = $("#n-name").value.trim(); const date = $("#n-date").value, time = $("#n-time").value;
    if (!name || !date || !time) return toast("Name, date and time are required", true);
    const when = new Date(`${date}T${time}:00`);
    const type = $("#n-type").value;
    const btn = $("#n-send"); btn.disabled = true; btn.textContent = "Sending…";
    const { data, error } = await sb.functions.invoke("booking-to-workiz", { body: {
      source: "dashboard", client_name: name, phone: $("#n-phone").value, email: $("#n-email").value, address: $("#n-addr").value,
      appointment_at: when.toISOString(), duration_minutes: Number($("#n-dur").value),
      description: [type ? `Closet type: ${type}` : null, $("#n-desc").value || null, "Created from Up Closets dashboard"].filter(Boolean).join("\n") } });
    btn.disabled = false; btn.textContent = "Create lead in Workiz";
    if (error || !data?.ok) return toast(`Workiz didn't accept it: ${error?.message || JSON.stringify(data?.workiz ?? data).slice(0, 160)}`, true);
    $("#modal").classList.add("hidden");
    toast(data.duplicate ? "Already booked, so it was skipped" : "Lead created in Workiz ✓");
    syncNow();
  };
}

// ---------- sync / auth ----------
async function syncNow() {
  const today = new Date(), from = addDays(today, -3), to = addDays(today, 1);
  const win = `${dayKey(from)}_${dayKey(to)}`;
  toast("Checking Workiz for changes…");
  await Promise.allSettled([
    sb.functions.invoke(`workiz-pull-jobs?dateProperty=utcUpdated&dateOperator=between&date=${win}`),
    sb.functions.invoke(`workiz-pull?entity=leads&dateProperty=utcUpdated&dateOperator=between&date=${win}`),
  ]);
  await reload(); toast("Up to date with Workiz");
}
async function reload() { try { await loadAll(); route(); } catch (e) { toast(e.message || String(e), true); } }

async function start(session) {
  if (!session) { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); return; }
  D.user = session.user;
  const { data: ok } = await sb.rpc("is_staff");
  if (!ok) { $("#login-msg").textContent = `${session.user.email} isn't on the approved list. Ask the owner to add you.`; await sb.auth.signOut(); return; }
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#user-chip").textContent = (session.user.email || "?").slice(0, 2).toUpperCase();
  $("#user-chip").title = `${session.user.email}. Click to sign out`;
  view(`<div class="empty">Loading your Workiz data…</div>`);
  await reload();
}

$("#login-form").onsubmit = async (e) => {
  e.preventDefault(); $("#login-msg").textContent = "Signing in…";
  const { data, error } = await sb.auth.signInWithPassword({ email: $("#login-email").value.trim(), password: $("#login-password").value });
  if (error) return ($("#login-msg").textContent = error.message);
  $("#login-msg").textContent = ""; start(data.session);
};
$("#signup-btn").onclick = async () => {
  const email = $("#login-email").value.trim(), password = $("#login-password").value;
  if (!email || password.length < 8) return ($("#login-msg").textContent = "Enter your email and a password of at least 8 characters, then click this again.");
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
  if (error) return ($("#login-msg").textContent = error.message);
  if (data.session) return start(data.session);
  $("#login-msg").textContent = "Check your email and click the confirmation link, then sign in here.";
};
$("#user-chip").onclick = async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); };
$("#refresh-btn").onclick = syncNow;
$("#create-lead-btn").onclick = openNewLead;
$("#menu-btn").onclick = () => $("#sidebar").classList.toggle("open");
$("#drawer").onclick = (e) => { if (e.target.id === "drawer") closeDrawer(); };
$("#modal").onclick = (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("#modal").classList.add("hidden"); } });
$("#global-search").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.value.trim()) { tblState.globalQ = e.target.value.trim(); location.hash = "#/search"; } });
PAGES.push({ id: "search", label: "Search", hidden: true });
window.addEventListener("hashchange", () => D.user && route());

sb.auth.getSession().then(({ data }) => start(data.session));
sb.auth.onAuthStateChange((evt, session) => { if (evt === "SIGNED_OUT") start(null); });

// ---------- marketing ----------
const BOOKING_URL = "https://online-booking.workiz.com/?ac=69b0655abea585780d5fb50433b1ee519c29308a27fddb6f20470eff1f241a6e";
const WEBSITE_URL = "https://upclosets.com/rhode-island/";
function channelOf(src) {
  const s = String(src || "").trim();
  if (!s) return "Unknown (no source)";
  if (/facebook|instagram|\bfb\b|\big\b|meta/i.test(s)) return "Facebook / Instagram";
  if (/lsa|local services/i.test(s)) return "Google LSA";
  if (/google/i.test(s)) return "Google";
  if (/serv/i.test(s)) return "Serv";
  if (/word|referr|partner|realtor/i.test(s)) return "Referral / word of mouth";
  if (/home ?show/i.test(s)) return "Home show";
  if (/yard|door|nextdoor|neighbor/i.test(s)) return "Yard signs / neighborhood";
  if (/website|online booking|web/i.test(s)) return "Website / online booking";
  if (/home ?advisor|angi/i.test(s)) return "HomeAdvisor / Angi";
  return s;
}
const MK = { tab: "overview", period: "year" };

async function viewMarketing() {
  view(`<div class="empty">Loading marketing…</div>`);
  const [{ data: spend, error: e1 }, { data: camps, error: e2 }] = await Promise.all([
    sb.from("marketing_spend").select("*").order("month", { ascending: false }),
    sb.from("campaigns").select("*").order("sort").order("id"),
  ]);
  if (e1 || e2) return view(`<div class="notice">${esc((e1 || e2).message)}</div>`);
  const tabsHtml = [["overview", "Results"], ["campaigns", "Campaigns"], ["spend", "Ad spend"], ["links", "Links & tracking"]]
    .map(([id, l]) => `<div class="tab ${MK.tab === id ? "active" : ""}" data-mk="${id}" style="min-width:120px;text-align:left"><div class="t">${l}</div></div>`).join("");
  const head = `<div class="page-head"><h2>Marketing</h2><div class="spacer"></div><button class="btn primary" id="mk-new-lead">＋ New lead</button></div><div class="tabs">${tabsHtml}</div>`;
  const body = { overview: mkOverview, campaigns: mkCampaigns, spend: mkSpend, links: mkLinks }[MK.tab](spend, camps);
  view(head + body.html);
  $$("[data-mk]").forEach((t) => t.onclick = () => { MK.tab = t.dataset.mk; viewMarketing(); });
  $("#mk-new-lead").onclick = openNewLead;
  body.mount?.();
}

function mkPeriodStart() {
  const t = startOfDay();
  return { month: new Date(t.getFullYear(), t.getMonth(), 1), "90d": addDays(t, -90), year: new Date(t.getFullYear(), 0, 1), all: new Date(2000, 0, 1) }[MK.period];
}

function mkOverview(spend) {
  const since = mkPeriodStart();
  const leads = D.leads.filter((l) => toDate(l.created_local) >= since);
  const estByLead = new Map(); D.estimates.forEach((e) => { if (!estByLead.has(e.job_id)) estByLead.set(e.job_id, []); estByLead.get(e.job_id).push(e); });
  const rows = new Map();
  const bump = (key, sub, l) => {
    if (!rows.has(key)) rows.set(key, { channel: key, subs: new Map(), leads: 0, consults: 0, estimates: 0, won: 0, wonValue: 0, spend: 0 });
    const r = rows.get(key);
    const targets = [r]; if (sub && sub !== key) { if (!r.subs.has(sub)) r.subs.set(sub, { channel: sub, leads: 0, consults: 0, estimates: 0, won: 0, wonValue: 0, spend: 0 }); targets.push(r.subs.get(sub)); }
    const es = estByLead.get(l.workiz_id) || [];
    const wonE = es.filter((e) => /won|approved/i.test(e.status));
    const isWon = wonE.length > 0 || /sold/i.test(l.status || "");
    targets.forEach((t) => { t.leads++; if (l.start_local) t.consults++; if (es.length) t.estimates++; if (isWon) { t.won++; t.wonValue += Math.max(0, ...wonE.map((e) => num(e.total))); } });
  };
  leads.forEach((l) => bump(channelOf(l.source), l.source, l));
  spend.filter((s) => toDate(s.month + " 00:00:00") >= new Date(since.getFullYear(), since.getMonth(), 1)).forEach((s) => {
    const key = channelOf(s.channel);
    if (!rows.has(key)) rows.set(key, { channel: key, subs: new Map(), leads: 0, consults: 0, estimates: 0, won: 0, wonValue: 0, spend: 0 });
    const r = rows.get(key); r.spend += num(s.amount);
    if (s.channel !== key) { if (!r.subs.has(s.channel)) r.subs.set(s.channel, { channel: s.channel, leads: 0, consults: 0, estimates: 0, won: 0, wonValue: 0, spend: 0 }); r.subs.get(s.channel).spend += num(s.amount); }
  });
  const list = [...rows.values()].sort((a, b) => b.leads - a.leads);
  const tot = list.reduce((t, r) => ({ leads: t.leads + r.leads, est: t.est + r.estimates, won: t.won + r.won, val: t.val + r.wonValue, spend: t.spend + r.spend }), { leads: 0, est: 0, won: 0, val: 0, spend: 0 });
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
  const per = (a, b) => (b ? money0(a / b) : "—");
  const line = (r, sub = false) => `<tr ${sub ? 'style="color:var(--muted)"' : ""}><td>${sub ? "&nbsp;&nbsp;↳ " : "<b>"}${esc(r.channel)}${sub ? "" : "</b>"}</td>
    <td class="right num">${r.leads}</td><td class="right num">${r.consults}</td><td class="right num">${r.estimates}</td><td class="right num">${r.won}</td>
    <td class="right num">${pct(r.won, r.leads)}</td><td class="right num">${money0(r.wonValue)}</td><td class="right num">${r.spend ? money0(r.spend) : "—"}</td>
    <td class="right num">${r.spend ? per(r.spend, r.leads) : "—"}</td><td class="right num">${r.spend ? per(r.spend, r.won) : "—"}</td>
    <td class="right num">${r.spend ? (r.wonValue / r.spend).toFixed(1) + "×" : "—"}</td></tr>`;
  const months = Array.from({ length: 12 }, (_, i) => { const t = startOfDay(); const m = new Date(t.getFullYear(), t.getMonth() - 11 + i, 1);
    const v = D.leads.filter((l) => { const d = toDate(l.created_local); return d && d.getFullYear() === m.getFullYear() && d.getMonth() === m.getMonth(); }).length;
    return { label: m.toLocaleDateString("en-US", { month: "long", year: "numeric" }), short: m.toLocaleDateString("en-US", { month: "short" }), v }; });
  const unknown = leads.filter((l) => !l.source).length;
  return { html: `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px"><span class="muted small">Period</span>
      <select class="pill-select" id="mk-period">${[["month", "This month"], ["90d", "Last 90 days"], ["year", "This year"], ["all", "All time"]].map(([v, l]) => `<option value="${v}" ${MK.period === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="grid g4">
      <div class="card kpi"><span class="label">Leads</span><span class="value num">${tot.leads}</span><span class="sub">${unknown} with no source tagged</span></div>
      <div class="card kpi purple"><span class="label">Estimates sent</span><span class="value num">${tot.est}</span><span class="sub">${pct(tot.est, tot.leads)} of leads</span></div>
      <div class="card kpi green"><span class="label">Sold</span><span class="value num">${tot.won}</span><span class="sub">${pct(tot.won, tot.leads)} close rate · ${money0(tot.val)}</span></div>
      <div class="card kpi"><span class="label">Ad spend</span><span class="value num">${tot.spend ? money0(tot.spend) : "—"}</span><span class="sub">${tot.spend ? `${per(tot.spend, tot.leads)} per lead · ${(tot.val / tot.spend).toFixed(1)}× return` : "enter it on the Ad spend tab"}</span></div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h3>Results by channel</h3><span class="muted small">lead source from Workiz · sold = won/approved estimate or "Sold" status · value = won estimate amount</span></div>
      <div class="table-wrap"><table><thead><tr><th>Channel</th><th class="right">Leads</th><th class="right">Consults booked</th><th class="right">Estimates</th><th class="right">Sold</th><th class="right">Close rate</th><th class="right">Sold value</th><th class="right">Spend</th><th class="right">Cost / lead</th><th class="right">Cost / sale</th><th class="right">Return</th></tr></thead>
      <tbody>${list.map((r) => line(r) + [...r.subs.values()].sort((a, b) => b.leads - a.leads).map((s) => line(s, true)).join("")).join("") || `<tr><td colspan="11"><div class="empty">No leads in this period</div></td></tr>`}</tbody></table></div></div>
    <div class="grid g3" style="margin-top:16px">
      <div class="card span2"><div class="card-h"><h3>New leads per month</h3></div><div class="card-b">${barChart(months, { color: "var(--purple)", count: true })}</div></div>
      <div class="card"><div class="card-h"><h3>Leads by channel</h3></div><div class="card-b">${donut(list.filter((r) => r.leads).slice(0, 6).map((r) => ({ label: r.channel, v: r.leads })))}</div></div>
    </div>
    ${unknown ? `<div class="notice" style="margin-top:16px"><b>${unknown} leads in this period have no source.</b> Set the ad group on each new lead in Workiz (Facebook, Google, Referral…) so every lead counts toward the right channel.</div>` : ""}`,
    mount() { $("#mk-period").onchange = (e) => { MK.period = e.target.value; viewMarketing(); }; } };
}

function utmLink(c, base = BOOKING_URL) {
  const src = /google/i.test(c.channel) ? "google" : /facebook|instagram/i.test(c.channel) ? "facebook" : /nextdoor|door|yard/i.test(c.channel) ? "offline" : c.channel.toLowerCase().replace(/[^a-z]+/g, "_");
  const med = /google ads/i.test(c.channel) ? "cpc" : /facebook|instagram/i.test(c.channel) ? "paid_social" : /referral|partner/i.test(c.channel) ? "referral" : "offline";
  return `${base}${base.includes("?") ? "&" : "?"}utm_source=${src}&utm_medium=${med}&utm_campaign=${encodeURIComponent(c.utm_campaign || "campaign")}`;
}

function mkCampaigns(_, camps) {
  const STAT = ["idea", "ready", "running", "paused", "done"];
  return { html: `
    <div class="notice" style="margin-bottom:14px">Ready-to-run campaigns for a closet business. Each card has the audience, budget, ad copy you can paste, step-by-step setup, and a tracking link. Set the status as you launch them, and keep notes on what worked.</div>
    <div class="grid g2">${camps.map((c) => `<div class="card"><div class="card-h"><h3>${esc(c.name)}</h3><div class="spacer"></div>
        <select class="pill-select" data-cst="${c.id}">${STAT.map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="card-b" style="display:flex;flex-direction:column;gap:10px">
        <div><span class="badge b-orange">${esc(c.channel)}</span>${c.objective ? ` <span class="muted small">${esc(c.objective)}</span>` : ""}</div>
        ${c.audience ? `<div class="small"><b>Audience:</b> <span class="muted">${esc(c.audience)}</span></div>` : ""}
        ${c.budget ? `<div class="small"><b>Budget:</b> <span class="muted">${esc(c.budget)}</span></div>` : ""}
        ${c.headline || c.primary_text ? `<div class="note">${c.headline ? `<b>${esc(c.headline)}</b><br>` : ""}${esc(c.primary_text || "")}${c.cta ? `<div class="muted small" style="margin-top:6px">Button: ${esc(c.cta)}</div>` : ""}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${c.headline ? `<button class="btn small" data-cp="${esc(c.headline)}">⧉ Copy headline</button>` : ""}${c.primary_text ? `<button class="btn small" data-cpid="${c.id}">⧉ Copy ad text</button>` : ""}</div>` : ""}
        ${c.how_to ? `<details><summary style="cursor:pointer;color:var(--purple-2);font-size:13px">How to set it up</summary><div class="muted small" style="white-space:pre-wrap;margin-top:6px">${esc(c.how_to)}</div></details>` : ""}
        <div class="small"><b>Tracking link</b> (booking page): <input readonly value="${esc(utmLink(c))}" style="font-size:11.5px;margin-top:4px" /></div>
        <div style="display:flex;gap:8px"><button class="btn small" data-cp="${esc(utmLink(c))}">⧉ Copy link</button><button class="btn small" data-cp="${esc(utmLink(c, WEBSITE_URL))}">⧉ Website version</button></div>
        <textarea data-cnote="${c.id}" rows="2" placeholder="Notes: results, what worked, dates…">${esc(c.notes || "")}</textarea>
      </div></div>`).join("")}</div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h3>Add your own campaign</h3></div><div class="card-b"><div class="form-row">
      <label class="wide">Name<input id="nc-name" /></label><label>Channel<input id="nc-ch" placeholder="Facebook / Instagram" /></label><button class="btn primary" id="nc-add">＋ Add</button></div></div></div>`,
    mount() {
      const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast("Copied"); } catch { toast("Copy blocked. Select the text instead.", true); } };
      $$("[data-cp]").forEach((b) => b.onclick = () => copy(b.dataset.cp));
      $$("[data-cpid]").forEach((b) => b.onclick = () => copy(camps.find((c) => String(c.id) === b.dataset.cpid).primary_text));
      $$("[data-cst]").forEach((s) => s.onchange = async () => { const { error } = await sb.from("campaigns").update({ status: s.value }).eq("id", s.dataset.cst); error ? toast(error.message, true) : toast("Status saved"); });
      $$("[data-cnote]").forEach((t) => t.onchange = async () => { const { error } = await sb.from("campaigns").update({ notes: t.value }).eq("id", t.dataset.cnote); error ? toast(error.message, true) : toast("Note saved"); });
      $("#nc-add").onclick = async () => { const name = $("#nc-name").value.trim(); if (!name) return; const { error } = await sb.from("campaigns").insert({ name, channel: $("#nc-ch").value.trim() || "Other", sort: 999, utm_campaign: name.toLowerCase().replace(/[^a-z0-9]+/g, "_") }); error ? toast(error.message, true) : viewMarketing(); };
    } };
}

function mkSpend(spend) {
  const sources = [...new Set([...D.leads.map((l) => l.source).filter(Boolean), "Google Ads", "Google LSA", "Nextdoor", "Door hangers / yard signs", "Home show booth", "Referral rewards"])].sort();
  const thisMonth = dayKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1)).slice(0, 7);
  return { html: `
    <div class="notice" style="margin-bottom:14px">Enter what you spent per channel each month (ad platform totals, agency/setter fees, sign printing, home show booth). The Results tab then shows cost per lead, cost per sale and return. Spend can be pulled in automatically if you connect an ad-data connector (Adspirer or Windsor.ai).</div>
    <div class="card"><div class="card-b"><div class="form-row">
      <label>Month<input id="sp-month" type="month" value="${thisMonth}" /></label>
      <label class="wide">Channel / source<input id="sp-ch" list="sp-list" placeholder="e.g. Facebook - Lakyn" /></label>
      <datalist id="sp-list">${sources.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
      <label>Amount ($)<input id="sp-amt" type="number" min="0" step="1" /></label></div>
      <div style="margin-top:10px"><button class="btn primary" id="sp-add">Save spend</button> <span class="muted small">Saving the same month and channel again replaces it.</span></div></div></div>
    <div class="card" style="margin-top:16px"><div class="table-wrap"><table><thead><tr><th>Month</th><th>Channel</th><th>Counts toward</th><th class="right">Amount</th><th></th></tr></thead><tbody>
      ${spend.map((s) => `<tr><td>${esc(toDate(s.month + " 00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }))}</td><td>${esc(s.channel)}</td><td class="muted">${esc(channelOf(s.channel))}</td><td class="right num">${money(s.amount)}</td><td class="right"><button class="btn small danger" data-spdel="${s.id}">Remove</button></td></tr>`).join("") || `<tr><td colspan="5"><div class="empty">No spend entered yet</div></td></tr>`}
    </tbody></table></div></div>`,
    mount() {
      $("#sp-add").onclick = async () => {
        const m = $("#sp-month").value, ch = $("#sp-ch").value.trim(), amt = num($("#sp-amt").value);
        if (!m || !ch) return toast("Pick a month and channel", true);
        const { error } = await sb.from("marketing_spend").upsert({ month: m + "-01", channel: ch, amount: amt }, { onConflict: "month,channel" });
        error ? toast(error.message, true) : (toast("Saved"), viewMarketing());
      };
      $$("[data-spdel]").forEach((b) => b.onclick = async () => { const { error } = await sb.from("marketing_spend").delete().eq("id", b.dataset.spdel); error ? toast(error.message, true) : viewMarketing(); });
    } };
}

function mkLinks() {
  const L = [
    ["Meta Ads Manager", "https://adsmanager.facebook.com/", "Create and manage Facebook/Instagram ads"],
    ["Meta Business Suite", "https://business.facebook.com/", "Posts, inbox, lead forms, Instagram"],
    ["Meta Events Manager (Pixel)", "https://business.facebook.com/events_manager2/", "Website tracking for retargeting"],
    ["Google Ads", "https://ads.google.com/", "Search ads"],
    ["Google Local Services Ads", "https://ads.google.com/local-services-ads/", "Pay-per-lead, Google Guaranteed"],
    ["Google Business Profile", "https://business.google.com/", "Maps listing, posts, reviews"],
    ["Nextdoor for Business", "https://business.nextdoor.com/", "Neighborhood ads and posts"],
    ["GoHighLevel", "https://app.gohighlevel.com/", "Your booking calendar and lead follow-up"],
    ["Workiz", "https://app.workiz.com/", "Leads, jobs, automations"],
    ["Your booking page", BOOKING_URL, "Where every ad should send people"],
    ["Your website", WEBSITE_URL, "upclosets.com/rhode-island"],
  ];
  return { html: `
    <div class="grid g3">${L.map(([n, u, d]) => `<a class="card" href="${esc(u)}" target="_blank" rel="noopener" style="padding:16px;color:inherit;text-decoration:none;display:block"><b>${esc(n)} ↗</b><div class="muted small" style="margin-top:4px">${esc(d)}</div></a>`).join("")}</div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h3>Tracking link builder</h3></div><div class="card-b">
      <div class="form-row"><label class="wide">Send people to<select id="ub-base"><option value="${esc(BOOKING_URL)}">Booking page</option><option value="${esc(WEBSITE_URL)}">Website</option></select></label>
        <label>Source<input id="ub-src" value="facebook" /></label><label>Medium<input id="ub-med" value="paid_social" /></label></div>
      <div class="form-row" style="margin-top:10px"><label class="wide">Campaign name<input id="ub-camp" value="winter_closet_promo" /></label></div>
      <input id="ub-out" readonly style="margin-top:10px" /><button class="btn small" id="ub-copy" style="margin-top:8px">⧉ Copy link</button>
      <p class="muted small">How tracking works here: the dashboard counts results by the lead source (ad group) set in Workiz. Use these links in ads and QR codes, and give each campaign a matching ad group in Workiz (for example "Facebook - Lakyn" or "Yard Signs") so sales are credited correctly.</p></div></div>`,
    mount() {
      const upd = () => { const b = $("#ub-base").value; $("#ub-out").value = `${b}${b.includes("?") ? "&" : "?"}utm_source=${encodeURIComponent($("#ub-src").value)}&utm_medium=${encodeURIComponent($("#ub-med").value)}&utm_campaign=${encodeURIComponent($("#ub-camp").value)}`; };
      ["#ub-base", "#ub-src", "#ub-med", "#ub-camp"].forEach((s) => $(s).oninput = upd); upd();
      $("#ub-copy").onclick = async () => { try { await navigator.clipboard.writeText($("#ub-out").value); toast("Copied"); } catch { toast("Copy blocked", true); } };
    } };
}

// ---------- quick quote (closet pricing calculator) ----------
// Prices come ONLY from files you import (price book + color multipliers). Nothing is estimated.
const QQ = { tab: "quote", comps: null, colors: null, quotes: null, pending: null, q: null };
const unitKind = (u) => {
  const s = String(u || "").toLowerCase();
  if (/sq\.?\s?f|sqft|\bsf\b|square/.test(s)) return "sqft";
  if (/\blf\b|lin|\bft\b|foot|feet/.test(s)) return "ft";
  if (/\bin\b|inch|"/.test(s)) return "in";
  return "each";
};
const parseMoney = (v) => { if (typeof v === "number") return v; const s = String(v ?? "").replace(/[$,\s]/g, ""); if (s === "" || isNaN(Number(s))) return null; return Number(s); };
function newQuote() { return { id: null, title: "", lead_id: null, color: "", lines: [], overhead_mode: "flat", overhead_value: 0, margin_pct: 40, tax_pct: 0, deposit_pct: 50, rounding: 0 }; }

async function loadQQ(force = false) {
  if (QQ.comps && !force) return;
  const [a, b, c] = await Promise.all([
    sb.from("calc_components").select("*").order("category").order("name").limit(10000),
    sb.from("calc_colors").select("*").order("color"),
    sb.from("calc_quotes").select("*").order("updated_at", { ascending: false }).limit(200),
  ]);
  const err = [a, b, c].find((r) => r.error); if (err) throw err.error;
  QQ.comps = a.data; QQ.colors = b.data; QQ.quotes = c.data; QQ.q ||= newQuote();
}

function qqCalc(q) {
  const mult = num(QQ.colors.find((c) => c.color === q.color)?.multiplier) || (q.color ? 0 : 1);
  const lines = q.lines.map((l) => {
    const k = unitKind(l.unit);
    const factor = k === "sqft" ? (num(l.w) * num(l.h)) / 144 : k === "ft" ? num(l.len) / 12 : k === "in" ? num(l.len) : 1;
    const m = l.color_applies ? mult : 1;
    return { ...l, kind: k, factor, mult: m, cost: num(l.base_cost) * factor * num(l.qty) * m };
  });
  const linesCost = lines.reduce((s, l) => s + l.cost, 0);
  const overhead = q.overhead_mode === "pct" ? linesCost * num(q.overhead_value) / 100 : num(q.overhead_value);
  const jobCost = linesCost + overhead;
  const m = Math.min(num(q.margin_pct), 99) / 100;
  const rawPrice = jobCost / (1 - m);
  const price = q.rounding ? Math.round(rawPrice / q.rounding) * q.rounding : rawPrice;
  const profit = price - jobCost;
  const tax = price * num(q.tax_pct) / 100;
  const total = price + tax;
  return { mult, lines, linesCost, overhead, jobCost, rawPrice, price, profit, profitPct: price ? (profit / price) * 100 : 0, tax, total, deposit: total * num(q.deposit_pct) / 100 };
}

async function viewQuote() {
  view(`<div class="empty">Loading…</div>`);
  try { await loadQQ(); } catch (e) { return view(`<div class="notice">${esc(e.message)}</div>`); }
  const tabsHtml = [["quote", "Build a quote"], ["saved", `Saved quotes (${QQ.quotes.length})`], ["data", `Price data (${QQ.comps.length} parts · ${QQ.colors.length} colors)`]]
    .map(([id, l]) => `<div class="tab ${QQ.tab === id ? "active" : ""}" data-qq="${id}" style="min-width:150px;text-align:left"><div class="t">${l}</div></div>`).join("");
  const body = { quote: qqBuilder, saved: qqSaved, data: qqData }[QQ.tab]();
  view(`<div class="page-head"><h2>Quick quote</h2><span class="muted">price a closet in seconds, no eCab needed</span></div><div class="tabs">${tabsHtml}</div>${body.html}`);
  $$("[data-qq]").forEach((t) => t.onclick = () => { QQ.tab = t.dataset.qq; viewQuote(); });
  body.mount?.();
}

function qqBuilder() {
  const q = QQ.q;
  if (!QQ.comps.length || !QQ.colors.length) {
    return { html: `<div class="notice"><b>Import your price data first.</b> The calculator only uses numbers from your files, so it needs:<br>
      ${QQ.comps.length ? "✓" : "①"} your <b>price-book export</b> (CSV or Excel): every component with its base cost<br>
      ${QQ.colors.length ? "✓" : "②"} your <b>color multiplier table</b> (CSV or Excel): one row per color<br><br>
      <button class="btn primary" id="go-data">Go to Price data →</button></div>`, mount() { $("#go-data").onclick = () => { QQ.tab = "data"; viewQuote(); }; } };
  }
  const c = qqCalc(q);
  const cats = [...new Set(QQ.comps.map((x) => x.category || "Other"))];
  const sizeCell = (l, i) => l.kind === "sqft" ? `<input type="number" min="0" step="0.25" data-qw="${i}" value="${l.w ?? ""}" placeholder="W in" style="width:70px" /> × <input type="number" min="0" step="0.25" data-qh="${i}" value="${l.h ?? ""}" placeholder="H in" style="width:70px" />`
    : l.kind === "ft" || l.kind === "in" ? `<input type="number" min="0" step="0.25" data-ql="${i}" value="${l.len ?? ""}" placeholder="length in" style="width:90px" />` : `<span class="muted small">—</span>`;
  return { html: `
    <div class="grid" style="grid-template-columns:minmax(0,1fr) 340px;align-items:start">
      <div>
        <div class="card" style="margin-bottom:14px"><div class="card-b"><div class="form-row">
          <label class="wide">Quote name / customer<input id="qq-title" value="${esc(q.title)}" placeholder="e.g. Smith master walk-in" /></label>
          <label class="wide">Link to lead (optional)<input id="qq-lead" list="qq-leads" value="${(() => { const l = D.leads.find((x) => x.workiz_id === q.lead_id); return l ? esc(`${l.client_name} · ${l.uuid} #${l.workiz_id}`) : ""; })()}" /></label>
          <datalist id="qq-leads">${D.leads.filter((x) => !x.lost).map((x) => `<option value="${esc(`${x.client_name} · ${x.uuid} #${x.workiz_id}`)}">`).join("")}</datalist></div>
          <div class="form-row" style="margin-top:10px">
            <label class="wide">Color for this job<select id="qq-color"><option value="">Pick a color…</option>${QQ.colors.map((x) => `<option value="${esc(x.color)}" ${x.color === q.color ? "selected" : ""}>${esc(x.color)} (×${num(x.multiplier)})</option>`).join("")}</select></label>
          </div></div></div>

        <div class="card"><div class="card-h"><h3>Components</h3><div class="spacer"></div><span class="muted small">line cost = base cost × size × qty × color multiplier</span></div>
          <div class="table-wrap"><table><thead><tr><th>Component</th><th>Size</th><th class="right">Qty</th><th class="right">Base cost</th><th class="right">Color ×</th><th class="right">Line cost</th><th></th></tr></thead><tbody>
          ${c.lines.map((l, i) => `<tr><td><b>${esc(l.name)}</b><span class="sub">${esc([l.sku, l.unit].filter(Boolean).join(" · "))}</span>
              <label style="flex-direction:row;gap:6px;align-items:center;margin-top:4px;font-size:11px"><input type="checkbox" data-qca="${i}" ${l.color_applies ? "checked" : ""} style="width:auto" /> color applies</label></td>
            <td>${sizeCell(l, i)}</td>
            <td class="right"><input type="number" min="0" step="1" data-qq-qty="${i}" value="${l.qty}" style="width:64px;text-align:right" /></td>
            <td class="right num">${money(l.base_cost)}${l.kind !== "each" ? `<span class="sub">per ${l.kind === "sqft" ? "sq ft" : l.kind}</span>` : ""}</td>
            <td class="right num">${l.mult ? "×" + l.mult : '<span style="color:var(--red)">pick color</span>'}</td>
            <td class="right num"><b>${money(l.cost)}</b></td><td class="right"><button class="btn small danger" data-qdel="${i}">✕</button></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty">Add components below</div></td></tr>`}
          </tbody></table></div>
          <div class="card-b" style="border-top:1px solid var(--line)"><div class="form-row">
            <label>Category<select id="qq-cat"><option value="">All</option>${cats.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
            <label class="wide">Component<input id="qq-comp" list="qq-comps" placeholder="Type to search your price book…" /></label>
            <datalist id="qq-comps">${QQ.comps.map((x) => `<option value="${esc(`${x.name}${x.sku ? " · " + x.sku : ""} · ${money(x.base_cost)}${x.unit && unitKind(x.unit) !== "each" ? "/" + x.unit : ""} #${x.id}`)}">`).join("")}</datalist>
            <button class="btn purple" id="qq-add">＋ Add</button></div></div></div>
      </div>

      <div class="card" style="position:sticky;top:76px"><div class="card-h"><h3>Price</h3></div><div class="card-b" style="display:flex;flex-direction:column;gap:12px">
        <div class="kv" style="grid-template-columns:1fr auto"><div>Components</div><div class="num">${money(c.linesCost)}</div>
          <div>Overhead</div><div class="num">${money(c.overhead)}</div>
          <div><b>Job cost (yours)</b></div><div class="num"><b>${money(c.jobCost)}</b></div></div>
        <div class="form-row" style="grid-template-columns:1fr 1fr"><label>Overhead<select id="qq-ohm"><option value="flat" ${q.overhead_mode === "flat" ? "selected" : ""}>Flat $</option><option value="pct" ${q.overhead_mode === "pct" ? "selected" : ""}>% of components</option></select></label>
          <label>&nbsp;<input id="qq-ohv" type="number" min="0" step="1" value="${q.overhead_value}" /></label></div>
        <label>Margin on sell price: <b id="qq-mlabel">${num(q.margin_pct)}%</b>
          <input id="qq-margin" type="range" min="0" max="80" step="1" value="${num(q.margin_pct)}" style="accent-color:var(--orange);padding:0" />
          <input id="qq-margin-n" type="number" min="0" max="95" step="0.5" value="${num(q.margin_pct)}" /></label>
        <label>Round price<select id="qq-round"><option value="0" ${!q.rounding ? "selected" : ""}>No rounding</option><option value="5" ${q.rounding === 5 ? "selected" : ""}>Nearest $5</option><option value="10" ${q.rounding === 10 ? "selected" : ""}>Nearest $10</option></select></label>
        <div class="profit-box" style="grid-template-columns:1fr 1fr">
          <div><div class="l">Customer price</div><div class="v num" id="qq-price">${money(c.price)}</div></div>
          <div><div class="l">Your profit</div><div class="v num ${c.profit >= 0 ? "pos" : "neg"}" id="qq-profit">${money(c.profit)}</div><div class="l" id="qq-ppct">${c.profitPct.toFixed(1)}% of price</div></div></div>
        <div class="form-row" style="grid-template-columns:1fr 1fr"><label>Tax % (optional)<input id="qq-tax" type="number" min="0" step="0.1" value="${q.tax_pct}" /></label>
          <label>Deposit %<input id="qq-dep" type="number" min="0" max="100" step="5" value="${q.deposit_pct}" /></label></div>
        <div class="kv" style="grid-template-columns:1fr auto">${num(q.tax_pct) ? `<div>Tax</div><div class="num">${money(c.tax)}</div>` : ""}
          <div><b>Total to customer</b></div><div class="num"><b>${money(c.total)}</b></div>
          <div>Deposit (${num(q.deposit_pct)}%)</div><div class="num">${money(c.deposit)}</div></div>
        ${!q.color ? `<div class="warn">Pick a color: color-priced lines show $0 until you do.</div>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="qq-save">${q.id ? "Save changes" : "Save quote"}</button>
          <button class="btn" id="qq-pdf">Customer PDF</button><button class="btn" id="qq-csv">CSV</button><button class="btn ghost" id="qq-new">New</button></div>
      </div></div>
    </div>`,
    mount() {
      const re = () => viewQuote();
      $("#qq-title").onchange = (e) => (q.title = e.target.value);
      $("#qq-lead").onchange = (e) => { const m = e.target.value.match(/#(LD-[\w-]+)$/); q.lead_id = m ? m[1] : null; if (m && !q.title) { const l = D.leads.find((x) => x.workiz_id === m[1]); q.title = l?.client_name || ""; } re(); };
      $("#qq-color").onchange = (e) => { q.color = e.target.value; re(); };
      $("#qq-cat").onchange = (e) => { const cat = e.target.value; $("#qq-comps").innerHTML = QQ.comps.filter((x) => !cat || (x.category || "Other") === cat).map((x) => `<option value="${esc(`${x.name}${x.sku ? " · " + x.sku : ""} · ${money(x.base_cost)} #${x.id}`)}">`).join(""); };
      $("#qq-add").onclick = () => {
        const m = $("#qq-comp").value.match(/#(\d+)$/); const x = m && QQ.comps.find((c) => String(c.id) === m[1]);
        if (!x) return toast("Pick a component from the list", true);
        q.lines.push({ comp_id: x.id, name: x.name, sku: x.sku, unit: x.unit, base_cost: num(x.base_cost), qty: 1, color_applies: x.color_applies !== false }); re();
      };
      const bind = (sel, key, cast = num) => $$(`[${sel}]`).forEach((inp) => inp.onchange = () => { q.lines[inp.getAttribute(sel)][key] = cast(inp.value); re(); });
      bind("data-qq-qty", "qty"); bind("data-qw", "w"); bind("data-qh", "h"); bind("data-ql", "len");
      $$("[data-qca]").forEach((cb) => cb.onchange = () => { q.lines[cb.dataset.qca].color_applies = cb.checked; re(); });
      $$("[data-qdel]").forEach((b) => b.onclick = () => { q.lines.splice(Number(b.dataset.qdel), 1); re(); });
      $("#qq-ohm").onchange = (e) => { q.overhead_mode = e.target.value; re(); };
      $("#qq-ohv").onchange = (e) => { q.overhead_value = num(e.target.value); re(); };
      const liveMargin = (v) => {   // live update without re-rendering the page
        q.margin_pct = Math.min(num(v), 95); const k = qqCalc(q);
        $("#qq-mlabel").textContent = `${q.margin_pct}%`; $("#qq-margin").value = q.margin_pct; $("#qq-margin-n").value = q.margin_pct;
        $("#qq-price").textContent = money(k.price); $("#qq-profit").textContent = money(k.profit); $("#qq-ppct").textContent = `${k.profitPct.toFixed(1)}% of price`;
      };
      $("#qq-margin").oninput = (e) => liveMargin(e.target.value);
      $("#qq-margin").onchange = () => re();
      $("#qq-margin-n").onchange = (e) => { liveMargin(e.target.value); re(); };
      $("#qq-round").onchange = (e) => { q.rounding = Number(e.target.value); re(); };
      $("#qq-tax").onchange = (e) => { q.tax_pct = num(e.target.value); re(); };
      $("#qq-dep").onchange = (e) => { q.deposit_pct = num(e.target.value); re(); };
      $("#qq-new").onclick = () => { QQ.q = newQuote(); re(); };
      $("#qq-save").onclick = async () => {
        const k = qqCalc(q);
        const row = { title: q.title || "Untitled quote", lead_id: q.lead_id, color: q.color, lines: q.lines, overhead_mode: q.overhead_mode, overhead_value: q.overhead_value, margin_pct: q.margin_pct, tax_pct: q.tax_pct, deposit_pct: q.deposit_pct, rounding: q.rounding,
          totals: { job_cost: k.jobCost, price: k.price, profit: k.profit, total: k.total, multiplier: k.mult }, updated_at: new Date().toISOString() };
        const res = q.id ? await sb.from("calc_quotes").update(row).eq("id", q.id).select().single() : await sb.from("calc_quotes").insert(row).select().single();
        if (res.error) return toast(res.error.message, true);
        q.id = res.data.id; await loadQQ(true); toast("Quote saved"); re();
      };
      $("#qq-csv").onclick = () => qqCsv(q);
      $("#qq-pdf").onclick = () => qqPdf(q);
    } };
}

function qqCsv(q) {
  const k = qqCalc(q); const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Component", "SKU", "Unit", "Size", "Qty", "Base cost", "Color multiplier", "Line cost"],
    ...k.lines.map((l) => [l.name, l.sku, l.unit, l.kind === "sqft" ? `${l.w || 0}x${l.h || 0} in` : l.kind === "each" ? "" : `${l.len || 0} in`, l.qty, l.base_cost.toFixed(2), l.mult, l.cost.toFixed(2)]),
    [], ["Components", "", "", "", "", "", "", k.linesCost.toFixed(2)], ["Overhead", "", "", "", "", "", "", k.overhead.toFixed(2)], ["Job cost", "", "", "", "", "", "", k.jobCost.toFixed(2)],
    ["Margin %", "", "", "", "", "", "", q.margin_pct], ["Customer price", "", "", "", "", "", "", k.price.toFixed(2)], ["Profit", "", "", "", "", "", "", k.profit.toFixed(2)],
    ["Tax", "", "", "", "", "", "", k.tax.toFixed(2)], ["Total", "", "", "", "", "", "", k.total.toFixed(2)], ["Deposit", "", "", "", "", "", "", k.deposit.toFixed(2)]];
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv" }));
  a.download = `quote-${(q.title || "closet").replace(/\W+/g, "-")}.csv`; a.click();
}

function qqPdf(q) {
  const k = qqCalc(q); const l = D.leads.find((x) => x.workiz_id === q.lead_id) || {};
  const w = window.open("", "_blank");
  w.document.write(`<!doctype html><html><head><title>Quote · ${esc(q.title || l.client_name || "")}</title><style>
    body{font:14px/1.5 Poppins,Arial,sans-serif;color:#111;max-width:780px;margin:30px auto;padding:0 20px} h1{font-size:22px;margin:8px 0 0}
    .muted{color:#666} table{width:100%;border-collapse:collapse;margin:14px 0} td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left} .r{text-align:right}
    .tot td{font-weight:700;font-size:16px;border-top:2px solid #111}</style></head><body>
    <img src="${location.origin}/assets/logo-dark.png" style="width:200px;background:#111;padding:10px;border-radius:8px" />
    <h1>Quote</h1><div class="muted">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>
    <p><b>${esc(q.title || l.client_name || "")}</b>${l.address ? "<br>" + esc(l.address) : ""}${l.client_phone ? "<br>" + esc(phone(l.client_phone)) : ""}</p>
    <p>Custom closet system in <b>${esc(q.color || "")}</b>, designed, supplied and installed.</p>
    <table><tr><th>Includes</th><th class="r">Qty</th></tr>
      ${k.lines.map((x) => `<tr><td>${esc(x.name)}${x.kind === "sqft" ? ` (${x.w}" × ${x.h}")` : x.kind !== "each" ? ` (${x.len}")` : ""}</td><td class="r">${num(x.qty)}</td></tr>`).join("")}</table>
    <table><tr><td>Price</td><td class="r">${money(k.price)}</td></tr>${num(q.tax_pct) ? `<tr><td>Tax (${num(q.tax_pct)}%)</td><td class="r">${money(k.tax)}</td></tr>` : ""}
      <tr class="tot"><td>Total</td><td class="r">${money(k.total)}</td></tr><tr><td>Deposit to schedule (${num(q.deposit_pct)}%)</td><td class="r">${money(k.deposit)}</td></tr></table>
    <p class="muted">Up Closets of Rhode Island · (401) 407-6495 · rhodeisland@upclosets.com</p><script>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}

function qqSaved() {
  return { html: `<div class="card"><div class="table-wrap"><table><thead><tr><th>Quote</th><th>Color</th><th class="right">Lines</th><th class="right">Job cost</th><th class="right">Price</th><th class="right">Profit</th><th>Updated</th><th></th></tr></thead><tbody>
    ${QQ.quotes.map((x) => `<tr class="click" data-qopen="${x.id}"><td><b>${esc(x.title)}</b></td><td>${esc(x.color || "")}</td><td class="right">${(x.lines || []).length}</td>
      <td class="right num">${money(x.totals?.job_cost)}</td><td class="right num">${money(x.totals?.price)}</td><td class="right num">${money(x.totals?.profit)}</td><td>${esc(fmtDate(x.updated_at))}</td>
      <td class="right"><button class="btn small" data-qdup="${x.id}">Duplicate</button></td></tr>`).join("") || `<tr><td colspan="8"><div class="empty">No saved quotes yet</div></td></tr>`}
    </tbody></table></div></div>`,
    mount() {
      $$("[data-qopen]").forEach((tr) => tr.onclick = (e) => { if (e.target.dataset.qdup) return; const x = QQ.quotes.find((y) => String(y.id) === tr.dataset.qopen); QQ.q = { ...newQuote(), ...structuredClone(x) }; QQ.tab = "quote"; viewQuote(); });
      $$("[data-qdup]").forEach((b) => b.onclick = () => { const x = QQ.quotes.find((y) => String(y.id) === b.dataset.qdup); QQ.q = { ...newQuote(), ...structuredClone(x), id: null, title: x.title + " (copy)" }; QQ.tab = "quote"; viewQuote(); });
    } };
}

// ---- price data import ----
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(cur); cur = ""; } else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; } else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
async function readTable(file) {
  if (/\.csv$|\.txt$/i.test(file.name)) return parseCsv(await file.text());
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  // pick the sheet with the most rows
  const sheets = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
  return sheets.sort((a, b) => b.length - a.length)[0].filter((r) => r.some((c) => String(c).trim() !== ""));
}
const guessCol = (hdr, re) => hdr.findIndex((h) => re.test(String(h)));

function qqData() {
  const P = QQ.pending;
  const mapUI = () => {
    if (!P) return "";
    const opts = (sel) => `<option value="-1">— none —</option>` + P.header.map((h, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${esc(h || `Column ${i + 1}`)}</option>`).join("");
    const fields = P.kind === "comps"
      ? [["name", "Component name *"], ["cost", "Base cost *"], ["sku", "SKU / part #"], ["unit", "Unit (each, ft, in, sq ft)"], ["category", "Category"]]
      : [["color", "Color *"], ["mult", "Multiplier *"]];
    const prev = qqBuildRows(P).slice(0, 8);
    return `<div class="card" style="margin-top:16px;border-color:var(--purple)"><div class="card-h"><h3>Check the columns: ${esc(P.file)}</h3><div class="spacer"></div><span class="muted small">${P.rows.length} rows found</span></div><div class="card-b">
      <div class="form-row">${fields.map(([k, l]) => `<label>${l}<select data-map="${k}">${opts(P.map[k])}</select></label>`).join("")}
      ${P.kind === "colors" ? `<label>Values are<select id="mult-mode"><option value="mult" ${P.multMode === "mult" ? "selected" : ""}>Multipliers (1.10)</option><option value="pct" ${P.multMode === "pct" ? "selected" : ""}>% added (10 = +10%)</option></select></label>` : ""}</div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr>${P.kind === "comps" ? "<th>Name</th><th>SKU</th><th>Unit</th><th>Category</th><th class='right'>Base cost</th>" : "<th>Color</th><th class='right'>Multiplier used</th>"}</tr></thead><tbody>
      ${prev.map((r) => P.kind === "comps" ? `<tr><td>${esc(r.name)}</td><td>${esc(r.sku || "")}</td><td>${esc(r.unit || "each")}</td><td>${esc(r.category || "")}</td><td class="right num">${money(r.base_cost)}</td></tr>` : `<tr><td>${esc(r.color)}</td><td class="right num">×${r.multiplier}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">${qqBuildRows(P).length} usable rows · ${P.rows.length - qqBuildRows(P).length} skipped (no name or no number). Numbers are used exactly as they are in your file.</p>
      <div style="display:flex;gap:8px"><button class="btn primary" id="imp-replace">Replace ${P.kind === "comps" ? "price book" : "color table"} with this file</button>${P.kind === "comps" ? `<button class="btn" id="imp-add">Add to existing</button>` : ""}<button class="btn ghost" id="imp-cancel">Cancel</button></div></div></div>`;
  };
  const t = table("qq-comps", { rows: QQ.comps, search: (x) => [x.name, x.sku, x.category].join(" "),
    cols: [{ label: "Component", key: "name", render: (x) => `${esc(x.name)}<span class="sub">${esc(x.sku || "")}</span>` }, { label: "Category", key: "category" }, { label: "Unit", key: "unit" },
      { label: "Base cost", key: "base_cost", right: true, render: (x) => money(x.base_cost) },
      { label: "Color applies", key: "color_applies", render: (x) => `<input type="checkbox" data-capp="${x.id}" ${x.color_applies !== false ? "checked" : ""} style="width:auto" />` },
      { label: "Source", key: "source", render: (x) => `<span class="muted small">${esc(x.source || "")}</span>` }] });
  return { html: `
    <div class="grid g2">
      <div class="card"><div class="card-h"><h3>① Price book</h3><div class="spacer"></div><span class="muted small">${QQ.comps.length} components</span></div><div class="card-b">
        <label class="dropzone" for="f-comps">⇪ Upload your price-book export (CSV or Excel)</label><input id="f-comps" type="file" accept=".csv,.txt,.xlsx,.xls" class="hidden" />
        <p class="muted small">Needs a name column and a base cost column. Optional: SKU, unit (each / ft / in / sq ft, which controls the size boxes), category.</p>
        <button class="btn small" id="load-parts">Or load the Tidy Squares prices you've already entered (Part costs)</button></div></div>
      <div class="card"><div class="card-h"><h3>② Color multipliers</h3><div class="spacer"></div><span class="muted small">${QQ.colors.length} colors</span></div><div class="card-b">
        <label class="dropzone" for="f-colors">⇪ Upload your color multiplier table (CSV or Excel)</label><input id="f-colors" type="file" accept=".csv,.txt,.xlsx,.xls" class="hidden" />
        ${QQ.colors.length ? `<div class="kv" style="grid-template-columns:1fr auto;margin-top:10px">${QQ.colors.map((c) => `<div>${esc(c.color)}</div><div class="num">×${num(c.multiplier)}</div>`).join("")}</div>` : `<p class="muted small">Needs a color column and a multiplier column (1.10, or a % added).</p>`}</div></div>
    </div>
    ${mapUI()}
    <h3 style="margin:20px 0 10px">Price book components</h3>${t.html}`,
    mount() {
      t.mount();
      const pick = (kind) => async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const all = await readTable(f); const header = all[0].map((h) => String(h).trim()); const rows = all.slice(1);
          const map = kind === "comps"
            ? { name: guessCol(header, /name|desc|component|item(?!.*(no|#|num))/i), cost: guessCol(header, /cost|price|base/i), sku: guessCol(header, /sku|part|code|item ?(no|#|num)/i), unit: guessCol(header, /unit|uom|per/i), category: guessCol(header, /cat|type|group/i) }
            : { color: guessCol(header, /colou?r|finish|name/i), mult: guessCol(header, /mult|factor|adj|%|percent|upcharge/i) };
          if (kind === "colors" && map.mult < 0) map.mult = header.findIndex((_, i) => i !== map.color);
          const sample = kind === "colors" ? rows.map((r) => parseMoney(String(r[map.mult] ?? "").replace("%", ""))).filter((v) => v != null) : [];
          QQ.pending = { kind, file: f.name, header, rows, map, multMode: sample.some((v) => v >= 3) || rows.some((r) => /%/.test(String(r[map.mult]))) ? "pct" : "mult" };
          viewQuote();
        } catch (err) { toast(`Couldn't read ${f.name}: ${err.message}`, true); }
      };
      $("#f-comps").onchange = pick("comps"); $("#f-colors").onchange = pick("colors");
      $$("[data-map]").forEach((s) => s.onchange = () => { QQ.pending.map[s.dataset.map] = Number(s.value); viewQuote(); });
      const mm = $("#mult-mode"); if (mm) mm.onchange = () => { QQ.pending.multMode = mm.value; viewQuote(); };
      const cancel = $("#imp-cancel"); if (cancel) cancel.onclick = () => { QQ.pending = null; viewQuote(); };
      const doImport = (replace) => async () => {
        const P = QQ.pending; const rows = qqBuildRows(P); if (!rows.length) return toast("No usable rows", true);
        const tbl = P.kind === "comps" ? "calc_components" : "calc_colors";
        if (replace) { const d = P.kind === "comps" ? await sb.from(tbl).delete().gte("id", 0) : await sb.from(tbl).delete().neq("color", ""); if (d.error) return toast(d.error.message, true); }
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, source: P.file }));
          const res = P.kind === "comps" ? await sb.from(tbl).insert(chunk) : await sb.from(tbl).upsert(chunk, { onConflict: "color" });
          if (res.error) return toast(res.error.message, true);
        }
        QQ.pending = null; await loadQQ(true); toast(`Imported ${rows.length} rows`); viewQuote();
      };
      const r1 = $("#imp-replace"); if (r1) r1.onclick = doImport(true);
      const r2 = $("#imp-add"); if (r2) r2.onclick = doImport(false);
      $("#load-parts").onclick = async () => {
        const { data, error } = await sb.from("part_prices").select("*").not("unit_cost", "is", null);
        if (error) return toast(error.message, true);
        const have = new Set(QQ.comps.map((c) => c.sku).filter(Boolean));
        const rows = data.filter((p) => !have.has(p.part_no)).map((p) => ({ sku: p.part_no, name: p.description || p.part_no, category: p.supplier || "Other", unit: "each", base_cost: num(p.unit_cost), color_applies: false, source: p.source || "Part costs" }));
        if (!rows.length) return toast("Nothing new to load");
        const res = await sb.from("calc_components").insert(rows); if (res.error) return toast(res.error.message, true);
        await loadQQ(true); toast(`Loaded ${rows.length} parts (color multiplier off for hardware; turn it on per part if needed)`); viewQuote();
      };
      $$("[data-capp]").forEach((cb) => cb.onchange = async () => { const { error } = await sb.from("calc_components").update({ color_applies: cb.checked }).eq("id", cb.dataset.capp); if (error) return toast(error.message, true); const x = QQ.comps.find((c) => String(c.id) === cb.dataset.capp); if (x) x.color_applies = cb.checked; });
    } };
}
function qqBuildRows(P) {
  const g = (r, k) => (P.map[k] >= 0 ? r[P.map[k]] : "");
  if (P.kind === "comps") return P.rows.map((r) => ({ name: String(g(r, "name") ?? "").trim(), base_cost: parseMoney(g(r, "cost")), sku: String(g(r, "sku") ?? "").trim() || null, unit: String(g(r, "unit") ?? "").trim() || "each", category: String(g(r, "category") ?? "").trim() || null })).filter((r) => r.name && r.base_cost != null);
  return P.rows.map((r) => { const raw = parseMoney(String(g(r, "mult") ?? "").replace("%", "")); return { color: String(g(r, "color") ?? "").trim(), multiplier: raw == null ? null : P.multMode === "pct" ? +(1 + raw / 100).toFixed(6) : raw }; }).filter((r) => r.color && r.multiplier != null);
}
