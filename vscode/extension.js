// @ts-check
// Shows an agent's edits in the editor like tracked changes, against the copy
// the hook took in .claude/agent-review/baseline/. The agent's latest edit is
// bright, earlier ones dim. Git is not consulted: marks stay until accepted.
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { review, acceptHunk } = require("./diff.js");
const { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore } = require("./review-state.js");

const color = (id) => new vscode.ThemeColor(id);
const ruler = { overviewRulerLane: vscode.OverviewRulerLane.Left };
/** One set of decoration types per layer: bright = latest agent edit, dim = earlier ones. @param {boolean} dim */
const layer = (dim) => {
  const c = (bright, earlier) => color(dim ? earlier : bright);
  return {
    added: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: c("diffEditor.insertedLineBackground", "agentReview.earlierAddedBackground"),
      overviewRulerColor: color("editorOverviewRuler.addedForeground"),
      ...ruler,
    }),
    changed: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: c("agentReview.changedLineBackground", "agentReview.earlierChangedBackground"),
      overviewRulerColor: color("editorOverviewRuler.modifiedForeground"),
      ...ruler,
    }),
    insertedText: vscode.window.createTextEditorDecorationType({
      backgroundColor: c("diffEditor.insertedTextBackground", "agentReview.earlierInsertedTextBackground"),
    }),
    deletedText: vscode.window.createTextEditorDecorationType({
      before: { color: c("agentReview.deletedForeground", "agentReview.earlierDeletedForeground"), textDecoration: "line-through" },
    }),
    deletedBlock: vscode.window.createTextEditorDecorationType({
      after: { color: c("agentReview.deletedForeground", "agentReview.earlierDeletedForeground"), margin: "0 0 0 1em" },
      overviewRulerColor: color("editorOverviewRuler.deletedForeground"),
      ...ruler,
    }),
  };
};
const layers = { bright: layer(false), dim: layer(true) };

/** Git roots, normalized for comparison. @type {Set<string>} */
const roots = new Set();
/** @type {Map<string, ReturnType<typeof review>>} hunks by document path */
const hunksByFile = new Map();
let status = /** @type {vscode.StatusBarItem} */ (/** @type {unknown} */ (undefined));

const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

/** @param {string} file @returns {string | undefined} */
function copyPath(file) {
  const f = norm(file);
  for (const root of roots)
    if (f.startsWith(root + path.sep)) return path.join(root, BASELINE_DIR, f.slice(root.length + 1));
  return undefined;
}

/** @param {string} file */
function rootOf(file) {
  const f = norm(file);
  for (const root of roots) if (f.startsWith(root + path.sep)) return root;
  return undefined;
}

/** @param {vscode.TextDocument} doc */
function hunksFor(doc) {
  const file = doc.uri.fsPath;
  const copy = doc.uri.scheme === "file" ? copyPath(file) : undefined;
  const root = rootOf(file);
  if (!copy || !root || !fs.existsSync(copy)) return [];
  const log = path.join(root, HISTORY_DIR, `${path.relative(root, norm(file))}.jsonl`);
  return review(fs.readFileSync(copy, "utf8"), latestBefore(log), doc.getText());
}

// Spaces in injected text collapse; keep them visible.
const keepSpaces = (s) => s.replace(/ /g, " ");

/** @param {vscode.TextEditor} editor */
function render(editor) {
  const doc = editor.document;
  const hunks = hunksFor(doc);
  hunksByFile.set(doc.uri.fsPath, hunks);
  const last = doc.lineCount - 1;
  const lineAt = (n) => doc.lineAt(Math.min(Math.max(n, 0), last));
  const empty = () => ({ added: [], changed: [], insertedText: [], deletedText: [], deletedBlock: [] });
  /** @type {Record<"bright" | "dim", Record<string, vscode.DecorationOptions[]>>} */
  const outs = { bright: empty(), dim: empty() };
  for (const h of hunks)
    for (const m of h.marks) {
      const out = outs[m.fresh ? "bright" : "dim"];
      const tag = m.fresh ? " (latest edit)" : " (earlier edit)";
      if (m.kind === "added") out.added.push({ range: lineAt(m.line).range });
      else if (m.kind === "changed") {
        const line = lineAt(m.line);
        const hover = new vscode.MarkdownString().appendText(`Before${tag}: `).appendCodeblock(m.oldText);
        out.changed.push({ range: line.range, hoverMessage: hover });
        for (const [s, e] of m.inserted) out.insertedText.push({ range: new vscode.Range(line.lineNumber, s, line.lineNumber, e) });
        for (const d of m.deleted)
          out.deletedText.push({
            range: new vscode.Range(line.lineNumber, d.at, line.lineNumber, d.at),
            renderOptions: { before: { contentText: keepSpaces(d.text) } },
          });
      } else {
        const n = m.oldLines.length;
        const where = m.afterLine < 0 ? " above" : "";
        out.deletedBlock.push({
          range: lineAt(m.afterLine).range,
          hoverMessage: new vscode.MarkdownString().appendText(`Deleted${where}${tag}:`).appendCodeblock(m.oldLines.join("\n")),
          renderOptions: { after: { contentText: `⌫ ${n} line${n === 1 ? "" : "s"} deleted${where}` } },
        });
      }
    }
  for (const name of /** @type {const} */ (["bright", "dim"]))
    for (const [k, t] of Object.entries(layers[name])) editor.setDecorations(t, outs[name][k]);
  if (editor === vscode.window.activeTextEditor) updateStatus(hunks);
}

/** @param {ReturnType<typeof review>} hunks */
function updateStatus(hunks) {
  if (!hunks.length) return status.hide();
  const fresh = hunks.filter((h) => h.fresh).length;
  status.text = `$(diff) ${hunks.length} agent change${hunks.length === 1 ? "" : "s"} (${fresh} latest)`;
  status.tooltip = "Agent changes to review. Bright: the agent's latest edit. Dim: earlier edits. Accept to clear.";
  status.show();
}

function renderAll() {
  for (const e of vscode.window.visibleTextEditors) render(e);
  if (!vscode.window.activeTextEditor) status.hide();
}

/** @param {vscode.WorkspaceFolder} folder @param {vscode.ExtensionContext} ctx */
function addFolder(folder, ctx) {
  const found = repoRoot(folder.uri.fsPath) ?? folder.uri.fsPath;
  if (roots.has(norm(found))) return;
  roots.add(norm(found));
  // Copies and history change on every agent edit; re-render on any of them.
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(found), ".claude/agent-review/**"));
  ctx.subscriptions.push(w, w.onDidChange(renderAll), w.onDidCreate(renderAll), w.onDidDelete(renderAll));
}

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  ctx.subscriptions.push(status, ...Object.values(layers.bright), ...Object.values(layers.dim));
  for (const f of vscode.workspace.workspaceFolders ?? []) addFolder(f, ctx);

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(renderAll),
    vscode.window.onDidChangeActiveTextEditor((e) => (e ? updateStatus(hunksByFile.get(e.document.uri.fsPath) ?? []) : status.hide())),
    vscode.workspace.onDidSaveTextDocument(renderAll),
    vscode.workspace.onDidChangeTextDocument((ev) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const e of vscode.window.visibleTextEditors) if (e.document === ev.document) render(e);
      }, 150);
    }),
    vscode.commands.registerTextEditorCommand("agentReview.accept", (editor) => {
      const doc = editor.document;
      const copy = copyPath(doc.uri.fsPath);
      const line = editor.selection.active.line;
      // Fresh diff: the cached one can lag the debounced render by a keystroke.
      const hunk = hunksFor(doc).find((h) =>
        (line >= h.newStart && line < h.newEnd) || h.marks.some((m) => m.kind === "deleted" && Math.max(m.afterLine, 0) === line),
      );
      if (!copy || !hunk) return void vscode.window.showInformationMessage("No agent change at the cursor.");
      fs.writeFileSync(copy, acceptHunk(fs.readFileSync(copy, "utf8"), doc.getText(), hunk));
      render(editor);
    }),
    vscode.commands.registerTextEditorCommand("agentReview.acceptAll", (editor) => {
      const copy = copyPath(editor.document.uri.fsPath);
      if (copy && fs.existsSync(copy)) fs.rmSync(copy);
      render(editor);
    }),
  );
  renderAll();
}

module.exports = { activate, deactivate() {} };
