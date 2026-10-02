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
          (r, i) => `<tr data-file="${esc(r.file)}" data-n="${r.n}" title="${esc(r.prompt ?? "")}">
  <td class="g">${laneSvg(i, r, data.lanes)}</td>
  <td class="d">${esc(r.prompt ?? `${r.tool ?? "Edit"} ${path.basename(r.file)}`)}</td>
  <td class="f">${esc(r.file)} <span class="n">#${r.n}</span></td>
  <td class="t">${esc(time(r.t))}</td>
  <td class="s" style="color:${COLORS[r.lane % COLORS.length]}">${esc((r.session ?? "?").slice(0, 8))}</td>
  <td class="c"><span class="a">+${r.added}</span> <span class="r">−${r.removed}</span></td>
</tr>`,
        )
        .join("\n")
    : `<tr><td colspan="6" class="empty">No agent edits recorded in ${esc(root)} yet.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px; }
  header { display: flex; gap: 12px; align-items: center; padding: 10px 0; }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 280px; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  td { padding: 0 8px; height: ${ROW}px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 520px; }
  td.g { padding: 0; width: 1px; } td.g svg { display: block; }
  tr[data-file] { cursor: pointer; } tr[data-file]:hover { background: var(--vscode-list-hoverBackground); }
  .n, .t { opacity: .75; } .a { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); } .r { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .empty { opacity: .7; padding: 12px; }
</style></head><body>
<header><strong>Agent Change Graph</strong><input id="filter" placeholder="Filter by file or request"><span class="n">${data.rows.length} edits · ${data.lanes.length} sessions</span></header>
<table><thead><tr><th>Graph</th><th>Description</th><th>File</th><th>Date</th><th>Session</th><th>Changes</th></tr></thead>
<tbody>${body}</tbody></table>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("tr[data-file]").forEach((tr) =>
    tr.addEventListener("click", () => vscode.postMessage({ file: tr.dataset.file, n: Number(tr.dataset.n) })));
  document.getElementById("filter").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll("tr[data-file]").forEach((tr) => {
      tr.style.display = (tr.dataset.file + " " + tr.title).toLowerCase().includes(q) ? "" : "none";
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
    panel = vscode.window.createWebviewPanel("agentReview.graph", "Agent Change Graph", vscode.ViewColumn.Active, { enableScripts: true });
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
