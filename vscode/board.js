// @ts-check
// The board landing (#151): the top of the Home tab, after the ponytail board. Seven KPI cards
// with sparklines, one large area chart (its metric and range switched in the page, from the
// series embedded as JSON), the user's sessions and a 12-week activity heatmap. Numbers come
// from the stats module (#150). Inline SVG, no chart library.
"use strict";

const RANGE_DAYS = 90;

/** @param {unknown} s */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The metrics: key in the stats series, label, how a value reads. */
const METRICS = [
  { key: "tasksDone", label: "Tasks done", fmt: "n" },
  { key: "decisions", label: "Decisions", fmt: "n" },
  { key: "edits", label: "Agent edits", fmt: "n" },
  { key: "asks", label: "Asks of you", fmt: "n" },
  { key: "agentMs", label: "Agent time", fmt: "h" },
  { key: "cost", label: "Cost", fmt: "$" },
  { key: "tokens", label: "Tokens", fmt: "k" },
];

/** A value as the card shows it. @param {number} v @param {string} fmt */
function fmtValue(v, fmt) {
  if (fmt === "$") return `$${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
  if (fmt === "h") return `${(v / 3_600_000).toFixed(1)} h`;
  if (fmt === "k") return v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v));
  return String(Math.round(v));
}

/**
 * A sparkline: the series as a line and a soft area, w×h, the last point marked.
 * @param {number[]} xs @param {number} [w] @param {number} [h]
 */
function sparkline(xs, w = 120, h = 32) {
  if (!xs.length) return "";
  const max = Math.max(...xs, 0) || 1;
  const step = xs.length > 1 ? w / (xs.length - 1) : w;
  const pts = xs.map((v, i) => [i * step, h - 2 - (v / max) * (h - 4)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path class="sa" d="${line}L${w},${h}L0,${h}Z"/><path class="sl" d="${line}"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.2"/></svg>`;
}

/** The change from the period before, as "▲ 12%", "▼ 3%", "new" or "". @param {number} now @param {number} before */
function delta(now, before) {
  if (now === before) return "";
  if (!before) return "new";
  return `${now > before ? "▲" : "▼"} ${Math.abs(Math.round(((now - before) / before) * 100))}%`;
}

/**
 * The 12-week heatmap: one cell a day, Monday at the top, the week columns left to right,
 * today the last; a day's activity is its records, edits, asks and sessions together.
 * @param {string[]} days the series' days, oldest first @param {number[]} activity per day
 */
function heatmap(days, activity) {
  const n = Math.min(84, days.length);
  const ds = days.slice(-n), act = activity.slice(-n);
  // The first column starts on the Monday on or before the first day.
  const dow = (/** @type {string} */ d) => (new Date(`${d}T12:00:00`).getDay() + 6) % 7;
  const lead = dow(ds[0]);
  const max = Math.max(...act, 0) || 1;
  const level = (/** @type {number} */ v) => (v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999)));
  const C = 11, G = 3;
  const cells = ds.map((d, i) => {
    const k = i + lead;
    return `<rect x="${Math.floor(k / 7) * (C + G)}" y="${(k % 7) * (C + G)}" width="${C}" height="${C}" rx="2" class="h${level(act[i])}"><title>${d}: ${act[i]}</title></rect>`;
  }).join("");
  const cols = Math.ceil((n + lead) / 7);
  let streak = 0;
  for (let i = act.length - 1; i >= 0 && act[i] > 0; i--) streak++;
  const active = act.filter((v) => v > 0).length;
  return { svg: `<svg class="heat" viewBox="0 0 ${cols * (C + G)} ${7 * (C + G)}" width="${cols * (C + G)}" height="${7 * (C + G)}" role="img" aria-label="Activity, last 12 weeks">${cells}</svg>`, active, streak, days: n };
}

/**
 * The board's model from a stats result: the cards (last 7 days next to the 7 before), the
 * chart's series (90 days), the sessions and the heatmap.
 * @param {ReturnType<typeof import("./stats.js").statsOf>} s days: RANGE_DAYS
 */
function boardModel(s) {
  const sum = (/** @type {number[]} */ xs, /** @type {number} */ from, /** @type {number} */ to) => xs.slice(from, to).reduce((a, b) => a + b, 0);
  const L = s.days.length;
  const cards = METRICS.map((m) => {
    const xs = s.series[m.key] ?? [];
    return { ...m, now: sum(xs, L - 7, L), before: sum(xs, L - 14, L - 7), spark: xs.slice(-14) };
  });
  // Waiting on you is now, not a sum: its card shows the count and the asks of the last two weeks.
  cards.splice(3, 1, { key: "waiting", label: "Waiting on you", fmt: "n", now: s.waiting, before: s.waiting, spark: (s.series.asks ?? []).slice(-14) });
  const act = s.days.map((_, i) => ["records", "edits", "asks", "sessions"].reduce((a, k) => a + (s.series[k]?.[i] ?? 0), 0));
  return { cards, days: s.days, series: Object.fromEntries(METRICS.map((m) => [m.key, s.series[m.key] ?? []])), sessions: s.sessionList.slice(0, 12), heat: heatmap(s.days, act) };
}

/** The board's HTML (the chart is drawn by the page script from #board-data). @param {ReturnType<typeof boardModel>} b */
function boardHtml(b) {
  const cards = b.cards.map((c) => {
    const d = delta(c.now, c.before);
    const up = c.now >= c.before;
    return `<div class="kpi" data-k="kpi-${c.key}"><div class="kl">${esc(c.label)}</div><div class="kv">${fmtValue(c.now, c.fmt)}</div><div class="kd${d && c.key !== "waiting" ? (up ? " up" : " down") : ""}">${c.key === "waiting" ? "now" : d ? `${d} <span class="dim">vs 7 days before</span>` : "last 7 days"}</div>${sparkline(c.spark)}</div>`;
  }).join("");
  const metric = METRICS.map((m, i) => `<button class="fpill${i === 5 ? " on" : ""}" data-act="bmetric" data-m="${m.key}" aria-pressed="${i === 5}">${esc(m.label)}</button>`).join("");
  const range = [["7", "7d"], ["30", "30d"], ["90", "90d"]].map(([v, l]) => `<button class="fpill${v === "30" ? " on" : ""}" data-act="brange" data-r="${v}" aria-pressed="${v === "30"}">${l}</button>`).join("");
  const money = (/** @type {number} */ v) => `$${v.toFixed(2)}`;
  const when = (/** @type {number} */ t) => new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const dur = (/** @type {number} */ ms) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`);
  const rows = b.sessions.map((x) => `<tr data-k="s-${esc(x.session)}"><td class="sp" title="${esc(x.prompt)}">${esc(x.prompt || "(no prompt)")}</td><td class="dim">${when(x.started)}</td><td>${dur(x.last - x.started)}</td><td>${money(x.cost)}</td><td>${fmtValue(x.tokens, "k")}</td><td>${x.turns}</td><td>${x.edits}</td></tr>`).join("");
  const table = `<section class="card bsess" data-k="bsess" aria-label="Sessions"><h2 class="cap">Your sessions <span class="dim">· the first prompt of each</span></h2><div class="tablewrap"><table class="htable"><thead><tr><th>First prompt</th><th>Started</th><th>Time</th><th>Cost</th><th>Tokens</th><th>Turns</th><th>Edits</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">No sessions in the last 90 days.</td></tr>'}</tbody></table></div></section>`;
  const h = b.heat;
  const heat = `<section class="card bheat" data-k="bheat" aria-label="Activity"><h2 class="cap row"><span>Activity, 12 weeks</span><span class="dim">${h.active} active day${h.active === 1 ? "" : "s"} · streak ${h.streak}</span></h2>${h.svg}<div class="hlegend dim">less <i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i> more</div></section>`;
  const data = JSON.stringify({ days: b.days, series: b.series, metrics: METRICS }).replace(/</g, "\\u003c");
  return `<div class="board" data-k="board"><div class="kpis" data-k="kpis">${cards}</div>
<section class="card bchart" data-k="bchart" aria-label="Chart"><div class="bhead"><div class="seg" role="group" aria-label="Metric">${metric}</div><div class="seg" role="group" aria-label="Range">${range}</div></div><div id="bchart" class="bplot"></div></section>
<div class="grid2 bgrid" data-k="bgrid">${table}${heat}</div><script type="application/json" id="board-data">${data}</script></div>`;
}

const BOARD_CSS = `
  .board { display: flex; flex-direction: column; gap: 14px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .kpi { background: var(--b-card, var(--surface)); border: 1px solid var(--line); border-radius: var(--r-md); padding: 10px 12px 8px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .kpi .kl { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
  .kpi .kv { font-size: var(--fs-h1); font-weight: 700; font-family: var(--mono, inherit); }
  .kpi .kd { font-size: var(--fs-xs); color: var(--muted); }
  .kpi .kd.up { color: var(--pass); } .kpi .kd.down { color: var(--warn); }
  .spark { width: 100%; height: 32px; margin-top: 4px; }
  .spark .sl { fill: none; stroke: var(--acc); stroke-width: 1.6; } .spark .sa { fill: var(--acc-soft); } .spark circle { fill: var(--acc); }
  .bchart { padding: 12px; } .bhead { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .bplot svg { width: 100%; height: 220px; display: block; }
  .bplot .al { fill: none; stroke: var(--acc); stroke-width: 2; } .bplot .aa { fill: var(--acc-soft); }
  .bplot .gl { stroke: var(--line); stroke-width: 1; } .bplot text { fill: var(--muted); font-size: 10px; }
  .bgrid { grid-template-columns: minmax(0, 7fr) minmax(260px, 3fr); align-items: start; }
  .bsess .tablewrap { overflow-x: auto; } .bsess td, .bsess th { white-space: nowrap; }
  .bsess td.sp { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .heat { width: 100%; height: auto; margin-top: 6px; }
  .heat .h0, .hlegend .h0 { fill: var(--b-hover, var(--line)); background: var(--b-hover, var(--line)); }
  .heat .h1, .hlegend .h1 { fill: color-mix(in srgb, var(--acc) 30%, transparent); background: color-mix(in srgb, var(--acc) 30%, transparent); }
  .heat .h2, .hlegend .h2 { fill: color-mix(in srgb, var(--acc) 55%, transparent); background: color-mix(in srgb, var(--acc) 55%, transparent); }
  .heat .h3, .hlegend .h3 { fill: color-mix(in srgb, var(--acc) 78%, transparent); background: color-mix(in srgb, var(--acc) 78%, transparent); }
  .heat .h4, .hlegend .h4 { fill: var(--acc); background: var(--acc); }
  .hlegend { display: flex; align-items: center; gap: 3px; font-size: var(--fs-xs); margin-top: 6px; } .hlegend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  @media (max-width: 760px) { .bgrid { grid-template-columns: 1fr; } }
`;

/**
 * The page script's chart (#151): the chosen metric over the chosen range, as an area with a
 * grid and the max, from #board-data. A string, put into the page script as it is.
 */
const BOARD_SCRIPT = `
  function drawBoard() {
    const el = document.getElementById("bchart"), src = document.getElementById("board-data");
    if (!el || !src) return;
    let d;
    try { d = JSON.parse(src.textContent); } catch { return; }
    const b = state.board || (state.board = { m: "cost", r: 30 });
    document.querySelectorAll('#pane [data-act="bmetric"]').forEach((x) => { x.classList.toggle("on", x.dataset.m === b.m); x.setAttribute("aria-pressed", String(x.dataset.m === b.m)); });
    document.querySelectorAll('#pane [data-act="brange"]').forEach((x) => { x.classList.toggle("on", Number(x.dataset.r) === b.r); x.setAttribute("aria-pressed", String(Number(x.dataset.r) === b.r)); });
    const meta = d.metrics.find((m) => m.key === b.m) || d.metrics[0];
    // Only numbers and YYYY-MM-DD days go into the SVG; the label is escaped.
    const xs = (d.series[meta.key] || []).slice(-b.r).map((v) => Number(v) || 0), days = d.days.slice(-b.r).map((x) => (/^\\d{4}-\\d{2}-\\d{2}$/.test(x) ? x : ""));
    const label = String(meta.label).replace(/[&<>"']/g, "");
    const W = 800, H = 220, P = 26, max = Math.max(...xs, 0) || 1;
    const fmt = (v) => meta.fmt === "$" ? "$" + (v >= 100 ? Math.round(v) : v.toFixed(2)) : meta.fmt === "h" ? (v / 3600000).toFixed(1) + " h" : meta.fmt === "k" ? (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v))) : String(Math.round(v));
    const step = xs.length > 1 ? (W - P) / (xs.length - 1) : 0;
    const pts = xs.map((v, i) => [P + i * step, H - 18 - (v / max) * (H - 36)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join("");
    const grid = [0, 0.5, 1].map((f) => { const y = H - 18 - f * (H - 36); return '<line class="gl" x1="' + P + '" x2="' + W + '" y1="' + y + '" y2="' + y + '"/><text x="0" y="' + (y + 3) + '">' + fmt(max * f) + "</text>"; }).join("");
    const labels = days.length ? '<text x="' + P + '" y="' + (H - 2) + '">' + days[0].slice(5) + '</text><text x="' + (W - 36) + '" y="' + (H - 2) + '">' + days[days.length - 1].slice(5) + "</text>" : "";
    const total = xs.reduce((a, v) => a + v, 0);
    const dots = pts.map((p, i) => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="6" fill="transparent"><title>' + days[i] + ": " + fmt(xs[i]) + "</title></circle>").join("");
    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + label + ", last " + b.r + ' days">' + grid + (line ? '<path class="aa" d="' + line + "L" + pts[pts.length - 1][0].toFixed(1) + "," + (H - 18) + "L" + P + "," + (H - 18) + 'Z"/><path class="al" d="' + line + '"/>' : "") + labels + dots + "</svg>" + '<div class="dim" style="font-size: 11px; margin-top: 4px;">' + label + ": " + fmt(total) + " in the last " + b.r + " days</div>";
  }
`;

module.exports = { boardModel, boardHtml, sparkline, heatmap, delta, fmtValue, BOARD_CSS, BOARD_SCRIPT, RANGE_DAYS, METRICS };
