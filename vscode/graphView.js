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
const os = require("node:os");
const { graphRows } = require("./graph.js");
const { WAITING_DIR, waitingSteps, openSteps } = require("./waiting.js");
const { audit } = require("./audit.js");
const { scanHistory, scannedBefore } = require("./history.js");
const { placeOf } = require("./tasks.js");
const records = require("./records.js");
const { scanTodos } = require("./history.js");
const { closeDoneTasks } = require("./todo-done.js");
const { scopeCss } = require("./preview.js");

/** The preview's marks (preview.css), for the hover's rendered review (#50); read once. */
let reviewCss;
const reviewStyle = () => (reviewCss ??= (() => {
  try {
    return scopeCss(fs.readFileSync(path.join(__dirname, "preview.css"), "utf8"), "#pop .review");
  } catch {
    return "";
  }
})());

const KINDS = { question: ["❓", "Question"], command: ["⚙", "Command"], verify: ["👀", "Verify / test"], input: ["✋", "Input"] };

const COLORS = ["#4fc1ff", "#c586c0", "#dcdcaa", "#4ec9b0", "#ce9178", "#9cdcfe", "#f48771", "#b5cea8"];
const LANE = 16;
const ROW = 28;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A row's right-click menu context (webview/context `when` clauses read it). */
const menu = (o) => esc(JSON.stringify({ ...o, preventDefaultContextMenuItems: true }));

/**
 * Each lane's column: a lane takes the first column free by its first row, as
 * in git graphs, so tasks that never overlap share one and the graph stays narrow.
 * @param {Array<{first: number, last: number}>} lanes @returns {number[]}
 */
function columnsOf(lanes) {
  /** @type {number[]} last row of the lane now in each column */
  const busy = [];
  return lanes.map((l) => {
    let c = busy.findIndex((last) => last < l.first);
    if (c < 0) c = busy.push(0) - 1;
    busy[c] = l.last;
    return c;
  });
}

/** One row's piece of the graph: lane lines passing through, a dot on its own lane. */
function laneSvg(i, row, lanes, cols = columnsOf(lanes)) {
  const w = Math.max(1, ...cols.map((c) => c + 1)) * LANE;
  const parts = lanes.map((l, k) => {
    if (i < l.first || i > l.last) return "";
    const x = cols[k] * LANE + LANE / 2;
    const top = i === l.first ? ROW / 2 : 0;
    const bottom = i === l.last ? ROW / 2 : ROW;
    return top === bottom ? "" : `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${COLORS[k % COLORS.length]}" stroke-width="2"/>`;
  });
  const cx = cols[row.lane] * LANE + LANE / 2;
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
 * @param {ReturnType<typeof waitingSteps>} steps @param {ReturnType<typeof graphRows>["sessions"]} sessions
 * @param {string} root
 */
function waitingBody(steps, sessions, root) {
  const sessions_ = records.sessionTasks(root);
  const cache = new Map();
  if (!steps.length) return `<tr><td colspan="7" class="empty">Nothing asked of you yet.</td></tr>`;
  const order = sessions.map((l) => l.session);
  const titles = new Map(sessions.map((l) => [l.session, l.title]));
  const color = (s) => {
    if (!order.includes(s)) order.push(s);
    return COLORS[order.indexOf(s) % COLORS.length];
  };
  const time = (t) => new Date(t).toLocaleString();
  return steps
    .map((w) => {
      const [icon, label] = KINDS[w.kind] ?? ["•", w.kind];
      const name = w.title ?? titles.get(w.session) ?? w.session.slice(0, 8);
      const q = [w.text, w.why, w.task, w.prompt, w.answer, w.note, w.session, name, label, w.state].join(" ");
      const mine = w.state === "done" && !w.by;
      const box = (on) => `<input type="checkbox" data-tick data-session="${esc(w.session)}" data-item="${esc(w.item)}" data-i="${w.i}"${on ? " checked" : ""} title="${on ? "Ticked by you: untick to reopen" : "Tick when you did or decided it"}">`;
      const status =
        w.state === "open" ? box(false)
        : mine ? box(true)
        : w.state === "done" ? `<span class="badge-ok" title="${esc(`${w.by}: ${w.note ?? ""}`)}">✓</span>`
        : w.state === "replaced" ? `<span class="badge-gone" title="${esc(STATES.replaced[1])}">replaced</span>`
        : `<span class="pill" title="${esc(STATES[w.state]?.[1] ?? "")}">${esc(STATES[w.state]?.[0] ?? w.state)}</span>`;
      const source = mine ? "you" : w.by ?? (w.answer ? esc(w.answer) : "");
      // The task and its record (vscode/tasks.js): the key opens its issue or Jira page, the record icon shows the record.
      const place = placeOf(root, w, sessions_, cache);
      const open = (cls, attrs, label, title) => `<a href="#" class="task ${cls}" ${attrs} title="${esc(title)}">${label}</a>`;
      // No page: the key shows the task in Imprimatur's Tasks view.
      const key = place.task
        ? open("key", place.url ? `data-url="${esc(place.url)}"` : `data-task="${esc(place.task)}"`, esc(place.task), place.url ?? `Show ${place.task} in Tasks`)
        : "";
      // The badge names the task: the text need not start with it too ("LATD-13937: …").
      const stepText = place.task && w.text.startsWith(place.task) ? w.text.slice(place.task.length).replace(/^[\s:–—-]+/, "") || w.text : w.text;
      // Before the text: a long text is cut at the end of the cell (…), and the icon must stay.
      const file = place.record ? open("file", `data-record="${place.record}"`, "📄", `Show the record in ${place.task}`) : "";
      const more = [
        w.why ? `<div class="why">${esc(w.why)}</div>` : "",
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
  <td class="d" title="${esc([w.text, w.why].filter(Boolean).join("\n"))}">${key}${file}${esc(stepText)}</td>
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
  // One task draws one straight line: the lanes only say something with several.
  const lanes = data.lanes.length > 1;
  const cols = columnsOf(data.lanes);
  const time = (t) => new Date(t).toLocaleString();
  const sessionTitle = new Map(data.sessions.map((s) => [s.session, s.title]));
  // Each lane's task, as in Waiting on you: the key opens its issue or Jira page (else the task in Tasks), then its title.
  const cache = new Map();
  const taskCell = data.lanes.map((l, k) => {
    const color = `style="color:${COLORS[k % COLORS.length]}"`;
    if (!l.task) return `<span class="none" ${color} title="No todos/ file, branch or key names its task">No task</span>`;
    const place = placeOf(root, { session: "", text: "", task: l.task }, new Map(), cache);
    const target = place.url ? `data-url="${esc(place.url)}"` : `data-task="${esc(l.task)}"`;
    const key = `<a href="#" class="task key" ${target} title="${esc(place.url ?? `Show ${l.task} in Tasks`)}">${esc(l.task)}</a>`;
    return `${key}<span ${color}>${esc(l.title ?? "")}</span>`;
  });
  // A record change: shown in its task's lane; it opens the record, nothing to accept (#60).
  const recordRow = (r, i) => `<tr class="rec" data-record="${r.record}" data-i="${i}" data-q="${esc([r.file, r.intent, r.task, data.lanes[r.lane]?.title, sessionTitle.get(r.session ?? "")].join(" "))}" title="Record change: click to show the record">
  <td class="ok"><span class="badge-rec" title="Record change (nothing to accept)">≡</span></td>
  ${lanes ? `<td class="g">${laneSvg(i, r, data.lanes, cols)}</td>` : ""}
  <td class="d">${esc(r.intent ?? r.summary)}</td>
  <td class="tk">${taskCell[r.lane]}</td>
  <td class="f">${esc(r.file)}</td>
  <td class="t">${esc(time(r.t))}</td>
  <td class="s" title="${esc(r.session ?? "")}">${esc(sessionTitle.get(r.session ?? "?") ?? (r.session ?? "?").slice(0, 8))}</td>
  <td class="c"></td>
</tr>`;
  const body = data.rows.length
    ? data.rows
        .map(
          (r, i) => r.record ? recordRow(r, i) : `<tr${r.gone || r.outside ? ` class="${[r.gone && "gone", r.outside && "outside"].filter(Boolean).join(" ")}"` : ""} data-file="${esc(r.file)}" data-n="${r.n}" data-i="${i}" data-q="${esc([r.file, r.intent, r.summary, r.prompt, r.task, data.lanes[r.lane]?.title, sessionTitle.get(r.session ?? "")].join(" "))}"
  data-vscode-context="${menu({ webviewSection: r.accepted || r.gone ? "edit-ok" : "edit-open", file: r.file, n: r.n })}"${r.preview ? "" : ` title="${esc(r.prompt ? `Request: ${r.prompt}` : "")}"`}>
  <td class="ok">${r.gone ? `<span class="badge-gone" title="Later edits rewrote or removed all of it: nothing left to accept">replaced</span>` : r.accepted ? `<span class="badge-ok" title="Accepted">✓</span>` : `<span class="badge-open" title="Under review — Accept, or right-click">●</span><button class="acc" title="Accept this edit">Accept</button>`}</td>
  ${lanes ? `<td class="g">${laneSvg(i, r, data.lanes, cols)}</td>` : ""}
  <td class="d" title="${esc([r.intent ?? r.summary, r.prompt && `Request: ${r.prompt}`].filter(Boolean).join("\n\n"))}">${esc(r.intent ?? r.summary)}</td>
  <td class="tk" title="${esc([r.task, data.lanes[r.lane]?.title].filter(Boolean).join(" · ") || "No task")}">${taskCell[r.lane]}</td>
  <td class="f">${esc(r.file)} <span class="n">${r.outside ? `after #${Math.floor(r.n)}` : `#${r.n}`}</span></td>
  <td class="t">${esc(time(r.t))}</td>
  <td class="s" title="${esc(r.session ?? "")}">${r.outside ? "outside" : esc(sessionTitle.get(r.session ?? "?") ?? r.title ?? (r.session ?? "?").slice(0, 8))}</td>
  <td class="c"><span class="a">+${r.added}</span> <span class="r">−${r.removed}</span></td>
</tr>`,
        )
        .join("\n")
    : `<tr><td colspan="8" class="empty">No agent edits recorded in ${esc(root)} yet.</td></tr>`;
  const pending = data.rows.filter((r) => !r.accepted).length;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none';">
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
  tr.w td.ok:has(input[data-tick]) { cursor: pointer; } td.ok input[data-tick] { width: 16px; height: 16px; margin: 0; cursor: pointer; vertical-align: middle; }
  .badge-ok { display: inline-flex; width: 18px; height: 18px; border-radius: 50%; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
    background: var(--vscode-testing-iconPassed, #73c991); color: var(--vscode-editor-background); }
  .badge-gone { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--vscode-disabledForeground, #888); color: var(--vscode-disabledForeground, #888); }
  tr.gone td.d, tr.gone td.f { opacity: .55; }
  tr.outside td.d, tr.outside td.s { font-style: italic; opacity: .75; }
  .legend { display: flex; gap: 14px; align-items: center; opacity: .8; font-size: 12px; padding: 0 0 6px; }
  .badge-open { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 14px; }
  button.acc { display: none; font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 2px; cursor: pointer; border: none;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.acc:hover { background: var(--vscode-button-hoverBackground); }
  button.acc.on { display: inline-block; font-size: 12px; padding: 2px 10px; } button.acc.on[hidden] { display: none; }
  tr:hover button.acc { display: inline-block; } tr:hover .badge-open { display: none; }
  td.g { padding: 0; width: 1px; } td.g svg { display: block; }
  tr.rec { cursor: pointer; } tr.rec:hover { background: var(--vscode-list-hoverBackground); }
  .badge-rec { display: inline-flex; width: 18px; height: 18px; border-radius: 50%; align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
    border: 1px solid var(--vscode-charts-blue, #3794ff); color: var(--vscode-charts-blue, #3794ff); }
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
  /* Rendered review (#50): Markdown as the preview shows it, with its marks. */
  #pop .review { white-space: normal; font-family: var(--vscode-markdown-font-family, var(--vscode-font-family)); font-size: 13px; line-height: 1.5; padding: 2px 14px; }
  #pop .review div { white-space: normal; padding: 0; }
  #pop .review pre, #pop .review code { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
  #pop .review pre { padding: 6px 8px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); }
  #pop .review table { border-collapse: collapse; } #pop .review th, #pop .review td { border: 1px solid var(--vscode-panel-border, #8884); padding: 2px 6px; }
  #pop .review h1, #pop .review h2, #pop .review h3, #pop .review h4 { margin: .5em 0 .3em; }
  #pop .review p, #pop .review ul, #pop .review ol { margin: .35em 0; }
  #pop .review .gap { text-align: center; opacity: .5; padding: 0; }
  #pop .review .imprimatur-old { padding: 4px 9px; }
  ${reviewStyle()}
  nav { display: flex; gap: 4px; } nav button { background: none; color: var(--vscode-foreground); border: none; border-bottom: 2px solid transparent; padding: 4px 8px; cursor: pointer; opacity: .75; font: inherit; }
  nav button.on { border-bottom-color: var(--vscode-focusBorder); opacity: 1; font-weight: 600; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; font-size: 90%; }
  section[hidden] { display: none; }
  tr.w { cursor: pointer; } tr.w.done { opacity: .6; }
  td.tk { max-width: 260px; } td.tk .none { opacity: .7; font-style: italic; } td.s { opacity: .8; }
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
  .todo .why { margin-bottom: 4px; }
  a.task { text-decoration: none; } a.task:hover { text-decoration: underline; }
  span.task.key { cursor: default; opacity: .75; }
  .task.key { font-size: 11px; padding: 0 6px; margin-right: 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .task.file { margin-right: 6px; opacity: .7; } a.task.file:hover { opacity: 1; }
  .todo .chat { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
</style></head><body>
<header><strong>Agent Change Graph</strong>
<nav><button data-tab="edits">Edits ${pending ? `<span class="badge">${pending}</span>` : ""}</button><button data-tab="waiting">Waiting on you ${open ? `<span class="badge">${open}</span>` : ""}</button></nav>
<input id="filter" placeholder="Filter by file, request or answer"><label id="ans" hidden><input type="checkbox" id="answered"> open only</label><button id="audit" class="acc on" hidden title="Haiku reviews the open list: closes what is done, answered or asked again">Audit</button><button id="scan" class="acc on" hidden title="Find what waited on you before Imprimatur was set up: past Claude sessions (last 30 days) and (K) to-dos in TODO.md">Scan history</button>
<span class="n" id="count-edits">${data.rows.filter((r) => !r.record).length} edits · ${data.rows.filter((r) => r.record).length} record changes · ${pending} under review · ${data.lanes.filter((l) => l.task).length} tasks</span><span class="n" id="count-waiting">${open} open · ${waiting.length} steps</span></header>
<section id="edits"><div class="legend"><span><span class="badge-open">●</span> under review</span><span><span class="badge-ok">✓</span> accepted</span><span><span class="badge-gone">replaced</span> later edits rewrote or removed all of it</span></div><table><thead><tr><th>Status</th>${lanes ? "<th>Graph</th>" : ""}<th>Description</th><th>Task</th><th>File</th><th>Date</th><th>Session</th><th>Changes</th></tr></thead>
<tbody>${body}</tbody></table>
<script type="application/json" id="rows">${JSON.stringify(data.rows.map((r) => (r.preview ? { prompt: r.prompt && `Request: ${r.prompt}`, preview: r.preview, file: r.file, n: r.n, md: /\.mdx?$/i.test(r.file) } : null))).replace(/</g, "\\u003c")}</script></section>
<section id="waiting"><div class="legend"><span>☐ open: tick when done</span><span><span class="badge-ok">✓</span> done</span><span><span class="badge-gone">replaced</span> asked again later</span><span><span class="pill">Answered</span> question you answered</span></div>
<table><thead><tr><th>Status</th><th></th><th>Waiting for</th><th>Request</th><th>Date</th><th>Session</th><th>By</th></tr></thead>
<tbody>${waitingBody(waiting, data.sessions, root)}</tbody></table><p class="empty" id="none" hidden>Nothing open right now.</p></section>
<div id="pop"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  // The page is updated in place (a "render" message), not reloaded: a reload
  // on every agent edit swallowed clicks made while it ran. So every handler
  // is on the document, and the rows below are re-read after each update.
  let rows = JSON.parse(document.getElementById("rows").textContent);
  // Hover diff: stays while the pointer is on the row or the popup itself.
  const pop = document.getElementById("pop");
  let hideTimer;
  const hide = () => { pop.style.display = "none"; };
  const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 250); };
  pop.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  pop.addEventListener("mouseleave", hideSoon);
  const line = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; return d; };
  // Only the status cell opens it: the rest of the row stays free to click and read.
  const statusCell = (e) => e.target.closest?.("tr[data-i] > td.ok");
  document.addEventListener("mouseover", (e) => {
    const cell = statusCell(e);
    if (!cell || cell.contains(e.relatedTarget)) return;
    const tr = cell.parentElement;
    const r = rows[Number(tr.dataset.i)];
    if (!r) return;
    clearTimeout(hideTimer);
    pop.replaceChildren(...(r.prompt ? [line("p", r.prompt)] : []),
      ...r.preview.map(([k, t]) => line(k === "-" ? "m" : k === "+" ? "a" : "", k === "…" ? "… " + t : k + " " + t)));
    // The line diff stays until the rendered review comes (or if there is none).
    pop.dataset.key = r.file + "#" + r.n;
    hoveredRow = tr;
    pop.scrollTop = 0;
    pop.style.display = "block";
    place(tr);
    // Markdown: the rendered review, from the cache or asked for once the pointer rests.
    clearTimeout(askTimer);
    if (r.md && reviews.has(pop.dataset.key)) showReview({ file: r.file, n: r.n, html: reviews.get(pop.dataset.key) });
    else if (r.md) askTimer = setTimeout(() => vscode.postMessage({ type: "preview", file: r.file, n: r.n }), 150);
  });
  document.addEventListener("mouseout", (e) => {
    const cell = statusCell(e);
    if (cell && !cell.contains(e.relatedTarget)) {
      clearTimeout(askTimer);
      hideSoon();
    }
  });
  // Tab, filter, the answered toggle and opened rows survive an update.
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
    document.getElementById("scan").hidden = state.tab !== "waiting";
    const q = state.q.toLowerCase();
    document.querySelectorAll("tr[data-q]").forEach((tr) => {
      const show = tr.dataset.q.toLowerCase().includes(q) && (!state.answered || !("done" in tr.dataset));
      tr.style.display = show ? "" : "none";
      if (tr.nextElementSibling?.classList.contains("x")) tr.nextElementSibling.hidden = !show || !state.expanded.includes(tr.dataset.key);
    });
    document.getElementById("none").hidden = !state.answered || !!state.q || document.querySelector("tr.w.s-open") !== null;
  };
  filter.addEventListener("input", () => { state.q = filter.value; apply(); });
  document.addEventListener("click", (e) => {
    const t = e.target;
    const tab = t.closest("nav button");
    if (tab) { state.tab = tab.dataset.tab; return apply(); }
    const task = t.closest("a.task");
    if (task) {
      e.preventDefault();
      if (task.dataset.url) vscode.postMessage({ type: "openUrl", url: task.dataset.url });
      else if (task.dataset.record) vscode.postMessage({ type: "showRecord", id: Number(task.dataset.record) });
      else if (task.dataset.task) vscode.postMessage({ type: "showTask", task: task.dataset.task });
      return;
    }
    const run = t.closest("#audit, #scan");
    if (run) {
      run.disabled = true;
      run.textContent = run.id === "audit" ? "Auditing…" : "Scanning…";
      return vscode.postMessage({ type: run.id });
    }
    const rec = t.closest("tr.rec");
    if (rec) return vscode.postMessage({ type: "showRecord", id: Number(rec.dataset.record) });
    const edit = t.closest("tr[data-file]");
    if (edit) {
      const accept = !!t.closest("button.acc");
      if (accept) {
        hide();
        // Shown accepted at once, like a ticked box; the update that follows confirms it.
        edit.querySelector("td.ok").innerHTML = '<span class="badge-ok mine" title="Accepted">✓</span>';
        accepts.set(edit.dataset.file + "#" + edit.dataset.n, performance.now());
      }
      return vscode.postMessage({ type: accept ? "accept" : "open", file: edit.dataset.file, n: Number(edit.dataset.n), at: Date.now() });
    }
    const w = t.closest("tr.w");
    if (!w || t.closest("input, a, button, details")) return;
    // The whole status cell ticks: a click beside the small box is not lost to the row.
    const box = t.closest("td.ok")?.querySelector("input[data-tick]");
    if (box) return box.click();
    const k = w.dataset.key;
    state.expanded = state.expanded.includes(k) ? state.expanded.filter((x) => x !== k) : [...state.expanded, k];
    apply();
  });
  // A tick shows at once and stays shown: an update made before the log had it
  // must not untick it. Each is timed, click to confirmed, for the perf log.
  const ticks = new Map();
  /** Accepted edits not yet drawn so by an update: "file#n" → click time. */
  const accepts = new Map();
  const tickKey = (b) => b.dataset.session + " " + b.dataset.item + " " + b.dataset.i;
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t === answered) { state.answered = answered.checked; return apply(); }
    // Tick a step right in its row; the log keeps it, the next update redraws it.
    if (t.matches("input[data-tick]")) {
      ticks.set(tickKey(t), { on: t.checked, at: performance.now() });
      vscode.postMessage({ type: "check", session: t.dataset.session, t: t.dataset.item, i: Number(t.dataset.i), on: t.checked, at: Date.now() });
    }
  });
  // An update waits while a click is under way, so it never lands between press
  // and release; it only swaps changed rows, so it need not wait any longer. A
  // release the page never sees (pointer let go outside it) holds it 300 ms at most.
  let next;
  let pressed = false;
  let pressedAt = 0;
  // What was drawn last, as strings: an update swaps only what differs from it.
  const html = (el) => el.outerHTML;
  const drawn = new Map();
  const remember = () => {
    for (const sel of ["nav", "#audit", "#scan", "#count-edits", "#count-waiting", "#edits thead", "#waiting thead"]) drawn.set(sel, html(document.querySelector(sel)));
    for (const id of ["edits", "waiting"]) drawn.set(id, [...document.querySelectorAll("#" + id + " tbody > tr")].map(html));
  };
  remember();
  // Rows: keep the unchanged run at the start and at the end (a new step or
  // edit comes in at the top), swap the rest.
  const patchRows = (id, fresh) => {
    const body = document.querySelector("#" + id + " tbody");
    const old = [...body.children];
    const now = [...fresh.querySelectorAll("#" + id + " tbody > tr")];
    const was = drawn.get(id);
    const is = now.map(html);
    drawn.set(id, is);
    if (was.length !== old.length) return body.replaceChildren(...now);
    let a = 0;
    while (a < was.length && a < is.length && was[a] === is[a]) a++;
    let z = 0;
    while (z < was.length - a && z < is.length - a && was[was.length - 1 - z] === is[is.length - 1 - z]) z++;
    const gone = old.slice(a, old.length - z);
    const come = now.slice(a, now.length - z);
    if (!gone.length && !come.length) return;
    const after = old[old.length - z] ?? null;
    gone.forEach((r) => r.remove());
    for (const r of come) body.insertBefore(document.adoptNode(r), after);
  };
  const update = () => {
    if (next === undefined || (pressed && performance.now() - pressedAt < 300)) return;
    const t0 = performance.now();
    const doc = new DOMParser().parseFromString(next, "text/html");
    next = undefined;
    const t1 = performance.now();
    for (const sel of ["nav", "#audit", "#scan", "#count-edits", "#count-waiting", "#edits thead", "#waiting thead"]) {
      const fresh = doc.querySelector(sel);
      if (fresh && html(fresh) !== drawn.get(sel)) {
        drawn.set(sel, html(fresh));
        document.querySelector(sel)?.replaceWith(document.adoptNode(fresh));
      }
    }
    patchRows("edits", doc);
    patchRows("waiting", doc);
    const data = doc.getElementById("rows")?.textContent;
    if (data) { document.getElementById("rows").textContent = data; rows = JSON.parse(data); }
    // Drawn from the log (the attribute) as ticked: confirmed. Not yet: keep the click's state.
    const boxes = new Map([...document.querySelectorAll("input[data-tick]")].map((b) => [tickKey(b), b]));
    for (const [k, t] of ticks) {
      const b = boxes.get(k);
      if (b && b.hasAttribute("checked") !== t.on) { b.checked = t.on; continue; }
      ticks.delete(k);
      vscode.postMessage({ type: "perf", ms: Math.round(performance.now() - t.at), parse: Math.round(t1 - t0), patch: Math.round(performance.now() - t1) });
    }
    for (const [k, at] of accepts) {
      const tr = [...document.querySelectorAll("tr[data-file]")].find((r) => r.dataset.file + "#" + r.dataset.n === k);
      // "mine": the badge the click drew, not yet one an update drew.
      if (tr && !tr.querySelector("td.ok .badge-ok:not(.mine), td.ok .badge-gone")) {
        tr.querySelector("td.ok").innerHTML = '<span class="badge-ok mine" title="Accepted">✓</span>';
        continue;
      }
      accepts.delete(k);
      vscode.postMessage({ type: "perf", what: "accept", ms: Math.round(performance.now() - at), parse: Math.round(t1 - t0), patch: Math.round(performance.now() - t1) });
    }
    hide();
    apply();
  };
  addEventListener("pointerdown", () => { pressed = true; pressedAt = performance.now(); setTimeout(update, 310); }, true);
  const release = () => { pressed = false; setTimeout(update); };
  addEventListener("pointerup", release, true);
  addEventListener("pointercancel", release, true);
  // The rendered review, cut to the marked blocks with one block around each.
  const MARK = ".imprimatur-added, .imprimatur-changed, .imprimatur-old, .imprimatur-diagram";
  const marked = (el) => el.matches?.(MARK) || !!el.querySelector?.(MARK);
  const cut = (box) => {
    const kids = [...box.children];
    const keep = new Set();
    kids.forEach((el, i) => { if (marked(el)) for (const j of [i - 1, i, i + 1]) if (kids[j]) keep.add(j); });
    let last = -1;
    kids.forEach((el, i) => {
      if (!keep.has(i)) return el.remove();
      if (last >= 0 && i > last + 1) { const g = document.createElement("div"); g.className = "gap"; g.textContent = "⋯"; box.insertBefore(g, el); }
      last = i;
      // A long list: the same cut over its items.
      if ((el.tagName === "UL" || el.tagName === "OL") && el.children.length > 3 && marked(el)) cut(el);
    });
  };
  /** Rendered reviews by file#n, until the page updates. */
  const reviews = new Map();
  let askTimer;
  let hoveredRow;
  // Next to the row, below it when it fits, else above; again when the content changes size.
  const place = (tr) => {
    const box = tr.getBoundingClientRect();
    const below = box.bottom + pop.offsetHeight < innerHeight;
    pop.style.left = Math.max(4, Math.min(box.left + 40, innerWidth - pop.offsetWidth - 8)) + "px";
    pop.style.top = (below ? box.bottom : Math.max(4, box.top - pop.offsetHeight)) + "px";
  };
  const showReview = (m) => {
    reviews.set(m.file + "#" + m.n, m.html);
    if (!m.html || pop.style.display !== "block" || pop.dataset.key !== m.file + "#" + m.n) return;
    // The agent's Markdown may hold raw HTML: parsed inert, then only safe parts kept
    // (the CSP already stops scripts; this also stops styles and forms reaching the page).
    const doc = new DOMParser().parseFromString(m.html, "text/html");
    doc.querySelectorAll("script, style, link, meta, base, iframe, frame, object, embed, form, input, button, textarea, select, svg, math, template").forEach((el) => el.remove());
    for (const el of doc.body.querySelectorAll("*"))
      for (const a of [...el.attributes])
        if (/^on/i.test(a.name) || a.name === "style" || ((a.name === "href" || a.name === "src") && !/^(https?:|#)/i.test(a.value.trim()))) el.removeAttribute(a.name);
    const box = document.createElement("div");
    box.className = "review";
    box.replaceChildren(...doc.body.childNodes);
    cut(box);
    if (!box.querySelector(MARK)) return;
    const prompt = pop.querySelector(".p");
    pop.replaceChildren(...(prompt ? [prompt] : []), box);
    pop.scrollTop = 0;
    if (hoveredRow?.isConnected) place(hoveredRow);
  };
  addEventListener("message", (e) => {
    if (e.data?.type === "preview") return showReview(e.data);
    if (e.data?.type !== "render") return;
    reviews.clear(); // edits changed: their rendered reviews may have too
    next = e.data.html;
    update();
  });
  addEventListener("scroll", hide);
  apply();
</script></body></html>`;
}

/** @type {vscode.WebviewPanel | undefined} */
let panel;
/** @type {((waitingOnly?: boolean) => void) | undefined} update the open page in place */
let refresh;
/** @type {(() => void) | undefined} load the page anew */
let reload;
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
 * @param {(file: string, n: number) => string | undefined} [renderEdit] an edit as a rendered Markdown review (#50)
 */
function openGraph(root, openDiff, currentText, acceptEdit, goTo, renderEdit = () => undefined) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel("imprimatur.graph", "Agent Change Graph", vscode.ViewColumn.Active, { enableScripts: true });
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === "check") return timed("tick", m, () => tick(m));
      if (m.type === "perf") return perfLog(m);
      if (m.type === "audit") return auditAll();
      if (m.type === "openUrl" && /^https?:\/\//.test(m.url)) return vscode.env.openExternal(vscode.Uri.parse(m.url));
      if (m.type === "showRecord" && shown) return vscode.commands.executeCommand("imprimatur.records.reveal", { root: shown, record: m.id });
      if (m.type === "showTask" && shown) return vscode.commands.executeCommand("imprimatur.records.reveal", { root: shown, task: m.task });
      if (m.type === "scan") return scanAll();
      if (m.type === "preview" && shown) {
        let html;
        try {
          html = renderEdit(path.join(shown, m.file), m.n);
        } catch {
          // the line diff stays
        }
        return void panel?.webview.postMessage({ type: "preview", file: m.file, n: m.n, html });
      }
      return m.type === "accept" ? timed("accept", m, () => actions?.acceptEdit(m.file, m.n)) : actions?.openDiff(m.file, m.n);
    });
    // A hidden webview is torn down and gets no messages: shown again, it reloads from the html, so make that current.
    let hidden = false;
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (!webviewPanel.visible) hidden = true;
      else if (hidden) {
        hidden = false;
        reload?.();
      }
    });
    panel.onDidDispose(() => {
      panel = undefined;
      refresh = undefined;
      reload = undefined;
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
  // Done tasks close their asks now, and the user's open records show up, not only at the next turn end.
  try {
    closeDoneTasks(root);
    scanTodos(root);
  } catch {
    // a waiting log being written: the next draw catches up
  }
  // A tick changes only the waiting list: it reuses the edits, the costly half (graphRows).
  /** @type {ReturnType<typeof graphRows> | undefined} */
  let edits;
  const page = (nonce = crypto.randomBytes(16).toString("hex"), waitingOnly = false) => {
    if (!(waitingOnly && edits)) {
      edits = graphRows(root, currentText);
      describeShown(root, edits.rows);
    }
    return html(edits, root, nonce, waitingSteps(root));
  };
  // An edit refreshes three times (extension.js refreshSoon): send only what changed.
  let sent = "";
  // Load once; after that the page updates in place (its "render" message):
  // setting the html reloads it, and a click during a reload is lost.
  reload = () => {
    sent = "";
    p.webview.html = page();
  };
  reload();
  refresh = (waitingOnly = false) => {
    if (!p.visible) return;
    const next = page("", waitingOnly);
    if (next !== sent) p.webview.postMessage({ type: "render", html: (sent = next) });
  };
  p.reveal();
  // Set up after work began: once per project, find what already waited on the user.
  if (!scannedBefore(root)) scanAll();
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
  // Redraw now: the file watcher reports the write late (its refresh then finds nothing new).
  refresh?.(true);
}

/**
 * Run a click's work, logging how long its message waited for the extension
 * host (busy with other refreshes) and how long the work took.
 * @param {string} what @param {{at?: number}} m @param {() => unknown} work
 */
function timed(what, m, work) {
  const start = Date.now();
  const out = work();
  appendPerf(`${what} host: waited ${m.at ? start - m.at : "?"}ms, work ${Date.now() - start}ms`);
  return out;
}

/** Rows the graph asks a description for: the newest ones, as the panel shows them first. */
const DESCRIBE_ROWS = 40;
/** At most this many model calls at once. */
const DESCRIBE_AT_ONCE = 2;
/** Edits being described or waiting: "root\tfile\tkey". @type {Set<string>} */
const describing = new Set();
/** @type {string[]} */
const describeQueue = [];
let describeRunning = 0;

/**
 * Lazy descriptions (#63): when the graph is drawn, the newest edits that nothing
 * describes (no model sentence, no agent words) get one from hooks/describe.mjs in
 * the background; its line in descriptions.jsonl redraws the graph. An edit never
 * shown costs no model call. IMPRIMATUR_DESCRIBE=off turns it off.
 * @param {string} root @param {ReturnType<typeof graphRows>["rows"]} rows
 */
function describeShown(root, rows) {
  if (process.env.IMPRIMATUR_DESCRIBE === "off") return;
  for (const r of rows.slice(0, DESCRIBE_ROWS)) {
    if (!r.describe) continue;
    const job = `${root}\t${r.file}\t${r.describe}`;
    if (describing.has(job)) continue;
    describing.add(job);
    describeQueue.push(job);
  }
  while (describeRunning < DESCRIBE_AT_ONCE && describeQueue.length) {
    const job = /** @type {string} */ (describeQueue.shift());
    const [where, file, key] = job.split("\t");
    describeRunning++;
    // In the extension: its package has no hooks/ folder. A failed one is not asked again in
    // this window; the changed line stays.
    require("./describe.js")
      .describe(where, file, key, modelLang() ?? "English")
      .catch(() => {})
      .finally(() => {
        describeRunning--;
        describeShown(where, []);
      });
  }
}

const appendPerf = (text) => fs.appendFile(path.join(os.tmpdir(), "imprimatur-perf.log"), `${new Date().toISOString()} ${text} ${shown ?? ""}\n`, () => {});

/**
 * One tick's time from click to drawn as ticked, kept outside the repo (a
 * write under .claude/imprimatur would itself refresh the panel).
 * @param {{what?: string, ms: number, parse: number, patch: number}} m
 */
function perfLog(m) {
  appendPerf(`${m.what === "accept" ? "accept" : "tick"} drawn: ${m.ms}ms after the click (parse ${m.parse}ms, patch ${m.patch}ms)`);
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
        closed += (await audit(log, { lang: modelLang() })).settled.length;
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

/** The language model-written steps use: the setting, else the hooks' variable (vscode/history.js, audit.js). */
const modelLang = () => vscode.workspace.getConfiguration("imprimatur").get("language") || process.env.IMPRIMATUR_LANG || undefined;

/** Projects being scanned now (a second click or panel open waits for the first). */
const scanning = new Set();

/**
 * Scan history (vscode/history.js): what waited on the user before Imprimatur
 * was set up. The Scan history button, and once per project on its own.
 */
async function scanAll(again = false) {
  const root = shown;
  if (!root || scanning.has(root)) return;
  scanning.add(root);
  let res;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Imprimatur: scanning past sessions" }, async (p) => {
    try {
      res = await scanHistory(root, { lang: modelLang(), again, progress: (done, total) => p.report({ message: `${done}/${total}` }) });
    } catch (e) {
      vscode.window.showWarningMessage(`Imprimatur: scan failed: ${e instanceof Error ? e.message : e}`);
    }
  });
  scanning.delete(root);
  refreshGraph();
  if (!res) return;
  const msg = `Scan history: ${res.sessions} past session${res.sessions === 1 ? "" : "s"} read, ${res.todos.added} record${res.todos.added === 1 ? "" : "s"} of yours added from Imprimatur${res.todos.ticked ? `, ${res.todos.ticked} ticked (no longer open)` : ""}.`;
  // Nothing new: sessions read before are skipped. Rescan writes them anew (e.g. after a language change).
  const pick = res.sessions || again
    ? await vscode.window.showInformationMessage(msg)
    : await vscode.window.showInformationMessage(`${msg} Sessions read before are skipped.`, "Rescan past sessions");
  if (pick === "Rescan past sessions") scanAll(true);
}

/** Re-render the open panel, if any (after an agent edit). */
/** @param {boolean} [waitingOnly] only the waiting list changed: reuse the edits */
const refreshGraph = (waitingOnly = false) => refresh?.(waitingOnly);

/**
 * The database changed (a record, a task's status): done tasks close their asks,
 * the user's open records sync into Waiting on you, then the graph redraws.
 * Both write only under the repo's .claude/imprimatur, never the database: no loop.
 */
function syncRecords() {
  if (!shown) return;
  try {
    closeDoneTasks(shown);
    scanTodos(shown);
  } catch {
    // a waiting log being written: the next change catches up
  }
  refreshGraph();
}

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

module.exports = { openGraph, refreshGraph, syncRecords, graphCommands, laneSvg, html };
