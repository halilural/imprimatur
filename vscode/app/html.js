// @ts-check
// The new Imprimatur panel's HTML (#195). Calm and keyboard first (Linear), VS Code's own theme
// colors only, so it reads in light and dark; one reading layout for every document: its sections
// on the left, the page in the middle with its summary first, "on this page" on the right.
"use strict";

const esc = (/** @type {unknown} */ s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: 14px; line-height: 1.6; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
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
main { padding: 22px 28px; min-width: 0; }
h1 { font-size: 24px; margin: 0 0 6px; }
.summary { font-size: 15px; color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
.reading { display: grid; grid-template-columns: 200px minmax(0, 1fr) 180px; gap: 26px; }
.reading .toc, .reading .onpage { position: sticky; top: 70px; align-self: start; font-size: 13px; max-height: calc(100vh - 90px); overflow: auto; }
.reading .toc a, .reading .onpage a { display: block; padding: 3px 6px; border-radius: 4px; color: var(--vscode-foreground); }
.reading .toc a:hover, .reading .onpage a:hover { background: var(--vscode-list-hoverBackground); text-decoration: none; }
.reading .toc .label, .reading .onpage .label { font-size: 12px; font-weight: 700; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
.page section { margin-bottom: 26px; }
.page h2 { font-size: 18px; margin: 0 0 8px; padding-top: 4px; }
.page .lead { font-weight: 600; }
.page details summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 13px; }
.page pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 6px; overflow: auto; }
.page code { font-family: var(--vscode-editor-font-family); }
.empty { padding: 24px; border: 1px dashed var(--vscode-panel-border); border-radius: 8px; color: var(--vscode-descriptionForeground); }
.pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.pills button { padding: 4px 12px; border-radius: 14px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); font: inherit; cursor: pointer; }
.pills button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.rows .row { display: flex; gap: 12px; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); margin-bottom: 8px; cursor: pointer; }
.rows .row:hover { background: var(--vscode-list-hoverBackground); }
.rows .key { font-weight: 700; min-width: 56px; }
.rows .ptr { color: var(--vscode-descriptionForeground); }
.btn { padding: 6px 14px; border-radius: 6px; border: 0; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-weight: 600; cursor: pointer; }
@media (max-width: 900px) { .reading { grid-template-columns: minmax(0, 1fr); } .reading .toc, .reading .onpage { display: none; } .shell { grid-template-columns: 1fr; } nav.areas { display: flex; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); } nav.areas button { width: auto; } }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const send = (m) => vscode.postMessage(m);
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-go],[data-cmd],[data-doc],[data-scope],[data-task]");
  if (!el) return;
  e.preventDefault();
  if (el.dataset.go) send({ type: "go", area: el.dataset.go });
  else if (el.dataset.doc) send({ type: "go", area: "docs", doc: el.dataset.doc });
  else if (el.dataset.scope) send({ type: "go", area: "docs", doc: "capabilities", scope: el.dataset.scope });
  else if (el.dataset.task) send({ type: "task", key: el.dataset.task });
  else if (el.dataset.cmd) send({ type: "cmd", command: el.dataset.cmd });
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
 * The reading layout: sections on the left, the page (summary first; a long section's rest folded,
 * one level only), "on this page" on the right.
 * @param {{title: string, summary?: string, sections: Array<{key: string, title: string, body: string}>}} r
 * @param {(md: string) => string} render Markdown to safe HTML
 * @param {string} [extra] HTML above the page (a capability's picker)
 */
function readingHtml(r, render, extra = "") {
  if (!r.sections.length) {
    return `<h1>${esc(r.title)}</h1>${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ""}${extra}<div class="empty">Nothing written here yet.</div>`;
  }
  const links = r.sections.map((s) => `<a href="#${esc(s.key)}">${esc(s.title)}</a>`).join("");
  const page = r.sections.map((s) => {
    const parts = String(s.body).replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
    // The first paragraph reads first; the rest of a long section is one click away.
    const head = parts.slice(0, 2).join("\n\n");
    const rest = parts.slice(2).join("\n\n");
    return `<section id="${esc(s.key)}"><h2>${esc(s.title)}</h2><div class="lead">${render(head)}</div>${rest ? `<details><summary>More</summary>${render(rest)}</details>` : ""}</section>`;
  }).join("");
  return `<h1>${esc(r.title)}</h1>${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ""}${extra}
  <div class="reading"><div class="toc"><div class="label">Sections</div>${links}</div><div class="page">${page}</div><div class="onpage"><div class="label">On this page</div>${links}</div></div>`;
}

/** The area's main content. @param {any} m @param {(md: string) => string} render */
function mainHtml(m, render) {
  if (m.area === "docs") {
    const pills = `<div class="pills">${m.docs.map((/** @type {any} */ d) => `<button data-doc="${esc(d.id)}" class="${d.id === m.doc ? "on" : ""}">${esc(d.label)}</button>`).join("")}</div>`;
    const scopes = m.reading.scopes?.length > 1 ? `<div class="pills">${m.reading.scopes.map((/** @type {string} */ s) => `<button data-scope="${esc(s)}" class="${s === m.reading.scope ? "on" : ""}">${esc(s)}</button>`).join("")}</div>` : "";
    return pills + readingHtml(m.reading, render, scopes);
  }
  if (m.area === "home") {
    const rows = m.tasks.map((/** @type {any} */ t) => `<div class="row" data-task="${esc(t.key)}"><span class="key">${esc(t.key)}</span><span><b>${esc(t.title)}</b>${t.pointer_title ? `<br><span class="ptr">👉 ${esc(t.pointer_title)}</span>` : ""}</span></div>`).join("");
    return `<h1>Where we left off</h1><p class="summary">The tasks in progress, each with where its work stopped.</p><div class="rows">${rows || '<div class="empty">No task in progress.</div>'}</div>`;
  }
  const old = { tasks: "imprimatur.openTasks", edits: "imprimatur.openGraph", setup: "imprimatur.setup.focus" }[/** @type {"tasks"} */ (m.area)];
  const label = m.areas.find((/** @type {any} */ a) => a.id === m.area)?.label;
  return `<h1>${esc(label)}</h1><p class="summary">This area moves into the new panel next (#190).</p><button class="btn" data-cmd="${esc(old)}">Open it in the old panel</button>`;
}

/**
 * The whole page.
 * @param {any} m appModel's result @param {{nonce: string, cspSource: string, render: (md: string) => string}} o
 */
function appHtml(m, o) {
  const nav = m.areas.map((/** @type {any} */ a) => `<button data-go="${esc(a.id)}" class="${a.id === m.area ? "on" : ""}" title="g ${esc(a.key)}">${esc(a.label)}<kbd>g ${esc(a.key)}</kbd></button>`).join("")
    + `<div class="more">More</div>` + m.more.map((/** @type {any} */ x) => `<button class="sub" data-cmd="${esc(x.command)}">${esc(x.label)}</button>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${o.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Imprimatur</title><style>${CSS}</style></head><body>
<div class="top"><span class="repo">${esc(m.repo.name)}</span><button class="search" data-cmd="imprimatur.records.search">Search or ask… <kbd>/</kbd></button>${m.waiting ? `<button class="wait" data-go="home" title="Waiting on you">⏳ ${m.waiting}</button>` : ""}</div>
<div class="shell"><nav class="areas">${nav}</nav><main>${mainHtml(m, o.render)}</main></div>
<script nonce="${o.nonce}">${SCRIPT}</script></body></html>`;
}

module.exports = { appHtml, readingHtml, CSS };
