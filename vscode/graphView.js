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
const { WAITING_DIR, waitingSteps, openSteps } = require("./waiting.js");
const { audit } = require("./audit.js");

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

const STATES = {
  done: ["Done", "you ticked it, your reply settled it, or the agent reported it done"],
  replaced: ["Replaced", "asked again later in other words: see the newer step"],
  answered: ["Answered", "a question your next message answered"],
  closed: ["Closed", "its item was marked done"],
};

/**
 * The Waiting on you list: one row per step, newest first, history kept
 * (like the edits); open ones have a checkbox.
 * @param {ReturnType<typeof waitingSteps>} steps @param {ReturnType<typeof graphRows>["lanes"]} lanes
 */
function waitingBody(steps, lanes) {
  if (!steps.length) return `<tr><td colspan="7" class="empty">Nothing asked of you yet.</td></tr>`;
  const order = lanes.map((l) => l.session);
  const titles = new Map(lanes.map((l) => [l.session, l.title]));
  const color = (s) => {
    if (!order.includes(s)) order.push(s);
    return COLORS[order.indexOf(s) % COLORS.length];
  };
  const time = (t) => new Date(t).toLocaleString();
  return steps
    .map((w) => {
      const [icon, label] = KINDS[w.kind] ?? ["•", w.kind];
      const name = w.title ?? titles.get(w.session) ?? w.session.slice(0, 8);
      const q = [w.text, w.prompt, w.answer, w.note, w.session, name, label, w.state].join(" ");
      const mine = w.state === "done" && !w.by;
      const box = (on) => `<input type="checkbox" data-tick data-session="${esc(w.session)}" data-item="${esc(w.item)}" data-i="${w.i}"${on ? " checked" : ""} title="${on ? "Ticked by you: untick to reopen" : "Tick when you did or decided it"}">`;
      const status =
        w.state === "open" ? box(false)
        : mine ? box(true)
        : w.state === "done" ? `<span class="badge-ok" title="${esc(`${w.by}: ${w.note ?? ""}`)}">✓</span>`
        : w.state === "replaced" ? `<span class="badge-gone" title="${esc(STATES.replaced[1])}">replaced</span>`
        : `<span class="pill" title="${esc(STATES[w.state]?.[1] ?? "")}">${esc(STATES[w.state]?.[0] ?? w.state)}</span>`;
      const source = mine ? "you" : w.by ?? (w.answer ? esc(w.answer) : "");
      const more = [
        w.detail && w.detail !== w.text ? `<details><summary>Full message</summary><pre>${esc(w.detail)}</pre></details>` : "",
        w.prompt ? `<div class="meta">Request: ${esc(w.prompt)}</div>` : "",
        w.note ? `<div class="meta">${esc(w.by ?? "")}: ${esc(w.note)}</div>` : "",
        w.answer ? `<div class="meta">Your answer: ${esc(w.answer)}</div>` : "",
        ...(w.notes ?? []).map((n) => `<div class="meta">You wrote since: ${esc(n)}</div>`),
      ].join("");
      return `<tr class="w s-${w.state}" data-key="${esc(`${w.item} ${w.i}`)}" data-q="${esc(q)}"${w.state === "open" ? "" : " data-done"}
  data-vscode-context="${menu({ webviewSection: w.state === "open" ? "waiting-open" : "waiting-done", session: w.session, t: w.item, i: w.i, text: w.text })}">
  <td class="ok">${status}</td>
  <td class="k" title="${esc(label)}">${icon}</td>
  <td class="d" title="${esc(w.text)}">${esc(w.text)}</td>
  <td class="d p">${esc(w.prompt ?? "")}</td>
  <td class="t">${esc(time(w.t))}</td>
  <td class="s" style="color:${color(w.session)}" title="${esc(w.session)}">${esc(name)}</td>
  <td class="st">${source}</td>
</tr>
<tr class="x" hidden><td colspan="7"><div class="todo">${more || '<div class="meta">No more details.</div>'}</div></td></tr>`;
    })
    .join("\n");
}

/**
 * @param {ReturnType<typeof graphRows>} data @param {string} root @param {string} nonce
 * @param {ReturnType<typeof waitingSteps>} [waiting]
 */
function html(data, root, nonce, waiting = []) {
  const open = waiting.filter((w) => w.state === "open").length;
  // One session draws one straight line: the lanes only say something with several.
  const lanes = data.lanes.length > 1;
  const time = (t) => new Date(t).toLocaleString();
  const body = data.rows.length
    ? data.rows
        .map(
          (r, i) => `<tr${r.gone ? ' class="gone"' : ""} data-file="${esc(r.file)}" data-n="${r.n}" data-i="${i}" data-q="${esc([r.file, r.intent, r.summary, r.prompt, data.lanes[r.lane]?.title].join(" "))}"
  data-vscode-context="${menu({ webviewSection: r.accepted || r.gone ? "edit-ok" : "edit-open", file: r.file, n: r.n })}"${r.preview ? "" : ` title="${esc(r.prompt ? `Request: ${r.prompt}` : "")}"`}>
  <td class="ok">${r.gone ? `<span class="badge-gone" title="Later edits rewrote or removed all of it: nothing left to accept">replaced</span>` : r.accepted ? `<span class="badge-ok" title="Accepted">✓</span>` : `<span class="badge-open" title="Under review — Accept, or right-click">●</span><button class="acc" title="Accept this edit">Accept</button>`}</td>
  ${lanes ? `<td class="g">${laneSvg(i, r, data.lanes)}</td>` : ""}
  <td class="d" title="${esc([r.intent ?? r.summary, r.prompt && `Request: ${r.prompt}`].filter(Boolean).join("\n\n"))}">${esc(r.intent ?? r.summary)}</td>
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
  .badge-gone { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--vscode-disabledForeground, #888); color: var(--vscode-disabledForeground, #888); }
  tr.gone td.d, tr.gone td.f { opacity: .55; }
  .legend { display: flex; gap: 14px; align-items: center; opacity: .8; font-size: 12px; padding: 0 0 6px; }
  .badge-open { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 14px; }
  button.acc { display: none; font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 2px; cursor: pointer; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.acc:hover { background: var(--vscode-button-hoverBackground); }
  button.acc.on { display: inline-block; font-size: 12px; padding: 2px 10px; } button.acc.on[hidden] { display: none; }
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
  .todo label { display: inline; cursor: pointer; } .todo input { vertical-align: middle; margin: 0 4px 0 0; }
  .todo li.on span { text-decoration: line-through; opacity: .6; } .more.all { background: var(--vscode-testing-iconPassed, #73c991); }
  .todo pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); margin: 4px 0; } .todo summary { cursor: pointer; opacity: .8; }
  .todo .meta { opacity: .75; margin-top: 4px; }
  .todo .chat { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
</style></head><body>
<header><strong>Agent Change Graph</strong>
<nav><button data-tab="edits">Edits ${pending ? `<span class="badge">${pending}</span>` : ""}</button><button data-tab="waiting">Waiting on you ${open ? `<span class="badge">${open}</span>` : ""}</button></nav>
<input id="filter" placeholder="Filter by file, request or answer"><label id="ans" hidden><input type="checkbox" id="answered"> open only</label><button id="audit" class="acc on" hidden title="Haiku reviews the open list: closes what is done, answered or asked again">Audit</button>
<span class="n" id="count-edits">${data.rows.length} edits · ${pending} under review · ${data.lanes.length} sessions</span><span class="n" id="count-waiting">${open} open · ${waiting.length} steps</span></header>
<section id="edits"><div class="legend"><span><span class="badge-open">●</span> under review</span><span><span class="badge-ok">✓</span> accepted</span><span><span class="badge-gone">replaced</span> later edits rewrote or removed all of it</span></div><table><thead><tr><th>Status</th>${lanes ? "<th>Graph</th>" : ""}<th>Description</th><th>File</th><th>Date</th><th>Session</th><th>Changes</th></tr></thead>
<tbody>${body}</tbody></table></section>
<section id="waiting"><div class="legend"><span>☐ open: tick when done</span><span><span class="badge-ok">✓</span> done</span><span><span class="badge-gone">replaced</span> asked again later</span><span><span class="pill">Answered</span> question you answered</span></div>
<table><thead><tr><th>Status</th><th></th><th>Waiting for</th><th>Request</th><th>Date</th><th>Session</th><th>By</th></tr></thead>
<tbody>${waitingBody(waiting, data.lanes)}</tbody></table><p class="empty" id="none" hidden>Nothing open right now.</p></section>
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
  // Only the status cell opens it: the rest of the row stays free to click and read.
  document.querySelectorAll("tr[data-i]").forEach((tr) => {
    const r = rows[Number(tr.dataset.i)];
    const cell = tr.querySelector("td.ok");
    if (!r || !cell) return;
    cell.addEventListener("mouseenter", () => {
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
    cell.addEventListener("mouseleave", hideSoon);
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
    document.getElementById("audit").hidden = state.tab !== "waiting";
    const q = state.q.toLowerCase();
    document.querySelectorAll("tr[data-q]").forEach((tr) => {
      const show = tr.dataset.q.toLowerCase().includes(q) && (!state.answered || !("done" in tr.dataset));
      tr.style.display = show ? "" : "none";
      if (tr.nextElementSibling?.classList.contains("x")) tr.nextElementSibling.hidden = !show || !state.expanded.includes(tr.dataset.key);
    });
    document.getElementById("none").hidden = !state.answered || !!state.q || document.querySelector("tr.w.s-open") !== null;
  };
  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; apply(); }));
  filter.addEventListener("input", () => { state.q = filter.value; apply(); });
  answered.addEventListener("change", () => { state.answered = answered.checked; apply(); });
  document.querySelectorAll("tr.w").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest("input, a, button, details")) return;
    const k = tr.dataset.key;
    state.expanded = state.expanded.includes(k) ? state.expanded.filter((x) => x !== k) : [...state.expanded, k];
    apply();
  }));
  // Tick a step right in its row; the log keeps it, the refresh redraws it.
  document.querySelectorAll("input[data-tick]").forEach((box) => box.addEventListener("change", () => {
    vscode.postMessage({ type: "check", session: box.dataset.session, t: box.dataset.item, i: Number(box.dataset.i), on: box.checked });
  }));
  document.getElementById("audit").addEventListener("click", (e) => { e.target.disabled = true; e.target.textContent = "Auditing…"; vscode.postMessage({ type: "audit" }); });
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
/** @type {{openDiff: (file: string, n: number) => unknown, acceptEdit: (file: string, n: number) => unknown, goTo: (file: string, n: number) => unknown} | undefined} */
let actions;

/**
 * @param {string} root repo root
 * @param {(file: string, n: number) => unknown} openDiff
 * @param {(file: string) => string | undefined} currentText
 * @param {(file: string, n: number) => unknown} acceptEdit
 * @param {(file: string, n: number) => unknown} goTo
 */
function openGraph(root, openDiff, currentText, acceptEdit, goTo) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel("imprimatur.graph", "Agent Change Graph", vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === "check") return tick(m);
      if (m.type === "audit") return auditAll();
      return m.type === "accept" ? actions?.acceptEdit(m.file, m.n) : actions?.openDiff(m.file, m.n);
    });
    panel.onDidDispose(() => {
      panel = undefined;
      refresh = undefined;
      shown = undefined;
    });
  }
  const p = panel;
  shown = root;
  actions = {
    openDiff: (file, n) => openDiff(path.join(root, file), n),
    acceptEdit: (file, n) => acceptEdit(path.join(root, file), n),
    goTo: (file, n) => goTo(path.join(root, file), n),
  };
  refresh = () => {
    p.webview.html = html(graphRows(root, currentText), root, crypto.randomBytes(16).toString("hex"), waitingSteps(root));
  };
  refresh();
  p.reveal();
}

/**
 * Tick or untick one step of a waiting item, in the session's log (kept
 * across reloads). The page already shows it; the refresh the write causes
 * redraws the same. @param {{session: string, t: string, i: number, on: boolean}} m
 */
function tick(m) {
  if (!shown || !/^[\w-]+$/.test(m.session ?? "")) return;
  const log = path.join(shown, WAITING_DIR, `${m.session}.jsonl`);
  fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), session: m.session, kind: "check", item: m.t, i: m.i, on: !!m.on }) + "\n");
}

/** The Audit button: Haiku reviews every session's open steps (vscode/audit.js). */
async function auditAll() {
  if (!shown) return;
  const dir = path.join(shown, WAITING_DIR);
  const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n)) : [];
  const withOpen = logs.filter((l) => openSteps(l).length);
  let closed = 0;
  let failed = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Imprimatur: auditing Waiting on you" }, async () => {
    for (const log of withOpen) {
      try {
        closed += (await audit(log)).settled.length;
      } catch {
        failed++;
      }
    }
  });
  refreshGraph();
  vscode.window.showInformationMessage(
    `Audit: ${closed} step${closed === 1 ? "" : "s"} closed${failed ? `, ${failed} session${failed === 1 ? "" : "s"} could not be checked (is the claude CLI on PATH?)` : ""}.`,
  );
}

/** Re-render the open panel, if any (after an agent edit). */
const refreshGraph = () => refresh?.();

/** Right-click menu commands of the panel's rows; `c` is the row's data-vscode-context. */
const graphCommands = {
  "imprimatur.graph.acceptEdit": (c) => actions?.acceptEdit(c.file, c.n),
  "imprimatur.graph.openDiff": (c) => actions?.openDiff(c.file, c.n),
  "imprimatur.graph.goTo": (c) => actions?.goTo(c.file, c.n),
  /** Close a session's open asks by hand (the user did it, no reply needed). */
  /** Mark as done: tick that one step, as if its checkbox were ticked. */
  "imprimatur.graph.markDone": (c) => tick({ session: c.session, t: c.t, i: c.i, on: true }),
  "imprimatur.graph.copyAsk": (c) => vscode.env.clipboard.writeText(c.text ?? ""),
};

module.exports = { openGraph, refreshGraph, graphCommands, laneSvg, html };
