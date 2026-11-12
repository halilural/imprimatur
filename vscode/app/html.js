// @ts-check
// The new Imprimatur panel's HTML (#195). Calm and keyboard first (Linear), VS Code's own theme
// colors only, so it reads in light and dark; one reading layout for every document (Starlight,
// Docusaurus): the whole page in a readable column, "on this page" on the right.
"use strict";

const esc = (/** @type {unknown} */ s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: 14px; line-height: 1.6; color: var(--vscode-editor-foreground, var(--vscode-foreground)); background: var(--vscode-editor-background); }
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { text-decoration: underline; }
.top { display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 2; }
.top .repo { font-weight: 700; font-size: 15px; }
.top .search { flex: 1; max-width: 520px; text-align: left; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-placeholderForeground); cursor: pointer; font: inherit; }
.top .search kbd { float: right; }
.top .wait { font-weight: 700; padding: 3px 10px; border-radius: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); cursor: pointer; border: 0; font: inherit; }
kbd { font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.shell { display: grid; grid-template-columns: 180px 1fr; min-height: calc(100vh - 52px); }
nav.areas { padding: 14px 8px; border-right: 1px solid var(--vscode-panel-border); }
nav.areas button { display: flex; width: 100%; align-items: center; justify-content: space-between; padding: 7px 10px; margin: 1px 0; border: 0; border-radius: 6px; background: transparent; color: var(--vscode-foreground); font: inherit; font-weight: 600; cursor: pointer; text-align: left; }
nav.areas button:hover { background: var(--vscode-list-hoverBackground); }
nav.areas button.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
nav.areas .more { margin-top: 18px; padding: 0 10px; font-size: 12px; font-weight: 700; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
nav.areas .more + button, nav.areas .sub { font-weight: 500; }
main { padding: 24px 32px 48px; min-width: 0; max-width: 1120px; }
h1 { font-size: 24px; margin: 0 0 6px; }
.summary { font-size: 15px; color: var(--vscode-descriptionForeground); margin: 0 0 20px; max-width: 72ch; }
.reading { display: grid; grid-template-columns: minmax(0, 72ch) 200px; gap: 40px; }
.reading .onpage { position: sticky; top: 70px; align-self: start; font-size: 13px; max-height: calc(100vh - 90px); overflow: auto; }
.reading .onpage { border-left: 1px solid var(--vscode-panel-border); padding-left: 14px; }
.reading .onpage a { display: block; padding: 3px 0; color: var(--vscode-descriptionForeground); }
.reading .onpage a:hover { color: var(--vscode-foreground); text-decoration: none; }
.reading .onpage .label { font-size: 12px; font-weight: 700; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
.page section { position: relative; margin-bottom: 32px; scroll-margin-top: 64px; }
.page h2 { font-size: 19px; margin: 0 0 10px; padding: 4px 60px 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.page p, .page li { margin: 0 0 10px; }
.page details summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 13px; }
.page details.edit > summary { position: absolute; top: 8px; right: 0; opacity: 0; color: var(--vscode-textLink-foreground); }
.page section:hover details.edit > summary, .page details.edit[open] > summary, .page details.edit > summary:focus { opacity: 1; }
.page details.edit[open] { margin-bottom: 12px; }
pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-family: var(--vscode-editor-font-family); font-size: .92em; color: inherit; }
:not(pre) > code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; }
pre code { background: none; padding: 0; }
.page table { display: block; overflow-x: auto; border-collapse: collapse; margin: 0 0 14px; font-size: 13px; }
.page th, .page td { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; text-align: left; vertical-align: top; min-width: 120px; }
.page th { background: var(--vscode-editorWidget-background); font-weight: 700; }
.empty { padding: 24px; border: 1px dashed var(--vscode-panel-border); border-radius: 8px; color: var(--vscode-descriptionForeground); }
.pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.pills button { padding: 4px 12px; border-radius: 14px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); font: inherit; cursor: pointer; }
.pills button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.rows { border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
.rows > .row, .rows > details { display: flex; gap: 14px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
.rows > details { display: block; padding: 0; border-radius: 0; margin: 0; border: 0; border-bottom: 1px solid var(--vscode-panel-border); }
.rows > :last-child { border-bottom: 0; }
.rows .row:hover, .rows > details > summary:hover { background: var(--vscode-list-hoverBackground); }
.rows .key { flex: none; min-width: 52px; font-family: var(--vscode-editor-font-family); font-size: 13px; line-height: 22px; color: var(--vscode-descriptionForeground); }
.rows .none, .rows .empty { padding: 12px 14px; border: 0; }
.rows .ptr { color: var(--vscode-descriptionForeground); }
.board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 26px; }
.board .col { border-radius: 8px; padding: 10px; min-height: 80px; background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); }
.board .label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.board .card { padding: 10px 12px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); margin-bottom: 8px; cursor: pointer; }
.board .card .ptr { margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.board .card:hover { background: var(--vscode-list-hoverBackground); }
.board .ptr, .rows .ptr { font-size: 13px; color: var(--vscode-descriptionForeground); }
.board .none { color: var(--vscode-descriptionForeground); font-size: 13px; }
h2.sub { font-size: 16px; margin: 24px 0 10px; }
.tag { font-size: 12px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
@media (max-width: 900px) { .board { grid-template-columns: 1fr; } }
.gates { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 16px; }
.gate { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.gate span { font-weight: 700; }
.gate.done { color: var(--vscode-foreground); border-color: var(--vscode-testing-iconPassed, var(--vscode-panel-border)); }
.gate.next { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
.btn.small { padding: 2px 10px; font-size: 12px; }
.crumb { font-size: 13px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
.rows .rec { cursor: default; }
.editor { display: grid; gap: 8px; margin-top: 8px; }
.editor input, .editor textarea, .editor select { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 6px 8px; }
.editor textarea { font-family: var(--vscode-editor-font-family); }
details.edit > summary, details.newsec > summary { font-size: 12px; color: var(--vscode-descriptionForeground); }
details.newsec { margin-bottom: 14px; }
.btn { padding: 6px 14px; border-radius: 6px; border: 0; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-weight: 600; cursor: pointer; }
.xcard { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
.xcard h2 { display: flex; gap: 10px; align-items: center; font-size: 17px; margin: 0 0 6px; } .xcard h2 .ptr { font-weight: 400; margin-left: auto; }
.bar { height: 4px; border-radius: 2px; background: var(--vscode-panel-border); margin: 4px 0 10px; } .bar div { height: 4px; border-radius: 2px; background: var(--vscode-progressBar-background); }
.step { display: flex; gap: 10px; align-items: flex-start; padding: 6px 8px; border-radius: 6px; }
.step:hover { background: var(--vscode-list-hoverBackground); } .step.now { box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
.step.sub { margin-left: 28px; } .step.done .ttl, .step.skipped .ttl { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
.step .col { flex: 1; min-width: 0; } .step .ttl p { display: inline; margin: 0; } .step .ttl ol, .step .ttl ul { display: inline; margin: 0; padding: 0; list-style-position: inside; } .step .ttl li { display: inline; }
.why { margin: 6px 0; } .why p { margin: 2px 0 6px; } .step .why { font-size: 13px; color: var(--vscode-descriptionForeground); }
.box { flex: none; width: 18px; height: 18px; margin-top: 3px; border-radius: 4px; border: 1px solid var(--vscode-checkbox-border, var(--vscode-panel-border)); background: var(--vscode-checkbox-background, transparent); color: var(--vscode-foreground); cursor: pointer; padding: 0; font-size: 12px; line-height: 16px; }
.box.split { border-style: dashed; cursor: default; }
.link { border: 0; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; font-size: 12px; padding: 0 4px; }
.meet { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 8px; } .meet > summary { cursor: pointer; padding: 10px 14px; display: flex; gap: 14px; align-items: flex-start; }
.count { margin-left: auto; flex: none; font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.meet .mbody { padding: 0 12px 12px; } .meet .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; } .meet ul { margin: 4px 0; padding-left: 18px; }
@media (max-width: 900px) { .reading { grid-template-columns: minmax(0, 1fr); } .reading .onpage { display: none; } .shell { grid-template-columns: 1fr; } nav.areas { display: flex; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); } nav.areas button { width: auto; } }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const send = (m) => vscode.postMessage(m);
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-edit],[data-ex],[data-gate],[data-tab],[data-file],[data-go],[data-cmd],[data-doc],[data-scope],[data-task]");
  if (!el) return;
  e.preventDefault();
  if (el.dataset.edit) send({ type: "edit", act: el.dataset.edit, file: el.dataset.file, n: Number(el.dataset.n) });
  else if (el.dataset.ex) send({ type: "ex", act: el.dataset.ex, id: Number(el.dataset.id), status: el.dataset.status, result: el.dataset.result });
  else if (el.dataset.gate) send({ type: "gate", key: el.dataset.key, gate: el.dataset.gate });
  else if (el.dataset.file) send({ type: "file", file: el.dataset.file });
  else if (el.dataset.tab) send({ type: "go", area: "tasks", task: el.dataset.key, tab: el.dataset.tab });
  else if (el.dataset.go) send({ type: "go", area: el.dataset.go });
  else if (el.dataset.doc) send({ type: "go", area: "docs", doc: el.dataset.doc });
  else if (el.dataset.scope) send({ type: "go", area: "docs", doc: "capabilities", scope: el.dataset.scope });
  else if (el.dataset.task) send({ type: "task", key: el.dataset.task });
  else if (el.dataset.cmd) send({ type: "cmd", command: el.dataset.cmd });
});
document.addEventListener("submit", (e) => {
  const n = e.target.closest("form[data-exnote]");
  if (n) { e.preventDefault(); return send({ type: "ex", act: "exNote", id: Number(n.dataset.exnote), text: n.elements.text.value }); }
  const f = e.target.closest("form[data-save]");
  if (!f) return;
  e.preventDefault();
  const v = (n) => f.elements[n]?.value;
  send({ type: "save", kind: f.dataset.kind, scope: f.dataset.dscope || undefined, key: f.dataset.key, isNew: !!f.dataset.new, title: v("title"), body: v("body"), chapter: v("chapter") });
});
// g then a letter jumps to an area; / or ctrl/cmd+k opens Search and Ask.
let g = 0;
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input,textarea")) return;
  if (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); return send({ type: "cmd", command: "imprimatur.records.search" }); }
  if (e.key === "g") { g = Date.now(); return; }
  if (Date.now() - g < 1200) {
    const area = { h: "home", t: "tasks", d: "docs", e: "edits", s: "setup" }[e.key];
    if (area) send({ type: "go", area });
    g = 0;
  }
});
`;

/**
 * The reading layout: every section in full in one readable column, "on this page" on the right,
 * each section's editor behind an Edit link beside its heading.
 * @param {{title: string, summary?: string, sections: Array<{key: string, title: string, body: string}>}} r
 * @param {(md: string) => string} render Markdown to safe HTML
 * @param {string} [extra] HTML above the page (a capability's picker)
 */
function readingHtml(r, render, extra = "") {
  const ed = /** @type {any} */ (r).edit;
  const edAttrs = ed ? `data-kind="${esc(ed.kind)}" data-dscope="${esc(ed.scope ?? "")}"` : "";
  // A new section: its title, its chapter where the document has chapters, its text.
  const add = ed ? `<details class="newsec"><summary>New section</summary><form class="editor" data-save ${edAttrs} data-new="1">
    <input name="title" placeholder="Title" required>${ed.chapters ? `<select name="chapter">${Object.entries(ed.chapters).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select>` : ""}
    <textarea name="body" rows="6" placeholder="Text (Markdown)"></textarea><button class="btn small" type="submit">Save</button></form></details>` : "";
  if (!r.sections.length) {
    return `<h1>${esc(r.title)}</h1>${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ""}${extra}<div class="empty">Nothing written here yet.</div>${add}`;
  }
  const links = r.sections.map((s) => `<a href="#${esc(s.key)}">${esc(s.title)}</a>`).join("");
  const page = r.sections.map((s) => {
    const editor = ed ? `<details class="edit"><summary>Edit</summary><form class="editor" data-save ${edAttrs} data-key="${esc(s.key)}">
      <input name="title" value="${esc(s.title)}" required><textarea name="body" rows="10">${esc(s.body)}</textarea><button class="btn small" type="submit">Save</button></form></details>` : "";
    return `<section id="${esc(s.key)}"><h2>${esc(s.title)}</h2>${editor}${render(String(s.body).replace(/\r\n/g, "\n").trim())}</section>`;
  }).join("");
  return `<h1>${esc(r.title)}</h1>${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ""}${extra}${add}
  <div class="reading"><div class="page">${page}</div><div class="onpage"><div class="label">On this page</div>${links}</div></div>`;
}

/** The area's main content. @param {any} m @param {(md: string) => string} render */
function mainHtml(m, render) {
  if (m.area === "docs") {
    const pills = `<div class="pills">${m.docs.map((/** @type {any} */ d) => `<button data-doc="${esc(d.id)}" class="${d.id === m.doc ? "on" : ""}">${esc(d.label)}</button>`).join("")}</div>`;
    const scopes = m.reading.scopes?.length > 1 ? `<div class="pills">${m.reading.scopes.map((/** @type {string} */ s) => `<button data-scope="${esc(s)}" class="${s === m.reading.scope ? "on" : ""}">${esc(s)}</button>`).join("")}</div>` : "";
    return pills + readingHtml(m.reading, render, scopes);
  }
  if (m.area === "tasks" && m.page) return taskPageHtml(m.page, render);
  if (m.area === "tasks") {
    return `<h1>Tasks</h1><p class="summary">Active first, then open, then the last done.</p>` + m.lists.map((/** @type {any} */ l) =>
      `<h2 class="sub">${esc(l.label)} · ${l.tasks.length}</h2><div class="rows">${l.tasks.map((/** @type {any} */ t) => `<div class="row" data-task="${esc(t.key)}"><span class="key">${esc(t.key)}</span><span><b>${esc(t.title)}</b>${t.summary ? `<br><span class="ptr">${esc(t.summary)}</span>` : ""}</span></div>`).join("") || '<div class="none">Nothing</div>'}</div>`).join("");
  }
  if (m.area === "home") {
    const rows = m.tasks.map((/** @type {any} */ t) => `<div class="row" data-task="${esc(t.key)}"><span class="key">${esc(t.key)}</span><span><b>${esc(t.title)}</b>${t.docs?.length ? ` <span class="tag">${t.docs.map(esc).join(" · ")}</span>` : ""}${t.pointer_title ? `<br><span class="ptr">👉 ${esc(t.pointer_title)}</span>` : ""}</span></div>`).join("");
    const card = (/** @type {any} */ t, /** @type {string} */ note) => `<div class="card" data-task="${esc(t.key)}"><b>${esc(t.key)}</b> ${esc(t.title)}${note ? `<div class="ptr">${esc(note)}</div>` : ""}</div>`;
    const col = (/** @type {string} */ title, /** @type {any[]} */ list, /** @type {(t: any) => string} */ note) => `<div class="col"><div class="label">${esc(title)} · ${list.length}</div>${list.map((t) => card(t, note(t))).join("") || '<div class="none">Nothing</div>'}</div>`;
    const b = m.board;
    const board = `<div class="board">${col("Needs you", b.needs, (t) => t.asks.slice(0, 2).join(" · "))}${col("Active", b.active, (t) => t.summary ?? "")}${col("Done this week", b.done, (t) => t.summary ?? "")}</div>`;
    return `<h1>Home</h1><p class="summary">What waits on you, what is in progress, what finished this week.</p>${board}
    <h2 class="sub">Where we left off</h2><div class="rows">${rows || '<div class="empty">No task in progress.</div>'}</div>`;
  }
  if (m.area === "edits") {
    const total = m.edits.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + f.open, 0);
    const btn = (/** @type {string} */ act, /** @type {string} */ label, /** @type {any} */ f, /** @type {any} */ e) => `<button class="${act === "accept" ? "btn small" : "link"}" data-edit="${act}" data-file="${esc(f.file)}" data-n="${e.n}">${label}</button>`;
    const rows = m.edits.map((/** @type {any} */ f) => `<details class="meet"><summary><span><b>${esc(f.file)}</b><br><span class="ptr">${esc(String(f.last).slice(0, 16).replace("T", " "))} · ${esc(String(f.what).replace(/\s+/g, " ").slice(0, 160))}</span></span><span class="count" title="Edits waiting">${f.open}</span><button class="link" data-file="${esc(f.file)}">Open</button></summary>
      <div class="mbody">${(f.items ?? []).map((/** @type {any} */ e) => `<div class="step"><div class="col"><b>#${e.n}</b> <span class="ptr">${esc(e.t.slice(0, 16).replace("T", " "))}</span> ${esc(String(e.what).replace(/\s+/g, " ").slice(0, 200))}</div>${btn("accept", "Accept", f, e)}${btn("diff", "Diff", f, e)}${btn("go", "Go", f, e)}</div>`).join("")}</div></details>`).join("");
    return `<h1>Edits</h1><p class="summary">${total ? `${total} agent edit${total === 1 ? "" : "s"} in ${m.edits.length} file${m.edits.length === 1 ? "" : "s"} wait for your review. Open a file to see each edit: accept it, see its diff, or go to it in the editor, where its lines stay marked until accepted.` : "Every agent edit is reviewed."}</p>
    <button class="btn" data-cmd="imprimatur.openGraph">Review all in the change graph</button><div class="rows" style="margin-top:14px">${rows}</div>`;
  }
  if (m.area === "exercises") return exercisesHtml(m.exercises, render);
  if (m.area === "meetings") return meetingsHtml(m.meetings, render);
  if (m.area === "social") return readingHtml(m.reading, render);
  if (m.area === "setup") {
    return `<h1>Setup</h1><p class="summary">How the agent is set up here: its files, skills, hooks and MCP servers, and what to improve.</p>
    <div class="rows"><div class="row" data-cmd="imprimatur.setup.focus"><span class="key">⚙</span><span><b>Agent setup</b><br><span class="ptr">The checklist of what is missing or out of date, in the side bar</span></span></div>
    <div class="row" data-task="RECS"><span class="key">${m.setup.recommendations}</span><span><b>Recommendations</b><br><span class="ptr">Open recommendations for the agent setup and the project</span></span></div></div>`;
  }
  return "";
}

const KIND = { learn: "Learn", example: "Example", predict: "Predict", do: "Do", vary: "Vary", explain: "Explain", recall: "Recall" };

/** Exercises (#202, from the old tab of #108): recalls due today, each going exercise's steps to tick, the finished ones. @param {any} x exerciseModel's result @param {(md: string) => string} render */
function exercisesHtml(x, render) {
  const recall = x.reviews.length ? `<h2 class="sub">Recall today · ${x.reviews.length}</h2><p class="summary">Say or write each one without your notes, then mark how it went.</p><div class="rows">${x.reviews.map((/** @type {any} */ r) =>
    `<div class="row rec"><span><b>${render(String(r.prompt))}</b><span class="ptr">${esc(r.topic)}</span></span><span style="margin-left:auto;white-space:nowrap">${[["right", "Got it"], ["partly", "Partly"], ["missed", "Missed"]].map(([k, l]) => `<button class="btn small" data-ex="exReview" data-id="${r.id}" data-result="${k}">${l}</button>`).join(" ")}</span></div>`).join("")}</div>` : "";
  const step = (/** @type {any} */ e, /** @type {any} */ s) => {
    const done = s.status === "done", split = e.split.has(s.id);
    const box = split ? `<span class="box split" title="Done when its smaller steps are">${done ? "✓" : ""}</span>`
      : `<button class="box" data-ex="exStep" data-id="${s.id}" data-status="${done ? "open" : "done"}" aria-label="${done ? "Open again" : "Mark as done"}">${done ? "✓" : ""}</button>`;
    const acts = !split && s.status === "open" ? `<button class="link" data-ex="exStep" data-id="${s.id}" data-status="skipped" title="Skip it; say why in its note">skip</button>`
      : s.status === "skipped" ? `<button class="link" data-ex="exStep" data-id="${s.id}" data-status="open">undo skip</button>` : "";
    const why = [["Why", s.why], ["Done when", s.done_when], ["Note", s.note]].filter(([, v]) => v).map(([l, v]) => `<div class="why"><b>${l}</b> ${render(String(v))}</div>`).join("");
    const note = `<details><summary class="ptr">${s.note ? "Edit the note" : "Add a note"}</summary><form class="editor" data-exnote="${s.id}"><textarea name="text" rows="2" maxlength="4000">${esc(s.note ?? "")}</textarea><button class="btn small" type="submit">Save</button></form></details>`;
    return `<div class="step${done ? " done" : ""}${s.status === "skipped" ? " skipped" : ""}${s.parent_id ? " sub" : ""}${e.now?.id === s.id ? " now" : ""}">${box}<div class="col"><span class="ttl">${render(String(s.title))}</span> <span class="tag">${esc(/** @type {any} */ (KIND)[s.kind] ?? s.kind)}</span>${s.minutes ? ` <span class="ptr">${s.minutes} min</span>` : ""}${e.now?.id === s.id ? ' <span class="tag">now</span>' : ""} ${acts}${why}${note}</div></div>`;
  };
  const card = (/** @type {any} */ e) => {
    const pct = e.total ? Math.round((e.closed / e.total) * 100) : 0;
    return `<section class="xcard"><h2>${esc(e.topic)}<span class="ptr">${e.closed} / ${e.total} steps</span><button class="link" data-ex="exDrop" data-id="${e.id}" title="Give up on it; it stays under Finished">drop</button></h2>
      <div class="bar" role="progressbar" aria-label="${esc(e.topic)} progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width:${pct}%"></div></div>
      ${e.goal ? `<div class="why"><b>Goal</b> ${render(String(e.goal))}</div>` : ""}${e.proof ? `<div class="why"><b>Checked by</b> ${render(String(e.proof))}</div>` : ""}
      ${e.steps.map((/** @type {any} */ s) => step(e, s)).join("")}
      ${e.weak?.length ? `<div class="why"><b>Weak points</b><ul>${e.weak.map((/** @type {any} */ w) => `<li>${esc(typeof w === "string" ? w : w.front)}</li>`).join("")}</ul></div>` : ""}</section>`;
  };
  const finished = x.finished.length ? `<details><summary><b>Finished · ${x.finished.length}</b></summary><div class="rows">${x.finished.map((/** @type {any} */ e) =>
    `<div class="row rec"><span class="tag">${esc(e.status)}</span><span><b>${esc(e.topic)}</b> <span class="ptr">${e.closed ?? 0} / ${e.step_count ?? 0} steps</span></span>${e.status === "dropped" ? `<button class="link" data-ex="exResume" data-id="${e.id}">resume</button>` : ""}</div>`).join("")}</div></details>` : "";
  return `<h1>Exercises</h1><p class="summary">Any topic in small steps you tick. Start one in Claude Code: <code>/exercise &lt;topic&gt;</code>.</p>${recall}
  ${x.active.length ? x.active.map(card).join("") : '<div class="empty">No exercise going. Type /exercise and a topic in Claude Code.</div>'}${finished}`;
}

/** Meetings (#202, from the old tab of #169): newest first by month, each with its decisions, to-dos and note. @param {any[]} list meetingsModel's meetings @param {(md: string) => string} render */
function meetingsHtml(list, render) {
  const top = `<h1>Meetings</h1><p class="summary">What was decided and what you took on, meeting by meeting.</p>`;
  if (!list.length) return `${top}<div class="empty">No meetings in this repo yet. A meeting app writes them as meeting records.</div>`;
  const items = (/** @type {any[]} */ xs) => (xs.length ? `<ul>${xs.map((k) => `<li>${k.status === "done" ? "✓ " : ""}${esc(k.title)}${k.owner === "K" ? ' <span class="tag">You</span>' : ""}</li>`).join("")}</ul>` : '<div class="none">None</div>');
  /** @type {Map<string, any[]>} */ const byMonth = new Map();
  for (const x of list) byMonth.set(x.month, [...(byMonth.get(x.month) ?? []), x]);
  return top + [...byMonth].map(([month, xs]) => `<h2 class="sub">${esc(month)}</h2>${xs.map((x) => {
    const mine = x.todos.filter((/** @type {any} */ k) => k.owner === "K" && k.status !== "done").length;
    return `<details class="meet"><summary><b>${x.dd} ${esc(x.mon)}</b><span><b>${esc(x.title)}</b>${x.gist ? `<br><span class="ptr">${esc(x.gist)}</span>` : ""}</span><span class="ptr" style="margin-left:auto">${x.decisions.length} decisions${mine ? ` · ${mine} yours` : ""}</span></summary>
      <div class="mbody"><div class="cols"><div><b>Decisions</b>${items(x.decisions)}</div><div><b>To-dos</b>${items(x.todos)}</div></div>
      <p class="ptr"><a href="#" data-task="${esc(x.task.key)}">${esc(x.task.key)}</a></p>${x.body ? `<details><summary>Full note</summary>${render(String(x.body))}</details>` : ""}</div></details>`;
  }).join("")}`).join("");
}

const STATUS = { open: "open", active: "claimed", done: "resolved", dropped: "dropped" };

/** A task's page: header, the spec's gates, then Spec | Tickets | Records | Activity. @param {any} p @param {(md: string) => string} render */
function taskPageHtml(p, render) {
  const t = p.task;
  const gates = `<div class="gates">${p.gates.map((/** @type {any} */ g, /** @type {number} */ i) =>
    `<div class="gate ${g.done ? "done" : g.next ? "next" : ""}"><span>${g.done ? "✓" : i + 1}</span> ${esc(g.label)}${g.agent ? ' <span class="tag" title="An agent recorded this approval; only yours counts">agent-recorded</span>' : ""}${g.next ? ` <button class="btn small" data-gate="${esc(g.id)}" data-key="${esc(t.key)}">${g.agent ? "Confirm" : "Approve"}</button>` : ""}</div>`).join("")}</div>`;
  const tabs = `<div class="pills">${p.tabs.map((/** @type {string} */ x) => `<button data-tab="${esc(x)}" data-key="${esc(t.key)}" class="${x === p.tab ? "on" : ""}">${esc(x[0].toUpperCase() + x.slice(1))}${x === "tickets" ? ` · ${p.tickets.length}` : x === "records" ? ` · ${p.records.length}` : ""}</button>`).join("")}</div>`;
  let body = "";
  if (p.tab === "spec") body = readingHtml(p.spec, render);
  else if (p.tab === "tickets") {
    body = `<div class="rows">${p.tickets.map((/** @type {any} */ k) => `<div class="row" data-task="${esc(k.key)}"><span class="key">${esc(k.key)}</span><span><b>${esc(k.title)}</b><br><span class="ptr">${esc(/** @type {any} */ (STATUS)[k.status] ?? k.status)}${k.ticket_type ? ` · ${esc(k.ticket_type)}` : ""}${k.blocked_by ? ` · blocked by ${esc(JSON.parse(k.blocked_by).join(", "))}` : ""}</span></span></div>`).join("") || '<div class="empty">No tickets yet: /to-tickets makes them from the approved spec.</div>'}</div>`;
  } else if (p.tab === "records") {
    body = `<div class="rows">${p.records.map((/** @type {any} */ r) => `<div class="row rec"><span class="key">${esc(r.kind)}</span><span><b>${r.pointer ? "👉 " : ""}${esc(r.title)}</b>${r.status !== "open" ? ` <span class="tag">${esc(r.status)}</span>` : ""}${r.body ? `<details><summary>Body</summary>${render(String(r.body))}</details>` : ""}</span></div>`).join("") || '<div class="none">Nothing</div>'}</div>`;
  } else {
    body = `<div class="rows">${p.activity.map((/** @type {any} */ v) => `<div class="row rec"><span class="key">${esc(new Date(v.at).toISOString().slice(0, 16).replace("T", " "))}</span><span>${esc(v.op)} · ${esc(v.kind)} · ${esc(v.title)} <span class="ptr">${esc(v.actor_kind)}</span></span></div>`).join("") || '<div class="none">Nothing</div>'}</div>`;
  }
  return `<div class="crumb"><a href="#" data-go="tasks">Tasks</a> / ${esc(t.key)}</div><h1>${esc(t.title)}</h1>${t.summary ? `<p class="summary">${esc(t.summary)}</p>` : ""}${gates}${tabs}${body}`;
}

/**
 * The whole page.
 * @param {any} m appModel's result @param {{nonce: string, cspSource: string, render: (md: string) => string}} o
 */
function appHtml(m, o) {
  const nav = m.areas.map((/** @type {any} */ a) => `<button data-go="${esc(a.id)}" class="${a.id === m.area ? "on" : ""}" title="g ${esc(a.key)}">${esc(a.label)}</button>`).join("")
    + `<div class="more">More</div>` + m.more.map((/** @type {any} */ x) => `<button class="sub${x.id === m.area ? " on" : ""}" data-go="${esc(x.id)}">${esc(x.label)}</button>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${o.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Imprimatur</title><style>${CSS}</style></head><body>
<div class="top"><span class="repo">${esc(m.repo.name)}</span><button class="search" data-cmd="imprimatur.records.search">Search or ask… <kbd>/</kbd></button>${m.waiting ? `<button class="wait" data-go="home" title="Waiting on you">⏳ ${m.waiting}</button>` : ""}</div>
<div class="shell"><nav class="areas">${nav}</nav><main>${mainHtml(m, o.render)}</main></div>
<script nonce="${o.nonce}">${SCRIPT}</script></body></html>`;
}

module.exports = { appHtml, readingHtml, CSS };
