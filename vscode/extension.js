// @ts-check
// Shows an agent's edits in the editor like tracked changes, against the copy
// the hook took in .claude/review-baseline/. The copy is dropped once git has
// no unstaged changes for the file (the user staged or committed it).
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { diff, acceptHunk } = require("./diff.js");
const { BASELINE_DIR, git, repoRoot, reviewState } = require("./review-state.js");

// A copy younger than this is never cleaned: the hook writes it just before
// the agent's edit lands, when the file still looks clean to git.
const FRESH_MS = 5000;

/** Copies of fully staged files: kept so unstaging brings the marks back, but not shown. @type {Set<string>} */
const staged = new Set();

const color = (id) => new vscode.ThemeColor(id);
const types = {
  added: vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: color("diffEditor.insertedLineBackground"),
    overviewRulerColor: color("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  }),
  changed: vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: color("agentReview.changedLineBackground"),
    overviewRulerColor: color("editorOverviewRuler.modifiedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  }),
  insertedText: vscode.window.createTextEditorDecorationType({
    backgroundColor: color("diffEditor.insertedTextBackground"),
  }),
  deletedText: vscode.window.createTextEditorDecorationType({
    before: { color: color("agentReview.deletedForeground"), textDecoration: "line-through" },
  }),
  deletedBlock: vscode.window.createTextEditorDecorationType({
    after: { color: color("agentReview.deletedForeground"), margin: "0 0 0 1em" },
    overviewRulerColor: color("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  }),
};

/** Git roots, normalized for comparison. @type {Set<string>} */
const roots = new Set();
/** @type {Map<string, import("./diff.js").Hunk[]>} hunks by document path */
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

/** @param {vscode.TextDocument} doc */
function hunksFor(doc) {
  const copy = doc.uri.scheme === "file" ? copyPath(doc.uri.fsPath) : undefined;
  return copy && !staged.has(copy) && fs.existsSync(copy) ? diff(fs.readFileSync(copy, "utf8"), doc.getText()) : [];
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
  /** @type {Record<string, vscode.DecorationOptions[]>} */
  const out = { added: [], changed: [], insertedText: [], deletedText: [], deletedBlock: [] };
  for (const h of hunks)
    for (const m of h.marks) {
      if (m.kind === "added") out.added.push({ range: lineAt(m.line).range });
      else if (m.kind === "changed") {
        const line = lineAt(m.line);
        const hover = new vscode.MarkdownString().appendText("Before: ").appendCodeblock(m.oldText);
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
          hoverMessage: new vscode.MarkdownString().appendText(`Deleted${where}:`).appendCodeblock(m.oldLines.join("\n")),
          renderOptions: { after: { contentText: `⌫ ${n} line${n === 1 ? "" : "s"} deleted${where}` } },
        });
      }
    }
  for (const [k, t] of Object.entries(types)) editor.setDecorations(t, out[k]);
  if (editor === vscode.window.activeTextEditor) updateStatus(hunks);
}

/** @param {import("./diff.js").Hunk[]} hunks */
function updateStatus(hunks) {
  if (!hunks.length) return status.hide();
  status.text = `$(diff) ${hunks.length} agent change${hunks.length === 1 ? "" : "s"}`;
  status.tooltip = "Unreviewed agent changes in this file. Stage the file to accept them.";
  status.show();
}

function renderAll() {
  for (const e of vscode.window.visibleTextEditors) render(e);
  if (!vscode.window.activeTextEditor) status.hide();
}

/** Sort one copy by git state: shown, hidden while staged, or deleted once committed. @param {string} root @param {string} copy */
function sync(root, copy) {
  const state = reviewState(root, path.relative(path.join(root, BASELINE_DIR), copy));
  if (state === "staged") staged.add(copy);
  else staged.delete(copy);
  if (state === "clean" && Date.now() - fs.statSync(copy).mtimeMs >= FRESH_MS) fs.rmSync(copy);
}

/** @param {string} root */
function cleanup(root) {
  const dir = path.join(root, BASELINE_DIR);
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile()) continue;
    sync(root, path.join(ent.parentPath, ent.name));
  }
}

/** @param {vscode.WorkspaceFolder} folder @param {vscode.ExtensionContext} ctx */
function addFolder(folder, ctx) {
  const found = repoRoot(folder.uri.fsPath);
  if (!found || roots.has(norm(found))) return;
  const index = git(found, ["rev-parse", "--path-format=absolute", "--git-path", "index"])?.trim();
  if (!index) return;
  roots.add(norm(found));
  // Non-recursive pattern: files.watcherExclude (which covers .git) does not apply.
  const iw = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(index)), path.basename(index)),
  );
  const onIndex = () => { cleanup(found); renderAll(); };
  const bw = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(found), ".claude/review-baseline/**"),
  );
  ctx.subscriptions.push(iw, bw, iw.onDidChange(onIndex), iw.onDidCreate(onIndex), bw.onDidChange(renderAll), bw.onDidCreate(renderAll), bw.onDidDelete(renderAll));
  cleanup(found);
}

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  ctx.subscriptions.push(status, ...Object.values(types));
  for (const f of vscode.workspace.workspaceFolders ?? []) addFolder(f, ctx);

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(renderAll),
    vscode.window.onDidChangeActiveTextEditor((e) => (e ? updateStatus(hunksByFile.get(e.document.uri.fsPath) ?? []) : status.hide())),
    // Saving can turn a staged file back into one with unstaged changes.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const copy = copyPath(doc.uri.fsPath);
      if (!copy || !fs.existsSync(copy)) return;
      for (const root of roots) if (copy.startsWith(path.join(root, BASELINE_DIR))) sync(root, copy);
      renderAll();
    }),
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
