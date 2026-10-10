// @ts-check
// The Imprimatur panel (a webview, viewType imprimatur.graph). Four tabs:
// "Ana sayfa", "Görevler" and "Bende bekleyenler" show Imprimatur's task records
// (tasksView.js, #69); "Ajan değişiklikleri" is the Agent Change Graph: rows from
// graph.js, one colored lane per Claude session, click a row to open that edit's
// diff, Accept an edit from its row or its right-click menu. Bende bekleyenler
// also lists what the agent asked at a turn's end (waiting.js), with ticks.
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
const { trustGate } = require("./trust.js");
const tasksView = require("./tasksView.js");
const { githubOf } = require("./tasks.js");

/** Where the graph logs (the extension's output channel). @type {(msg: string) => void} */
let logLine = () => {};
/** In an untrusted folder no model call starts from here (#65). */
const allowed = trustGate(() => vscode.workspace.isTrusted, (msg) => logLine(msg));
/** @param {(msg: string) => void} fn */
const setGraphLog = (fn) => void (logLine = fn);
/** Options of the panel's webview: scripts, and no local files to load (everything is inline). */
const WEBVIEW_OPTIONS = { enableScripts: true, localResourceRoots: [] };

/** The preview's marks (preview.css), for the hover's rendered review (#50); read once. */
let reviewCss;
/** preview.css sits next to this file, or one up when it runs bundled (vscode/dist/extension.js). */
const cssPaths = (dir = __dirname) => [path.join(dir, "preview.css"), path.join(dir, "..", "preview.css")];
const reviewStyle = () => (reviewCss ??= (() => {
  for (const file of cssPaths()) {
    try {
      return scopeCss(fs.readFileSync(file, "utf8"), "#pop .review");
    } catch {}
  }
  return "";
})());

/** A table's rows until the host draws its tab (it draws only the visible one). @param {number} cols */
const LOADING = (cols) => `<tr class="loading"><td colspan="${cols}" class="empty">Yükleniyor…</td></tr>`;

/** Row kinds of the graph's filter (#55): badge and label. */
const ACTIVITY = {
  edit: ["✎", "Edits"],
  record: ["≡", "Records"],
  agent: ["⑃", "Subagents"],
  skill: ["★", "Skills"],
  mcp: ["⚙", "MCP"],
  web: ["⌁", "Web"],
  read: ["◱", "Reads"],
  search: ["⌕", "Searches"],
  bash: ["$", "Bash"],
  other: ["·", "Other"],
};

const KINDS = { question: [tasksView.icon("question"), "Question"], command: [tasksView.icon("terminal"), "Command"], verify: [tasksView.icon("eye"), "Verify / test"], input: [tasksView.icon("hand"), "Input"] };
/** The waiting log that mirrors the user's open records (history.js): the records show in Bende bekleyenler themselves. */
const FILES_SESSION = "todo-files";

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
  steps = steps.filter((w) => w.session !== FILES_SESSION);
  if (!steps.length) return `<tr><td colspan="7" class="empty">No turn-end asks yet.</td></tr>`;
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
      // The key shows the task in Görevler (its GitHub or Jira page is a click away there).
      const key = place.task ? open("key", `data-task="${esc(place.task)}"`, esc(place.task), `Show ${place.task} in Görevler`) : "";
      // The badge names the task: the text need not start with it too ("LATD-13937: …").
      const stepText = place.task && w.text.startsWith(place.task) ? w.text.slice(place.task.length).replace(/^[\s:–—-]+/, "") || w.text : w.text;
      // Before the text: a long text is cut at the end of the cell (…), and the icon must stay.
      const file = place.record ? open("file", `data-record="${place.record}"`, tasksView.icon("file", 14), `Show the record in ${place.task}`) : "";
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
 * The whole page. Only the visible tab's rows are drawn (#69): the edits table on
 * "edits", the turn-end asks on "inbox", the task tabs' HTML (opts.pane) on theirs.
 * @param {ReturnType<typeof graphRows>} data @param {string} root @param {string} nonce
 * @param {ReturnType<typeof waitingSteps>} [waiting]
 * @param {{view?: Record<string, any>, pane?: string, inbox?: number, repoName?: string}} [opts]
 */
function html(data, root, nonce, waiting = [], opts = {}) {
  const view = { tab: "edits", ...opts.view };
  const tab = tasksView.TABS.includes(view.tab) ? view.tab : "edits";
  const turn = waiting.filter((w) => w.session !== FILES_SESSION);
  const open = turn.filter((w) => w.state === "open").length;
  const inbox = opts.inbox ?? open;
  // One task draws one straight line: the lanes only say something with several.
  const lanes = data.lanes.length > 1;
  const cols = columnsOf(data.lanes);
  const time = (t) => new Date(t).toLocaleString();
  const sessionTitle = new Map(data.sessions.map((s) => [s.session, s.title]));
  // Each lane's task, as in Bende bekleyenler: the key opens the task in Görevler, then its title.
  const taskCell = data.lanes.map((l, k) => {
    const color = `style="color:${COLORS[k % COLORS.length]}"`;
    if (!l.task) return `<span class="none" ${color} title="No todos/ file, branch or key names its task">No task</span>`;
    const key = `<a href="#" class="task key" data-task="${esc(l.task)}" title="${esc(`Show ${l.task} in Görevler`)}">${esc(l.task)}</a>`;
    return `${key}<span ${color}>${esc(l.title ?? "")}</span>`;
  });
  // A record change: shown in its task's lane; it opens the record, nothing to accept (#60).
  const recordRow = (r, i) => `<tr class="rec" data-kind="record" data-record="${r.record}" data-i="${i}" data-q="${esc([r.file, r.intent, r.task, data.lanes[r.lane]?.title, sessionTitle.get(r.session ?? "")].join(" "))}" title="Record change: click to show the record">
  <td class="ok"><span class="badge-rec" title="Record change (nothing to accept)">≡</span></td>
  ${lanes ? `<td class="g">${laneSvg(i, r, data.lanes, cols)}</td>` : ""}
  <td class="d">${esc(r.intent ?? r.summary)}</td>
  <td class="tk">${taskCell[r.lane]}</td>
  <td class="f">${esc(r.file)}</td>
  <td class="t">${esc(time(r.t))}</td>
  <td class="s" title="${esc(r.session ?? "")}">${esc(sessionTitle.get(r.session ?? "?") ?? (r.session ?? "?").slice(0, 8))}</td>
  <td class="c"></td>
</tr>`;
  // Everything else the agent did (#55): a row per tool call, its kind as a badge, nothing to
  // accept. A subagent's calls sit under its Agent row, folded.
  const calls = new Map();
  for (const r of data.rows) if (r.agent) calls.set(r.agent, (calls.get(r.agent) ?? 0) + 1);
  const activityRow = (r, i) => {
    const [icon, label] = ACTIVITY[r.kind] ?? ACTIVITY.other;
    const fold = r.agentId && calls.get(r.agentId) ? `<a href="#" class="grp" data-agent="${esc(r.agentId)}" title="Show or hide the subagent's calls">▸ ${calls.get(r.agentId)} calls</a> ` : "";
    return `<tr class="act${r.agent ? " sub" : ""}${r.failed ? " failed" : ""}" data-kind="${esc(r.kind ?? "other")}"${r.agent ? ` data-parent="${esc(r.agent)}"` : ""} data-i="${i}" data-q="${esc([r.tool, r.intent, r.summary, r.task, data.lanes[r.lane]?.title, sessionTitle.get(r.session ?? "")].join(" "))}" title="${esc([`${r.tool}${r.failed ? " (failed)" : ""}${r.ms != null ? ` · ${r.ms} ms` : ""}`, r.intent, r.summary && `→ ${r.summary}`].filter(Boolean).join("\n"))}">
  <td class="ok"><span class="badge-kind" title="${esc(label)}">${icon}</span></td>
  ${lanes ? `<td class="g">${laneSvg(i, r, data.lanes, cols)}</td>` : ""}
  <td class="d">${r.agent ? "↳ " : ""}${fold}${esc(r.intent ?? "")}${r.summary ? ` <span class="out">→ ${esc(r.summary)}</span>` : ""}</td>
  <td class="tk">${taskCell[r.lane]}</td>
  <td class="f">${esc(r.tool ?? "")}</td>
  <td class="t">${esc(time(r.t))}</td>
  <td class="s" title="${esc(r.session ?? "")}">${esc(sessionTitle.get(r.session ?? "?") ?? (r.session ?? "?").slice(0, 8))}</td>
  <td class="c"></td>
</tr>`;
  };
  const kindCount = new Map();
  for (const r of data.rows) {
    const k = r.record ? "record" : r.activity ? (r.kind ?? "other") : "edit";
    kindCount.set(k, (kindCount.get(k) ?? 0) + 1);
  }
  const chips = Object.entries(ACTIVITY)
    .filter(([k]) => kindCount.get(k))
    .map(([k, [icon, label]]) => `<button class="chip" data-kind="${k}" title="Show or hide: ${esc(label)}">${icon} ${esc(label)} <span class="n">${kindCount.get(k)}</span></button>`)
    .join("");
  const body = tab !== "edits" ? LOADING(8) : data.rows.length
    ? data.rows
        .map(
          (r, i) => r.record ? recordRow(r, i) : r.activity ? activityRow(r, i) : `<tr data-kind="edit"${r.gone || r.outside ? ` class="${[r.gone && "gone", r.outside && "outside"].filter(Boolean).join(" ")}"` : ""} data-file="${esc(r.file)}" data-n="${r.n}" data-i="${i}" data-q="${esc([r.file, r.intent, r.summary, r.prompt, r.task, data.lanes[r.lane]?.title, sessionTitle.get(r.session ?? "")].join(" "))}"
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
  #kinds { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 6px; }
  .chip { font: inherit; font-size: 12px; padding: 1px 8px; border-radius: 10px; cursor: pointer; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    background: transparent; color: var(--vscode-foreground); opacity: .55; } .chip.on { opacity: 1; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge-kind { display: inline-flex; min-width: 18px; justify-content: center; font-size: 12px; opacity: .85; }
  tr.act td.d .out { opacity: .65; } tr.act.failed td.d { color: var(--vscode-errorForeground); } tr.sub td.d { padding-left: 22px; }
  a.grp { text-decoration: none; font-size: 11px; opacity: .8; margin-right: 4px; }
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
  nav button.on { border-bottom-color: var(--vscode-charts-orange); opacity: 1; font-weight: 600; }
  nav button:focus-visible, #filter:focus-visible, .chip:focus-visible, button.acc:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  header .brand { display: inline-flex; align-items: center; gap: 8px; } header .brand .ic { color: var(--vscode-charts-orange); }
  #filter:focus { outline: 1px solid var(--vscode-focusBorder); }
  ${tasksView.TASKS_CSS}
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
<header><span class="brand">${tasksView.icon("stamp", 20)}<strong>Imprimatur</strong><span class="dim">/</span><span>${esc(opts.repoName ?? path.basename(root))}</span></span>
<nav aria-label="Görünümler"><button data-tab="home">Ana sayfa</button><button data-tab="tasks">Görevler</button><button data-tab="inbox">Bende bekleyenler ${inbox ? `<span class="badge">${inbox}</span>` : ""}</button><button data-tab="edits">Ajan değişiklikleri ${pending ? `<span class="badge">${pending}</span>` : ""}</button></nav>
<input id="filter" type="search" aria-label="Ara" placeholder="Ara… (/)"><label id="ans" hidden><input type="checkbox" id="answered"> open only</label><button id="audit" class="acc on" hidden title="Haiku reviews the open list: closes what is done, answered or asked again">Audit</button><button id="scan" class="acc on" hidden title="Find what waited on you before Imprimatur was set up: past Claude sessions (last 30 days) and (K) to-dos in TODO.md">Scan history</button>
<span class="n" id="count-edits">${data.rows.filter((r) => !r.record && !r.activity).length} edits · ${data.rows.filter((r) => r.activity).length} other calls · ${data.rows.filter((r) => r.record).length} record changes · ${pending} under review · ${data.lanes.filter((l) => l.task).length} tasks</span><span class="n" id="count-waiting">${open} open · ${turn.length} steps</span></header>
<section id="edits"${tab === "edits" ? "" : " hidden"}><div id="kinds">${chips}</div><div class="legend"><span><span class="badge-open">●</span> under review</span><span><span class="badge-ok">✓</span> accepted</span><span><span class="badge-gone">replaced</span> later edits rewrote or removed all of it</span></div><table><thead><tr><th>Status</th>${lanes ? "<th>Graph</th>" : ""}<th>Description</th><th>Task</th><th>File</th><th>Date</th><th>Session</th><th>Changes</th></tr></thead>
<tbody>${body}</tbody></table>
<script type="application/json" id="rows">${JSON.stringify((tab === "edits" ? data.rows : []).map((r) => (r.preview ? { prompt: r.prompt && `Request: ${r.prompt}`, preview: r.preview, file: r.file, n: r.n, md: /\.mdx?$/i.test(r.file) } : null))).replace(/</g, "\\u003c")}</script></section>
<section id="pane" data-tab="${tab}"${tab === "edits" ? " hidden" : ""}>${tab === "edits" ? '<p class="empty loading" data-k="loading">Yükleniyor…</p>' : opts.pane ?? ""}</section>
<section id="waiting"${tab === "inbox" ? "" : " hidden"}><div class="legend"><span>☐ open: tick when done</span><span><span class="badge-ok">✓</span> done</span><span><span class="badge-gone">replaced</span> asked again later</span><span><span class="pill">Answered</span> question you answered</span></div>
<table><thead><tr><th>Status</th><th></th><th>Waiting for</th><th>Request</th><th>Date</th><th>Session</th><th>By</th></tr></thead>
<tbody>${tab === "inbox" ? waitingBody(waiting, data.sessions, root) : LOADING(7)}</tbody></table><p class="empty" id="none" hidden>Nothing open right now.</p></section>
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
  // Tab, filters, the answered toggle, opened rows and half-typed text survive an update.
  // The repo goes into the saved state too: a panel restored after a reload shows the same one.
  // The host's view (tab, selected task, …) wins over the saved one: it opened the page.
  const state = Object.assign({ tab: "edits", qs: {}, answered: false, expanded: [], kinds: ${JSON.stringify(Object.fromEntries(Object.keys({ edit: 1, record: 1, agent: 1, skill: 1, web: 1, mcp: 1, read: 0, search: 0, bash: 0, other: 0 }).map((k) => [k, ["edit", "record", "agent", "skill", "web", "mcp"].includes(k)])))}, agents: [], drafts: {}, back: [], showDone: [], old: [] }, vscode.getState(), ${JSON.stringify(view).replace(/</g, "\\u003c")}, { root: ${JSON.stringify(root).replace(/</g, "\\u003c")} });
  if (typeof state.q === "string") { state.qs.edits = state.qs.edits ?? state.q; delete state.q; }
  const filter = document.getElementById("filter");
  const answered = document.getElementById("answered");
  answered.checked = state.answered;
  const HINTS = { home: "Görevlerde ara… (/)", tasks: "Görev, karar, soru ara… (/)", inbox: "Bekleyenlerde ara… (/)", edits: "Dosya, istek ya da cevap süz… (/)" };
  const apply = () => {
    vscode.setState(state);
    const tab = state.tab;
    document.getElementById("edits").hidden = tab !== "edits";
    const paneEl = document.getElementById("pane");
    paneEl.hidden = tab === "edits";
    // Drawn for another tab: dimmed, saying it loads, until the host's page comes.
    if (tab !== "edits" && paneEl.dataset.tab !== tab) paneEl.className = "stale";
    else paneEl.removeAttribute("class");
    document.getElementById("waiting").hidden = tab !== "inbox";
    document.getElementById("count-edits").hidden = tab !== "edits";
    document.getElementById("count-waiting").hidden = tab !== "inbox";
    document.querySelectorAll("nav [data-tab]").forEach((b) => { b.classList.toggle("on", b.dataset.tab === tab); b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"); });
    for (const id of ["ans", "audit", "scan"]) document.getElementById(id).hidden = tab !== "inbox";
    filter.placeholder = HINTS[tab] || "";
    if (document.activeElement !== filter) filter.value = state.qs[tab] || "";
    const q = (state.qs[tab] || "").toLowerCase();
    document.querySelectorAll("#kinds .chip").forEach((b) => b.classList.toggle("on", state.kinds[b.dataset.kind] !== false));
    document.querySelectorAll("a.grp").forEach((a) => (a.textContent = (state.agents.includes(a.dataset.agent) ? "▾" : "▸") + a.textContent.slice(1)));
    document.querySelectorAll("#edits tr[data-q], #waiting tr[data-q]").forEach((tr) => {
      // A subagent's call shows with its open Agent row, whatever its kind; other rows by kind.
      const kindOn = tr.dataset.parent ? state.agents.includes(tr.dataset.parent) : !tr.dataset.kind || state.kinds[tr.dataset.kind] !== false;
      const show = kindOn && tr.dataset.q.toLowerCase().includes(q) && (!state.answered || !("done" in tr.dataset));
      tr.style.display = show ? "" : "none";
      if (tr.nextElementSibling?.classList.contains("x")) tr.nextElementSibling.hidden = !show || !state.expanded.includes(tr.dataset.key);
    });
    // The task tabs: the search hides tasks, records and asks that do not say it.
    document.querySelectorAll("#pane [data-q]").forEach((el) => { el.hidden = !!q && !el.dataset.q.toLowerCase().includes(q); });
    document.getElementById("none").hidden = !state.answered || !!q || document.querySelector("tr.w.s-open") !== null;
  };
  /** Change the view: the host draws the tab anew (it draws only the visible one). */
  const setView = (patch) => {
    Object.assign(state, patch);
    apply();
    vscode.postMessage({ type: "view", view: { tab: state.tab, sel: state.sel ?? null, filter: state.filter, all: !!state.all, showDone: state.showDone, old: state.old } });
  };
  /** Go somewhere Esc comes back from. */
  const go = (patch) => {
    state.back = [...state.back, { tab: state.tab, sel: state.sel ?? null, filter: state.filter }].slice(-20);
    setView(patch);
  };
  const goBack = () => {
    const prev = state.back.pop();
    if (prev) return setView(prev);
    // On a task page: back to its row in the list.
    const row = document.querySelector("#pane .trow.on");
    if (state.tab === "tasks" && row && !row.contains(document.activeElement)) row.focus();
  };
  filter.addEventListener("input", () => { state.qs[state.tab] = filter.value; apply(); });
  // Half-typed answers and quick-adds: kept in the state, put back after an update or a reload.
  const restoreDrafts = (root) => {
    const els = [...(root.matches?.("[data-draft]") ? [root] : []), ...root.querySelectorAll("[data-draft]")];
    for (const el of els) if (state.drafts[el.dataset.draft] != null && el.value !== state.drafts[el.dataset.draft]) el.value = state.drafts[el.dataset.draft];
  };
  document.addEventListener("input", (e) => {
    const d = e.target.dataset?.draft;
    if (!d) return;
    if (e.target.value) state.drafts[d] = e.target.value;
    else delete state.drafts[d];
    vscode.setState(state);
  });
  const sendAnswer = (id) => {
    const ta = document.querySelector('#pane textarea[data-draft="ans-' + id + '"]');
    const text = (ta?.value || "").trim();
    if (!text) return ta?.focus();
    vscode.postMessage({ type: "answer", id: Number(id), text });
    delete state.drafts["ans-" + id];
    ta.value = "";
    ta.closest(".card")?.classList.add("sent");
    vscode.setState(state);
  };
  const sendAdd = (input) => {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "add", task: Number(input.dataset.task), text });
    delete state.drafts[input.dataset.draft];
    input.value = "";
    vscode.setState(state);
  };
  const toggleIn = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  /** A click on a task tab's control. */
  const act = (el) => {
    const d = el.dataset;
    switch (d.act) {
      case "filter": return setView({ filter: d.f, sel: null });
      case "scope": return setView({ all: d.all === "1" });
      case "sel": return setView({ sel: Number(d.id) });
      case "open": return go({ tab: "tasks", sel: Number(d.id), filter: d.f || state.filter });
      case "tab": return go({ tab: d.tab });
      case "showDone": return setView({ showDone: toggleIn(state.showDone, Number(d.task)) });
      case "old": return setView({ old: toggleIn(state.old, Number(d.task)) });
      case "edits": state.qs.edits = d.key; return go({ tab: "edits" });
      case "url": return vscode.postMessage({ type: "openUrl", url: d.url });
      case "newTask": return vscode.postMessage({ type: "newTask" });
      case "answer": return sendAnswer(d.id);
      case "rec": {
        // Shown at once; the update that follows confirms it.
        if (el.classList.contains("check")) { el.classList.toggle("on"); el.closest(".trec")?.classList.toggle("done"); }
        else el.closest(".card")?.classList.add("sent");
        return vscode.postMessage({ type: "rec", id: Number(d.id), op: d.op });
      }
    }
  };
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches?.('#pane select[data-change="taskStatus"]')) vscode.postMessage({ type: "taskStatus", task: Number(t.dataset.task), status: t.value });
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    const tab = t.closest("nav button");
    if (tab) return go({ tab: tab.dataset.tab });
    const control = t.closest("#pane [data-act]");
    if (control) {
      e.preventDefault();
      return act(control);
    }
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
    const chip = t.closest("#kinds .chip");
    if (chip) { state.kinds[chip.dataset.kind] = state.kinds[chip.dataset.kind] === false; return apply(); }
    const grp = t.closest("a.grp");
    if (grp) {
      e.preventDefault();
      const a = grp.dataset.agent;
      state.agents = state.agents.includes(a) ? state.agents.filter((x) => x !== a) : [...state.agents, a];
      return apply();
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
  // Keyboard (#69): j/k move in the list, Enter opens, x ticks, a answers, / searches, Esc goes back.
  const NAV = { tasks: "#pane .rows", inbox: '#pane [data-navgroup="inbox"]', home: '#pane [data-navgroup="home"]' };
  const visible = (el) => !el.hidden && el.offsetParent !== null;
  const move = (step) => {
    const at = document.activeElement?.closest?.("[data-nav]");
    const group = document.activeElement?.closest?.("[data-navgroup]") || document.querySelector(NAV[state.tab] || "#none-such");
    if (!group) return;
    const items = [...group.querySelectorAll("[data-nav]")].filter(visible);
    if (!items.length) return;
    const i = items.indexOf(at);
    const next = items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + step))];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t.matches?.("input, textarea, select");
    if (e.key === "Escape") {
      if (typing) return t.blur();
      return goBack();
    }
    if (typing) {
      if (t.matches("textarea[data-draft]") && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); return sendAnswer(t.dataset.draft.slice(4)); }
      if (t.matches("input[data-add]") && e.key === "Enter") { e.preventDefault(); return sendAdd(t); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); filter.focus(); return filter.select(); }
    if (state.tab === "edits") return;
    if (e.key === "j" || e.key === "k") { e.preventDefault(); return move(e.key === "j" ? 1 : -1); }
    const item = t.closest?.("[data-nav]");
    if (e.key === "Enter" && item && !t.matches("button, a")) { e.preventDefault(); return (item.matches("[data-act]") ? item : item.querySelector("[data-act]"))?.click(); }
    if (e.key === "x" && item) {
      const done = item.querySelector('.check, button[data-op="done"]');
      if (done) { e.preventDefault(); done.click(); }
      return;
    }
    if (e.key === "a") {
      const box = item?.querySelector("textarea") || [...document.querySelectorAll("#pane textarea[data-draft]")].find(visible);
      if (box) { e.preventDefault(); box.focus(); }
    }
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
    const freshPane = doc.getElementById("pane");
    if (freshPane) morph(document.getElementById("pane"), freshPane);
    showFlash();
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
  // The task tabs: blocks with a data-k key are swapped only when they changed, so
  // a half-typed answer, the focus and the list's scroll stay; a swapped block gets
  // its drafts, focus and scroll back.
  const keyed = (el) => el.children.length > 0 && [...el.children].every((c) => c.dataset.k);
  const attrs = (el) => [...el.attributes].map((a) => a.name + "=" + a.value).sort().join(" ");
  const swap = (a, b) => {
    const act = document.activeElement;
    const inside = act && act !== document.body && a.contains(act);
    const focus = inside && { draft: act.dataset?.draft, id: act.id, s: act.selectionStart, e: act.selectionEnd };
    const scrolls = [a, ...a.querySelectorAll("[data-scroll]")].filter((x) => x.dataset?.scroll).map((x) => [x.dataset.scroll, x.scrollTop]);
    a.replaceWith(b);
    restoreDrafts(b);
    for (const [k, top] of scrolls) {
      const x = b.dataset?.scroll === k ? b : b.querySelector('[data-scroll="' + k + '"]');
      if (x) x.scrollTop = top;
    }
    if (focus) {
      const again = focus.draft ? b.querySelector('[data-draft="' + focus.draft + '"]') : focus.id ? document.getElementById(focus.id) : null;
      if (again) {
        again.focus({ preventScroll: true });
        if (focus.s != null && again.setSelectionRange) try { again.setSelectionRange(focus.s, focus.e); } catch {}
      }
    }
    return b;
  };
  const morph = (a, b) => {
    if (a.outerHTML === b.outerHTML) return a;
    if (a.tagName !== b.tagName || attrs(a) !== attrs(b) || !keyed(a) || !keyed(b)) return swap(a, b);
    const old = new Map([...a.children].map((c) => [c.dataset.k, c]));
    let prev = null;
    for (const nb of [...b.children]) {
      let cur = old.get(nb.dataset.k);
      if (cur) {
        old.delete(nb.dataset.k);
        cur = morph(cur, nb);
      } else cur = nb;
      const want = prev ? prev.nextElementSibling : a.firstElementChild;
      if (cur !== want) {
        a.insertBefore(cur, want);
        restoreDrafts(cur);
      }
      prev = cur;
    }
    old.forEach((c) => c.remove());
    return a;
  };
  /** A record a link pointed at: scrolled to and lit once. */
  let flashed = "";
  const showFlash = () => {
    const el = document.querySelector("#pane .flash");
    const id = el && el.id;
    if (!id || id === flashed) return;
    flashed = id;
    el.scrollIntoView({ block: "center" });
  };
  addEventListener("message", (e) => {
    if (e.data?.type === "preview") return showReview(e.data);
    // The host moved the page (a link from elsewhere): its tab and task.
    if (e.data?.type === "view") { Object.assign(state, e.data.view); return apply(); }
    // A write that failed: the text the box held goes back into it.
    if (e.data?.type === "failed") {
      const key = e.data.what === "answer" ? "ans-" + e.data.id : e.data.what === "add" ? "add-" + e.data.task : "";
      if (key && e.data.text) {
        state.drafts[key] = e.data.text;
        vscode.setState(state);
        const box = document.querySelector('#pane [data-draft="' + key + '"]');
        if (box && !box.value) box.value = e.data.text;
      }
      document.querySelectorAll("#pane .sent").forEach((el) => el.classList.remove("sent"));
      return;
    }
    if (e.data?.type !== "render") return;
    reviews.clear(); // edits changed: their rendered reviews may have too
    next = e.data.html;
    update();
  });
  addEventListener("scroll", hide);
  restoreDrafts(document.body);
  apply();
  showFlash();
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
/** A refresh came while the panel was not visible. */
let missed = false;
/** @type {(file: string, n: number) => string | undefined} */
let renderEditOf = () => undefined;
/** The last page sent (the integration tests read it). */
let lastHtml = "";
/** The last write the page sent that failed: its text goes back to the page. @type {any} */
let lastFailed;

/**
 * What the panel shows (#69): its tab, the selected task, the list's filter, every
 * repo or this one, tasks with their done todos or old activity open, a record to
 * light up. The page keeps the same in its state; a "view" message changes it.
 */
const view = { tab: "edits", sel: /** @type {number | null} */ (null), filter: "active", all: false, showDone: /** @type {number[]} */ ([]), old: /** @type {number[]} */ ([]), flash: /** @type {number | null} */ (null) };
/** Where "every repo" is kept (extension.js: the workspace state, as the record views kept it). */
let scopeStore = { get: () => false, set: (/** @type {boolean} */ _v) => {} };
/** @param {{get: () => boolean, set: (v: boolean) => void}} store */
function setPanelScope(store) {
  scopeStore = store;
  view.all = !!store.get();
}
/** The view as the page keeps it. */
const pageView = () => ({ tab: view.tab, sel: view.sel, filter: view.filter, all: view.all, showDone: view.showDone, old: view.old });

/**
 * Moves the view: a tab, or a task (by key in a repo, or by one of its records) on Görevler.
 * @param {{tab?: string, sel?: number | null, filter?: string, all?: boolean, showDone?: number[], old?: number[], root?: string, task?: string, record?: number}} at
 * @returns {boolean} false: the task or record is not in the database
 */
function moveView(at) {
  const clean = tasksView.cleanView(at);
  Object.assign(view, clean, { flash: null });
  if ("all" in clean) scopeStore.set(view.all);
  if (!at.task && !at.record) return true;
  const db = records.dbOf();
  if (!db) return false;
  const rec = at.record ? db.record(Number(at.record)) : undefined;
  const repoId = records.repoId(at.root ?? shown ?? "");
  const task = rec ? db.taskById(rec.task_id) : at.task && repoId !== undefined ? db.taskByKey(repoId, at.task) : undefined;
  if (!task) return false;
  Object.assign(view, { tab: "tasks", sel: task.id, filter: tasksView.bucketOf(task.status), flash: rec?.id ?? null });
  // A task of another repo shows with every repo on.
  if (task.repo_id !== repoId) {
    view.all = true;
    scopeStore.set(true);
  }
  return true;
}

/** A task's issue or Jira page: GitHub for #n, else a Jira address the repo's records know. @param {string} root @param {string} key */
function linkOf(root, key) {
  if (key.startsWith("#")) {
    const gh = githubOf(root);
    return gh && /^#\d+$/.test(key) ? `${gh}/issues/${key.slice(1)}` : undefined;
  }
  return records.jiraLink(root, key);
}

/**
 * A message from the page: a click on an edit, a tick, a write to a record, a view change.
 * The integration tests send the same through panelMessage.
 * @param {any} m
 */
function onMessage(m) {
  if (m.type === "check") return timed("tick", m, () => tick(m));
  if (m.type === "perf") return perfLog(m);
  if (m.type === "audit") return auditAll();
  if (m.type === "openUrl" && /^https?:\/\//.test(m.url)) return vscode.env.openExternal(vscode.Uri.parse(m.url));
  if (m.type === "showRecord" && shown) return showIn({ root: shown, record: Number(m.id) });
  if (m.type === "showTask" && shown) return showIn({ root: shown, task: String(m.task) });
  if (m.type === "scan") return scanAll();
  if (m.type === "view") {
    const toEdits = m.view?.tab === "edits" && view.tab !== "edits";
    moveView(m.view ?? {});
    return refresh?.(!toEdits);
  }
  if (m.type === "newTask") return newTask();
  if (["rec", "answer", "add", "taskStatus"].includes(m.type)) return writeFromPanel(m);
  if (m.type === "preview" && shown) {
    let html;
    try {
      html = renderEditOf(path.join(shown, m.file), m.n);
    } catch {
      // the line diff stays
    }
    return void panel?.webview.postMessage({ type: "preview", file: m.file, n: m.n, html });
  }
  if (m.type === "accept") return timed("accept", m, () => actions?.acceptEdit(m.file, m.n));
  if (m.type === "open") return actions?.openDiff(m.file, m.n);
}

/** Show a task (or record) of the open panel's repo on Görevler. @param {{root: string, task?: string, record?: number}} at */
function showIn(at) {
  if (!moveView(at)) return void vscode.window.showInformationMessage(`Imprimatur: ${at.task ?? "this record"} has no records yet.`);
  panel?.webview.postMessage({ type: "view", view: pageView() });
  refresh?.(true);
}

/** A record or task written from the page, as the user; then the page redraws (the database watcher does it again, unchanged). @param {any} m */
function writeFromPanel(m) {
  const db = records.dbOf();
  if (!db) return void vscode.window.showErrorMessage(`Imprimatur: ${records.lastError ?? "database not available"}`);
  try {
    tasksView.applyMessage(db, m, tasksView.userActor());
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // The page cleared the box when it sent: give the text back.
    lastFailed = { type: "failed", what: m.type, id: m.id, task: m.task, text: typeof m.text === "string" ? m.text : undefined, error };
    panel?.webview.postMessage(lastFailed);
    vscode.window.showErrorMessage(error);
  }
  try {
    if (shown) {
      closeDoneTasks(shown);
      scanTodos(shown);
    }
  } catch {
    // a waiting log being written: the next change catches up
  }
  refresh?.(true);
}

/** "Yeni görev": a key and a title, then the task opens. */
async function newTask() {
  const root = shown;
  if (!root || !records.dbOf()) return;
  const key = (await vscode.window.showInputBox({ prompt: "Görev anahtarı (#70, PROJ-12 …)", validateInput: (v) => (v.trim() ? undefined : "Boş olamaz") }))?.trim();
  if (!key) return;
  const db = records.dbOf();
  const repo = db?.repoOf(root);
  if (!repo) return;
  let task = db.taskByKey(repo.id, key);
  if (!task) {
    const title = await vscode.window.showInputBox({ prompt: `${key} başlığı` });
    if (title === undefined) return;
    task = db.upsertTask(repo.id, key, { title: title.trim(), status: "active" });
  }
  showIn({ root, record: undefined, task: key });
}

/**
 * Opens the panel (or brings it forward), on a tab or a task when `at` says so.
 * @param {string} root repo root
 * @param {(file: string, n: number) => unknown} openDiff
 * @param {(file: string) => string | undefined} currentText
 * @param {(file: string, n: number) => unknown} acceptEdit
 * @param {(file: string, n: number) => unknown} goTo
 * @param {(file: string, n: number) => string | undefined} [renderEdit] an edit as a rendered Markdown review (#50)
 * @param {vscode.WebviewPanel} [restored] a panel VS Code brought back after a reload (the serializer)
 * @param {{tab?: string, sel?: number | null, filter?: string, all?: boolean, task?: string, record?: number, root?: string}} [at] where to open it
 */
function openGraph(root, openDiff, currentText, acceptEdit, goTo, renderEdit = () => undefined, restored, at) {
  // One graph panel: a restored one while another is open goes away.
  if (restored && panel && restored !== panel) restored.dispose();
  renderEditOf = renderEdit;
  // Open on this repo already: move it, no reload (the page keeps what is typed).
  if (panel && !restored && shown === root && refresh) {
    if (at && !moveView(at)) vscode.window.showInformationMessage(`Imprimatur: ${at.task ?? "this record"} has no records yet.`);
    panel.webview.postMessage({ type: "view", view: pageView() });
    refresh(view.tab !== "edits");
    return panel.reveal();
  }
  if (!panel) {
    if (restored) restored.webview.options = WEBVIEW_OPTIONS;
    panel = restored ?? vscode.window.createWebviewPanel("imprimatur.graph", "Imprimatur", vscode.ViewColumn.Active, WEBVIEW_OPTIONS);
    panel.title = "Imprimatur";
    panel.webview.onDidReceiveMessage(onMessage);
    // A hidden webview is torn down and gets no messages: shown again, it reloads from the html, so make that current.
    let hidden = false;
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (!webviewPanel.visible) hidden = true;
      else if (hidden) {
        hidden = false;
        missed = false;
        reload?.();
      } else if (missed) {
        missed = false;
        refresh?.(false);
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
  if (at && !moveView(at)) vscode.window.showInformationMessage(`Imprimatur: ${at.task ?? "this record"} has no records yet.`);
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
      // Descriptions cost model calls: only for edits on screen.
      if (view.tab === "edits") describeShown(root, edits.rows);
    }
    const waiting = waitingSteps(root);
    const db = records.dbOf();
    let pane = "";
    let inbox;
    try {
      inbox = tasksView.inboxCount(db, root, waiting, { all: view.all });
      // Only the visible tab is drawn.
      if (view.tab !== "edits") pane = tasksView.paneHtml(db, root, view, { waiting, linkOf, error: records.lastError });
    } catch (e) {
      pane = `<p class="empty" data-k="error">Imprimatur: ${esc(e instanceof Error ? e.message : String(e))}</p>`;
    }
    const repoName = (db && tasksView.repoOfRoot(db, root)?.name) || path.basename(root);
    return html(edits, root, nonce, waiting, { view: pageView(), pane, inbox, repoName });
  };
  // An edit refreshes three times (extension.js refreshSoon): send only what changed.
  let sent = "";
  // Load once; after that the page updates in place (its "render" message):
  // setting the html reloads it, and a click during a reload is lost.
  reload = () => {
    sent = "";
    p.webview.html = lastHtml = page();
  };
  reload();
  refresh = (waitingOnly = false) => {
    // Not drawn while hidden, but not forgotten: drawn when it shows (onDidChangeViewState).
    if (!p.visible) return void (missed = true);
    const next = page("", waitingOnly);
    if (next !== sent) p.webview.postMessage({ type: "render", html: (sent = lastHtml = next) });
  };
  if (!restored) p.reveal();
  // Set up after work began: once per project, find what already waited on the user.
  if (!scannedBefore(root) && allowed("scan history")) scanAll();
}

/** The open panel, for the integration tests: its repo, view, last page and last failed write. */
const panelState = () => ({ open: !!panel, root: shown, view: { ...view }, html: lastHtml, failed: lastFailed });

/**
 * What waits on the user, counted once for every place that shows it (the launcher's
 * badge, the status bar, the panel's tab badge, Bende bekleyenler): the open panel's
 * repo and scope, else this root's repo.
 * @param {string | undefined} root the window's repo when no panel is open
 */
function inboxNow(root) {
  const where = shown ?? root;
  if (!where) return 0;
  const waiting = waitingSteps(where);
  try {
    return tasksView.inboxCount(records.dbOf(), where, waiting, { all: shown ? view.all : !!scopeStore.get() });
  } catch {
    return tasksView.openTurn(waiting).length;
  }
}

/** The folder was trusted: describe what is shown, run the first scan if it never ran. */
function graphTrusted() {
  if (!shown) return;
  refreshGraph();
  if (!scannedBefore(shown)) scanAll();
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
  if (process.env.IMPRIMATUR_DESCRIBE === "off" || !allowed("edit descriptions (claude)")) return;
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
  if (!allowed("audit (claude)")) {
    reload?.(); // the button shows "Auditing…" and an update would not redraw it: load the page anew
    return void vscode.window.showInformationMessage("Imprimatur: Audit calls the claude CLI; trust this folder to use it.");
  }
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
const modelLang = () => vscode.workspace.getConfiguration("imprimatur").get("language") || require("./config.js").hookLang();

/** Projects being scanned now (a second click or panel open waits for the first). */
const scanning = new Set();

/**
 * Scan history (vscode/history.js): what waited on the user before Imprimatur
 * was set up. The Scan history button, and once per project on its own.
 */
async function scanAll(again = false) {
  const root = shown;
  if (!root || scanning.has(root)) return;
  if (!allowed("scan history (claude)")) {
    reload?.();
    return void vscode.window.showInformationMessage("Imprimatur: Scan history calls the claude CLI; trust this folder to use it.");
  }
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

module.exports = { openGraph, refreshGraph, syncRecords, graphCommands, graphTrusted, setGraphLog, setPanelScope, panelState, inboxNow, panelMessage: onMessage, laneSvg, html, cssPaths, WEBVIEW_OPTIONS };
