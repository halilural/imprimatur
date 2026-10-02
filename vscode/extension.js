// @ts-check
// Shows an agent's edits in the editor like tracked changes, against the copy
// the hook took in .claude/review-baseline/. Changes not staged yet are bright,
// staged ones dim; the copy is dropped once the file is committed.
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { review, acceptHunk } = require("./diff.js");
const { BASELINE_DIR, git, repoRoot, reviewState, indexText } = require("./review-state.js");

// A copy younger than this is never cleaned: the hook writes it just before
// the agent's edit lands, when the file still looks clean to git.
const FRESH_MS = 5000;

const color = (id) => new vscode.ThemeColor(id);
const ruler = { overviewRulerLane: vscode.OverviewRulerLane.Left };
/** One set of decoration types per layer: bright = not staged yet, dim = staged. @param {boolean} dim */
const layer = (dim) => {
  const c = (bright, staged) => color(dim ? staged : bright);
  return {
    added: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: c("diffEditor.insertedLineBackground", "agentReview.stagedAddedBackground"),
      overviewRulerColor: color("editorOverviewRuler.addedForeground"),
      ...ruler,
    }),
    changed: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: c("agentReview.changedLineBackground", "agentReview.stagedChangedBackground"),
      overviewRulerColor: color("editorOverviewRuler.modifiedForeground"),
      ...ruler,
    }),
    insertedText: vscode.window.createTextEditorDecorationType({
      backgroundColor: c("diffEditor.insertedTextBackground", "agentReview.stagedInsertedTextBackground"),
    }),
    deletedText: vscode.window.createTextEditorDecorationType({
      before: { color: c("agentReview.deletedForeground", "agentReview.stagedDeletedForeground"), textDecoration: "line-through" },
    }),
    deletedBlock: vscode.window.createTextEditorDecorationType({
      after: { color: c("agentReview.deletedForeground", "agentReview.stagedDeletedForeground"), margin: "0 0 0 1em" },
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
/** Staged text by file path; cleared when the index changes. @type {Map<string, string | undefined>} */
const indexCache = new Map();
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
  if (!indexCache.has(file)) indexCache.set(file, indexText(root, path.relative(root, norm(file))));
  return review(fs.readFileSync(copy, "utf8"), indexCache.get(file), doc.getText());
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
      const tag = m.fresh ? "" : " (staged)";
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
  status.text = `$(diff) ${hunks.length} agent change${hunks.length === 1 ? "" : "s"} (${fresh} new)`;
  status.tooltip = "Agent changes since the last commit. Bright: not staged yet. Dim: staged. Commit to clear.";
  status.show();
}

function renderAll() {
  for (const e of vscode.window.visibleTextEditors) render(e);
  if (!vscode.window.activeTextEditor) status.hide();
}

/** Delete the copy once its file is committed. @param {string} root @param {string} copy */
function sync(root, copy) {
  if (Date.now() - fs.statSync(copy).mtimeMs < FRESH_MS) return;
  if (reviewState(root, path.relative(path.join(root, BASELINE_DIR), copy)) === "clean") fs.rmSync(copy);
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
  const onIndex = () => { indexCache.clear(); cleanup(found); renderAll(); };
  const bw = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(found), ".claude/review-baseline/**"),
  );
  ctx.subscriptions.push(iw, bw, iw.onDidChange(onIndex), iw.onDidCreate(onIndex), bw.onDidChange(renderAll), bw.onDidCreate(renderAll), bw.onDidDelete(renderAll));
  cleanup(found);
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
