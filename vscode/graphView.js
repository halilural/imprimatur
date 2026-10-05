// @ts-check
// The Agent Change Graph panel (a webview): rows from graph.js, one colored
// lane per Claude session, click a row to open that edit's diff. A second tab,
// "Waiting on you", lists what the agent asked of the user (waiting.js).
"use strict";
const vscode = require("vscode");
const path = require("node:path");
const crypto = require("node:crypto");
const { graphRows } = require("./graph.js");
const { waitingItems } = require("./waiting.js");

const KINDS = { question: ["❓", "Question"], command: ["⚙", "Command"], verify: ["👀", "Verify / test"], input: ["✋", "Input"] };

const COLORS = ["#4fc1ff", "#c586c0", "#dcdcaa", "#4ec9b0", "#ce9178", "#9cdcfe", "#f48771", "#b5cea8"];
const LANE = 16;
const ROW = 28;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One row's piece of the graph: lane lines passing through, a dot on its own lane. */
function laneSvg(i, row, lanes) {
  const w = Math.max(1, lanes.length) * LANE;
  const parts = lanes.map((l, k) => {
    if (i < l.first || i > l.last) return "";
    const x = k * LANE + LANE / 2;
    const top = i === l.first ? ROW / 2 : 0;
    const bottom = i === l.last ? ROW / 2 : ROW;
    return top === bottom ? "" : `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${COLORS[k % COLORS.length]}" stroke-width="2"/>`;
  });
  const cx = row.lane * LANE + LANE / 2;
  parts.push(`<circle cx="${cx}" cy="${ROW / 2}" r="4.5" fill="${COLORS[row.lane % COLORS.length]}"/>`);
  return `<svg width="${w}" height="${ROW}">${parts.join("")}</svg>`;
}

/** @param {ReturnType<typeof waitingItems>} items @param {ReturnType<typeof graphRows>["lanes"]} lanes */
function waitingBody(items, lanes) {
  if (!items.length) return `<tr><td colspan="6" class="empty">Nothing asked of you yet.</td></tr>`;
  const order = lanes.map((l) => l.session);
  const titles = new Map(lanes.map((l) => [l.session, l.title]));
  const color = (s) => {
    if (!order.includes(s)) order.push(s);
    return COLORS[order.indexOf(s) % COLORS.length];
  };
  const time = (t) => new Date(t).toLocaleString();
  return items
    .map((w) => {
      const [icon, label] = KINDS[w.kind] ?? ["•", w.kind];
      const first = w.text.split("\n")[0];
      const full = [w.detail ?? w.text, w.prompt && `Request: ${w.prompt}`, w.answer && `Your answer: ${w.answer}`].filter(Boolean).join("\n\n");
      const name = w.title ?? titles.get(w.session) ?? w.session.slice(0, 8);
      const q = [w.text, w.prompt, w.answer, w.session, name, label].join(" ");
      return `<tr class="w${w.open ? "" : " done"}" data-key="${esc(`${w.session} ${w.t}`)}" data-q="${esc(q)}"${w.open ? "" : " data-done"}>
  <td class="k" title="${esc(label)}">${icon}</td>
  <td class="d">${esc(first)}</td>
  <td class="d p">${esc(w.prompt ?? "")}</td>
  <td class="t">${esc(time(w.t))}</td>
  <td class="s" style="color:${color(w.session)}" title="${esc(w.session)}">${esc(name)}</td>
  <td class="st">${w.open ? `<span class="open">open</span>` : `answered${w.answer ? `: ${esc(w.answer)}` : ""}`}</td>
</tr>
<tr class="x" hidden><td colspan="6"><pre>${esc(full)}</pre></td></tr>`;
    })
    .join("\n");
}

/**
 * @param {ReturnType<typeof graphRows>} data @param {string} root @param {string} nonce
 * @param {ReturnType<typeof waitingItems>} [waiting]
 */
function html(data, root, nonce, waiting = []) {
  const open = waiting.filter((w) => w.open).length;
  const time = (t) => new Date(t).toLocaleString();
  const body = data.rows.length
    ? data.rows
        .map(
          (r, i) => `<tr data-file="${esc(r.file)}" data-n="${r.n}" data-i="${i}" data-q="${esc([r.file, r.intent, r.summary, r.prompt, data.lanes[r.lane]?.title].join(" "))}"${r.preview ? "" : ` title="${esc(r.prompt ? `Request: ${r.prompt}` : "")}"`}>
  <td class="ok" title="${r.accepted ? "Accepted" : "Under review"}">${r.accepted ? "✓" : ""}</td>
  <td class="g">${laneSvg(i, r, data.lanes)}</td>
  <td class="d">${esc(r.intent ?? r.summary)}</td>
  <td class="f">${esc(r.file)} <span class="n">#${r.n}</span></td>
  <td class="t">${esc(time(r.t))}</td>
  <td class="s" style="color:${COLORS[r.lane % COLORS.length]}" title="${esc(r.session ?? "")}">${esc(data.lanes[r.lane]?.title ?? (r.session ?? "?").slice(0, 8))}</td>
  <td class="c"><span class="a">+${r.added}</span> <span class="r">−${r.removed}</span></td>
</tr>`,
        )
        .join("\n")
    : `<tr><td colspan="7" class="empty">No agent edits recorded in ${esc(root)} yet.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px; }
  header { display: flex; gap: 12px; align-items: center; padding: 10px 0; }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 280px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  td { padding: 0 8px; height: ${ROW}px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 520px; }
  td.ok { width: 1px; text-align: center; color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  td.g { padding: 0; width: 1px; } td.g svg { display: block; }
  tr[data-file] { cursor: pointer; } tr[data-file]:hover { background: var(--vscode-list-hoverBackground); }
  .n, .t { opacity: .75; } .a { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); } .r { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .empty { opacity: .7; padding: 12px; }
  nav { display: flex; gap: 4px; } nav button { background: none; color: var(--vscode-foreground); border: none; border-bottom: 2px solid transparent; padding: 4px 8px; cursor: pointer; opacity: .75; font: inherit; }
  nav button.on { border-bottom-color: var(--vscode-focusBorder); opacity: 1; font-weight: 600; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; font-size: 90%; }
  label { opacity: .85; } section[hidden] { display: none; }
  tr.w { cursor: pointer; } tr.w:hover { background: var(--vscode-list-hoverBackground); } tr.w.done { opacity: .6; }
  td.s { max-width: 200px; }
  td.k { width: 1px; text-align: center; } td.p { opacity: .75; max-width: 320px; } .open { color: var(--vscode-editorWarning-foreground, #cca700); font-weight: 600; }
  tr.x td { height: auto; white-space: normal; } tr.x pre { white-space: pre-wrap; margin: 4px 0 10px; font-family: var(--vscode-editor-font-family); }
  #pop { display: none; position: fixed; z-index: 10; max-width: 70vw; max-height: 60vh; overflow: hidden; padding: 6px 0;
    background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border); box-shadow: 0 2px 8px var(--vscode-widget-shadow);
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  #pop div { white-space: pre; padding: 0 8px; } #pop .p { font-family: var(--vscode-font-family); opacity: .8; padding-bottom: 4px; }
  #pop .m { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,.2)); }
  #pop .a { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,.15)); color: inherit; }
</style></head><body>
<header><strong>Agent Change Graph</strong>
<nav><button data-tab="edits">Edits</button><button data-tab="waiting">Waiting on you ${open ? `<span class="badge">${open}</span>` : ""}</button></nav>
<input id="filter" placeholder="Filter by file, request or answer"><label id="ans" hidden><input type="checkbox" id="answered"> show answered</label>
<span class="n" id="count-edits">${data.rows.length} edits · ${data.lanes.length} sessions</span><span class="n" id="count-waiting">${open} open · ${waiting.length - open} answered</span></header>
<section id="edits"><table><thead><tr><th title="Accepted">✓</th><th>Graph</th><th>Description</th><th>File</th><th>Date</th><th>Session</th><th>Changes</th></tr></thead>
<tbody>${body}</tbody></table></section>
<section id="waiting"><table><thead><tr><th></th><th>Waiting for</th><th>Request</th><th>Date</th><th>Session</th><th>Status</th></tr></thead>
<tbody>${waitingBody(waiting, data.lanes)}</tbody></table><p class="empty" id="none" hidden>Nothing open. Tick "show answered" for the rest.</p></section>
<div id="pop"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rows = ${JSON.stringify(data.rows.map((r) => (r.preview ? { prompt: r.prompt && `Request: ${r.prompt}`, preview: r.preview } : null))).replace(/</g, "\\u003c")};
  const pop = document.getElementById("pop");
  const line = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; return d; };
  document.querySelectorAll("tr[data-i]").forEach((tr) => {
    const r = rows[Number(tr.dataset.i)];
    if (!r) return;
    tr.addEventListener("mouseenter", () => {
      pop.replaceChildren(...(r.prompt ? [line("p", r.prompt)] : []),
        ...r.preview.map(([k, t]) => line(k === "-" ? "m" : k === "+" ? "a" : "", k === "…" ? "… " + t : k + " " + t)));
      pop.style.display = "block";
      const box = tr.getBoundingClientRect();
      const below = box.bottom + pop.offsetHeight < innerHeight;
      pop.style.left = Math.min(box.left + 40, innerWidth - pop.offsetWidth - 8) + "px";
      pop.style.top = (below ? box.bottom + 2 : Math.max(4, box.top - pop.offsetHeight - 2)) + "px";
    });
    tr.addEventListener("mouseleave", () => { pop.style.display = "none"; });
  });
  addEventListener("scroll", () => { pop.style.display = "none"; });
  document.querySelectorAll("tr[data-file]").forEach((tr) =>
    tr.addEventListener("click", () => vscode.postMessage({ file: tr.dataset.file, n: Number(tr.dataset.n) })));
  // Tab, filter and the answered toggle survive a refresh (the page is rebuilt on every agent edit).
  const state = Object.assign({ tab: "edits", q: "", answered: false, expanded: [] }, vscode.getState());
  const filter = document.getElementById("filter");
  const answered = document.getElementById("answered");
  filter.value = state.q;
  answered.checked = state.answered;
  const apply = () => {
    vscode.setState(state);
    for (const t of ["edits", "waiting"]) {
      document.getElementById(t).hidden = state.tab !== t;
      document.getElementById("count-" + t).hidden = state.tab !== t;
      document.querySelector('nav [data-tab="' + t + '"]').classList.toggle("on", state.tab === t);
    }
    document.getElementById("ans").hidden = state.tab !== "waiting";
    const q = state.q.toLowerCase();
    document.querySelectorAll("tr[data-q]").forEach((tr) => {
      const show = tr.dataset.q.toLowerCase().includes(q) && (state.answered || !("done" in tr.dataset));
      tr.style.display = show ? "" : "none";
      if (tr.nextElementSibling?.classList.contains("x")) tr.nextElementSibling.hidden = !show || !state.expanded.includes(tr.dataset.key);
    });
    document.getElementById("none").hidden = !${waiting.length > 0 ? "true" : "false"} || state.answered || !!state.q ||
      document.querySelector("tr.w:not(.done)") !== null;
  };
  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; apply(); }));
  filter.addEventListener("input", () => { state.q = filter.value; apply(); });
  answered.addEventListener("change", () => { state.answered = answered.checked; apply(); });
  document.querySelectorAll("tr.w").forEach((tr) => tr.addEventListener("click", () => {
    const k = tr.dataset.key;
    state.expanded = state.expanded.includes(k) ? state.expanded.filter((x) => x !== k) : [...state.expanded, k];
    apply();
  }));
  apply();
</script></body></html>`;
}

/** @type {vscode.WebviewPanel | undefined} */
let panel;
/** @type {(() => void) | undefined} */
let refresh;
/** @type {((m: {file: string, n: number}) => void) | undefined} */
let onRow;

/**
 * @param {string} root repo root
 * @param {(file: string, n: number) => void} openDiff
 * @param {(file: string) => string | undefined} currentText
 */
function openGraph(root, openDiff, currentText) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel("imprimatur.graph", "Agent Change Graph", vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.onDidReceiveMessage((m) => onRow?.(m));
    panel.onDidDispose(() => {
      panel = undefined;
      refresh = undefined;
    });
  }
  const p = panel;
  onRow = (m) => openDiff(path.join(root, m.file), m.n);
  refresh = () => {
    p.webview.html = html(graphRows(root, currentText), root, crypto.randomBytes(16).toString("hex"), waitingItems(root));
  };
  refresh();
  p.reveal();
}

/** Re-render the open panel, if any (after an agent edit). */
const refreshGraph = () => refresh?.();

module.exports = { openGraph, refreshGraph, laneSvg, html };
