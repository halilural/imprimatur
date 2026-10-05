// @ts-check
// The Agent Change Graph panel (a webview): rows from graph.js, one colored
// lane per Claude session, click a row to open that edit's diff, Accept an
// edit from its row or its right-click menu. A second tab, "Waiting on you",
// lists what the agent asked of the user (waiting.js), its asks as a list.
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { graphRows } = require("./graph.js");
const { WAITING_DIR, waitingItems } = require("./waiting.js");

const KINDS = { question: ["❓", "Question"], command: ["⚙", "Command"], verify: ["👀", "Verify / test"], input: ["✋", "Input"] };

const COLORS = ["#4fc1ff", "#c586c0", "#dcdcaa", "#4ec9b0", "#ce9178", "#9cdcfe", "#f48771", "#b5cea8"];
const LANE = 16;
const ROW = 28;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A row's right-click menu context (webview/context `when` clauses read it). */
const menu = (o) => esc(JSON.stringify({ ...o, preventDefaultContextMenuItems: true }));

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
      const asks = w.text.split("\n").filter((l) => l.trim());
      // The closing line is usually the actual ask; the rest are its steps.
      const head = asks[asks.length - 1] ?? "";
      const name = w.title ?? titles.get(w.session) ?? w.session.slice(0, 8);
      const q = [w.text, w.prompt, w.answer, w.session, name, label].join(" ");
      const status = w.open ? `<span class="pill open">open</span>` : w.done ? `<span class="pill">done</span>` : `<span class="pill">answered</span>${w.answer ? ` ${esc(w.answer)}` : ""}`;
      const details = w.detail && w.detail !== w.text ? `<details><summary>${w.kind === "verify" || w.kind === "question" ? "Full message" : "Details"}</summary><pre>${esc(w.detail)}</pre></details>` : "";
      return `<tr class="w${w.open ? "" : " done"}" data-key="${esc(`${w.session} ${w.t}`)}" data-q="${esc(q)}"${w.open ? "" : " data-done"}
  data-vscode-context="${menu({ webviewSection: w.open ? "waiting-open" : "waiting-done", session: w.session, text: w.text })}">
  <td class="k" title="${esc(label)}">${icon}</td>
  <td class="d">${esc(head)}${asks.length > 1 ? ` <span class="more">+${asks.length - 1}</span>` : ""}</td>
  <td class="d p">${esc(w.prompt ?? "")}</td>
  <td class="t">${esc(time(w.t))}</td>
  <td class="s" style="color:${color(w.session)}" title="${esc(w.session)}">${esc(name)}</td>
  <td class="st">${status}</td>
</tr>
<tr class="x" hidden><td colspan="6"><div class="todo">
  <div class="h">What you need to do</div>
  <ol>${asks.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>
  ${details}
  ${w.prompt ? `<div class="meta">Request: ${esc(w.prompt)}</div>` : ""}${w.answer ? `<div class="meta">Your answer: ${esc(w.answer)}</div>` : ""}
</div></td></tr>`;
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
          (r, i) => `<tr data-file="${esc(r.file)}" data-n="${r.n}" data-i="${i}" data-q="${esc([r.file, r.intent, r.summary, r.prompt, data.lanes[r.lane]?.title].join(" "))}"
  data-vscode-context="${menu({ webviewSection: r.accepted ? "edit-ok" : "edit-open", file: r.file, n: r.n })}"${r.preview ? "" : ` title="${esc(r.prompt ? `Request: ${r.prompt}` : "")}"`}>
  <td class="ok">${r.accepted ? `<span class="badge-ok" title="Accepted">✓</span>` : `<span class="badge-open" title="Under review — Accept, or right-click">●</span><button class="acc" title="Accept this edit">Accept</button>`}</td>
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
  const pending = data.rows.filter((r) => !r.accepted).length;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px; }
  header { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 0; }
  header > *, nav button { white-space: nowrap; }
  label { display: inline-flex; align-items: center; gap: 4px; } label input { margin: 0; }
  #filter { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 280px; max-width: 100%; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  td { padding: 0 8px; height: ${ROW}px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 520px; }
  td.ok { width: 64px; min-width: 64px; text-align: center; }
  .badge-ok { display: inline-flex; width: 18px; height: 18px; border-radius: 50%; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
    background: var(--vscode-testing-iconPassed, #73c991); color: var(--vscode-editor-background); }
  .badge-open { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 14px; }
  button.acc { display: none; font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 2px; cursor: pointer; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.acc:hover { background: var(--vscode-button-hoverBackground); }
  tr:hover button.acc { display: inline-block; } tr:hover .badge-open { display: none; }
  td.g { padding: 0; width: 1px; } td.g svg { display: block; }
  tr[data-file] { cursor: pointer; } tr[data-file]:hover, tr.w:hover { background: var(--vscode-list-hoverBackground); }
  .n, .t { opacity: .75; } .a { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); } .r { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .empty { opacity: .7; padding: 12px; }
  #pop { display: none; position: fixed; z-index: 10; max-width: min(900px, 92vw); max-height: 55vh; overflow: auto; padding: 6px 0;
    background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border); box-shadow: 0 2px 8px var(--vscode-widget-shadow);
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  #pop div { white-space: pre-wrap; word-break: break-word; padding: 0 8px; } #pop .p { font-family: var(--vscode-font-family); opacity: .8; padding-bottom: 4px; }
  #pop .m { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,.2)); }
  #pop .a { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,.15)); color: inherit; }
  nav { display: flex; gap: 4px; } nav button { background: none; color: var(--vscode-foreground); border: none; border-bottom: 2px solid transparent; padding: 4px 8px; cursor: pointer; opacity: .75; font: inherit; }
  nav button.on { border-bottom-color: var(--vscode-focusBorder); opacity: 1; font-weight: 600; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; font-size: 90%; }
  section[hidden] { display: none; }
  tr.w { cursor: pointer; } tr.w.done { opacity: .6; }
  td.k { width: 1px; text-align: center; } td.p { opacity: .75; max-width: 320px; } td.s { max-width: 200px; }
  .more { font-size: 11px; opacity: .7; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--vscode-panel-border); }
  .pill.open { border-color: var(--vscode-editorWarning-foreground, #cca700); color: var(--vscode-editorWarning-foreground, #cca700); font-weight: 600; }
  tr.x td { height: auto; white-space: normal; max-width: none; }
  .todo { margin: 4px 0 12px 28px; padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); background: var(--vscode-textBlockQuote-background); }
  .todo .h { font-weight: 600; margin-bottom: 4px; } .todo ol { margin: 0 0 6px; padding-left: 20px; } .todo li { margin: 2px 0; }
  .todo pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); margin: 4px 0; } .todo summary { cursor: pointer; opacity: .8; }
  .todo .meta { opacity: .75; margin-top: 4px; }
</style></head><body>
<header><strong>Agent Change Graph</strong>
<nav><button data-tab="edits">Edits ${pending ? `<span class="badge">${pending}</span>` : ""}</button><button data-tab="waiting">Waiting on you ${open ? `<span class="badge">${open}</span>` : ""}</button></nav>
<input id="filter" placeholder="Filter by file, request or answer"><label id="ans" hidden><input type="checkbox" id="answered"> show answered</label>
<span class="n" id="count-edits">${data.rows.length} edits · ${pending} under review · ${data.lanes.length} sessions</span><span class="n" id="count-waiting">${open} open · ${waiting.length - open} answered</span></header>
<section id="edits"><table><thead><tr><th>Status</th><th>Graph</th><th>Description</th><th>File</th><th>Date</th><th>Session</th><th>Changes</th></tr></thead>
<tbody>${body}</tbody></table></section>
<section id="waiting"><table><thead><tr><th></th><th>Waiting for</th><th>Request</th><th>Date</th><th>Session</th><th>Status</th></tr></thead>
<tbody>${waitingBody(waiting, data.lanes)}</tbody></table><p class="empty" id="none" hidden>Nothing open. Tick "show answered" for the rest.</p></section>
<div id="pop"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rows = ${JSON.stringify(data.rows.map((r) => (r.preview ? { prompt: r.prompt && `Request: ${r.prompt}`, preview: r.preview } : null))).replace(/</g, "\\u003c")};
  // Hover diff: stays while the pointer is on the row or the popup itself.
  const pop = document.getElementById("pop");
  let hideTimer;
  const hide = () => { pop.style.display = "none"; };
  const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 250); };
  pop.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  pop.addEventListener("mouseleave", hideSoon);
  const line = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; return d; };
  document.querySelectorAll("tr[data-i]").forEach((tr) => {
    const r = rows[Number(tr.dataset.i)];
    if (!r) return;
    tr.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
      pop.replaceChildren(...(r.prompt ? [line("p", r.prompt)] : []),
        ...r.preview.map(([k, t]) => line(k === "-" ? "m" : k === "+" ? "a" : "", k === "…" ? "… " + t : k + " " + t)));
      pop.scrollTop = 0;
      pop.style.display = "block";
      const box = tr.getBoundingClientRect();
      const below = box.bottom + pop.offsetHeight < innerHeight;
      pop.style.left = Math.max(4, Math.min(box.left + 40, innerWidth - pop.offsetWidth - 8)) + "px";
      pop.style.top = (below ? box.bottom : Math.max(4, box.top - pop.offsetHeight)) + "px";
    });
    tr.addEventListener("mouseleave", hideSoon);
  });
  document.querySelectorAll("tr[data-file]").forEach((tr) => {
    const msg = (type) => vscode.postMessage({ type, file: tr.dataset.file, n: Number(tr.dataset.n) });
    tr.addEventListener("click", () => msg("open"));
    tr.querySelector("button.acc")?.addEventListener("click", (e) => { e.stopPropagation(); hide(); msg("accept"); });
  });
  // Tab, filter, the answered toggle and opened rows survive a refresh (the page is rebuilt on every agent edit).
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
  addEventListener("scroll", hide);
  apply();
</script></body></html>`;
}

/** @type {vscode.WebviewPanel | undefined} */
let panel;
/** @type {(() => void) | undefined} */
let refresh;
/** @type {string | undefined} repo root the open panel shows */
let shown;
/** @type {{openDiff: (file: string, n: number) => unknown, acceptEdit: (file: string, n: number) => unknown} | undefined} */
let actions;

/**
 * @param {string} root repo root
 * @param {(file: string, n: number) => unknown} openDiff
 * @param {(file: string) => string | undefined} currentText
 * @param {(file: string, n: number) => unknown} acceptEdit
 */
function openGraph(root, openDiff, currentText, acceptEdit) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel("imprimatur.graph", "Agent Change Graph", vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.onDidReceiveMessage((m) => (m.type === "accept" ? actions?.acceptEdit(m.file, m.n) : actions?.openDiff(m.file, m.n)));
    panel.onDidDispose(() => {
      panel = undefined;
      refresh = undefined;
      shown = undefined;
    });
  }
  const p = panel;
  shown = root;
  actions = { openDiff: (file, n) => openDiff(path.join(root, file), n), acceptEdit: (file, n) => acceptEdit(path.join(root, file), n) };
  refresh = () => {
    p.webview.html = html(graphRows(root, currentText), root, crypto.randomBytes(16).toString("hex"), waitingItems(root));
  };
  refresh();
  p.reveal();
}

/** Re-render the open panel, if any (after an agent edit). */
const refreshGraph = () => refresh?.();

/** Right-click menu commands of the panel's rows; `c` is the row's data-vscode-context. */
const graphCommands = {
  "imprimatur.graph.acceptEdit": (c) => actions?.acceptEdit(c.file, c.n),
  "imprimatur.graph.openDiff": (c) => actions?.openDiff(c.file, c.n),
  /** Close a session's open asks by hand (the user did it, no reply needed). */
  "imprimatur.graph.markDone": (c) => {
    if (!shown || !/^[\w-]+$/.test(c.session ?? "")) return;
    const log = path.join(shown, WAITING_DIR, `${c.session}.jsonl`);
    fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), session: c.session, kind: "done" }) + "\n");
    refreshGraph();
  },
  "imprimatur.graph.copyAsk": (c) => vscode.env.clipboard.writeText(c.text ?? ""),
};

module.exports = { openGraph, refreshGraph, graphCommands, laneSvg, html };
