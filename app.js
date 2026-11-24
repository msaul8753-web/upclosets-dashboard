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
  renderSync(); renderNav();
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
  { id: "schedule", label: "Schedule", ico: "▦" },
  { id: "crew", label: "Crew", ico: "☺" },
  { g: "Sales" },
  { id: "leads", label: "Leads", ico: "✦", count: () => D.leads.filter((l) => /^new$/i.test(l.status)).length },
  { id: "jobs", label: "Jobs", ico: "⚒", count: () => D.jobs.filter((j) => !/done|cancel/i.test(j.status)).length },
  { id: "clients", label: "Clients", ico: "☷" },
  { g: "Money" },
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
function barChart(points, { h = 190, color = "var(--orange)" } = {}) {
  const w = 640, pad = { l: 46, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.v));
  const step = (w - pad.l - pad.r) / Math.max(points.length, 1);
  const bw = Math.max(3, Math.min(28, step * 0.62));
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const every = Math.ceil(points.length / 8);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${ticks.map((t) => `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="#26262d"/><text x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${t >= 1000 ? "$" + Math.round(t / 1000) + "k" : "$" + Math.round(t)}</text>`).join("")}
    ${points.map((p, i) => { const x = pad.l + i * step + (step - bw) / 2; return `<rect x="${x}" y="${y(p.v)}" width="${bw}" height="${Math.max(0, h - pad.b - y(p.v))}" rx="3" fill="${color}"><title>${esc(p.label)}: ${money(p.v)}</title></rect>${i % every === 0 ? `<text x="${x + bw / 2}" y="${h - 8}" text-anchor="middle">${esc(p.short ?? p.label)}</text>` : ""}`; }).join("")}
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
  view(`<div class="page-head"><h2>Estimates</h2><div class="spacer"></div><span class="muted small">Editing estimates happens in Workiz for now. eCab import coming next.</span></div>${tb.html}${t.html}`);
  tb.mount(); t.mount();
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
  const l = D.leads.find((x) => x.workiz_id === leadId) || {};
  const E = existing ? structuredClone(existing) : { lead_id: leadId, design_name: "", files: [], parts: [], extras: [], labor_hours: 0, labor_rate: num(PB.settings.labor_rate), markup_pct: num(PB.settings.markup_pct), status: "draft" };
  E.parts ||= []; E.extras ||= []; E.files ||= [];
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
    $("#e-files").onchange = async (ev) => {
      const files = [...ev.target.files]; if (!files.length) return;
      toast(`Reading ${files.length} file(s)…`);
      for (const f of files) {
        const path = `designs/${leadId}/${Date.now()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
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
      const row = { lead_id: E.lead_id, design_name: E.design_name, files: E.files, parts: E.parts, extras: E.extras, labor_hours: E.labor_hours, labor_rate: E.labor_rate, markup_pct: E.markup_pct, materials_cost: c.partsCost, price: c.total, status: "draft" };
      const res = E.id ? await sb.from("design_imports").update(row).eq("id", E.id).select().single() : await sb.from("design_imports").insert(row).select().single();
      if (res.error) return toast(res.error.message, true);
      E.id = res.data.id; toast("Estimate saved"); render();
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
