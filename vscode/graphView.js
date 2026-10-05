// @ts-check
// The Agent Change Graph panel (a webview): rows from graph.js, one colored
// lane per Claude session, click a row to open that edit's diff.
"use strict";
const vscode = require("vscode");
const path = require("node:path");
const crypto = require("node:crypto");
const { graphRows } = require("./graph.js");

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

/** @param {ReturnType<typeof graphRows>} data @param {string} root @param {string} nonce */
function html(data, root, nonce) {
  const time = (t) => new Date(t).toLocaleString();
  const body = data.rows.length
    ? data.rows
        .map(
          (r, i) => `<tr data-file="${esc(r.file)}" data-n="${r.n}" data-i="${i}" data-prompt="${esc(r.prompt ?? "")}"${r.preview ? "" : ` title="${esc(r.prompt ?? "")}"`}>
  <td class="ok" title="${r.accepted ? "Accepted" : "Under review"}">${r.accepted ? "✓" : ""}</td>
  <td class="g">${laneSvg(i, r, data.lanes)}</td>
  <td class="d">${esc(r.prompt ?? `${r.tool ?? "Edit"} ${path.basename(r.file)}`)}</td>
  <td class="f">${esc(r.file)} <span class="n">#${r.n}</span></td>
  <td class="t">${esc(time(r.t))}</td>
  <td class="s" style="color:${COLORS[r.lane % COLORS.length]}">${esc((r.session ?? "?").slice(0, 8))}</td>
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
  #pop { display: none; position: fixed; z-index: 10; max-width: 70vw; max-height: 60vh; overflow: hidden; padding: 6px 0;
    background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border); box-shadow: 0 2px 8px var(--vscode-widget-shadow);
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  #pop div { white-space: pre; padding: 0 8px; } #pop .p { font-family: var(--vscode-font-family); opacity: .8; padding-bottom: 4px; }
  #pop .m { background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,.2)); }
  #pop .a { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,255,0,.15)); color: inherit; }
</style></head><body>
<header><strong>Agent Change Graph</strong><input id="filter" placeholder="Filter by file or request"><span class="n">${data.rows.length} edits · ${data.lanes.length} sessions</span></header>
<table><thead><tr><th title="Accepted">✓</th><th>Graph</th><th>Description</th><th>File</th><th>Date</th><th>Session</th><th>Changes</th></tr></thead>
<tbody>${body}</tbody></table>
<div id="pop"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rows = ${JSON.stringify(data.rows.map((r) => (r.preview ? { prompt: r.prompt, preview: r.preview } : null))).replace(/</g, "\\u003c")};
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
  document.getElementById("filter").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll("tr[data-file]").forEach((tr) => {
      tr.style.display = (tr.dataset.file + " " + tr.dataset.prompt).toLowerCase().includes(q) ? "" : "none";
    });
  });
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
    p.webview.html = html(graphRows(root, currentText), root, crypto.randomBytes(16).toString("hex"));
  };
  refresh();
  p.reveal();
}

/** Re-render the open panel, if any (after an agent edit). */
const refreshGraph = () => refresh?.();

module.exports = { openGraph, refreshGraph, laneSvg };
