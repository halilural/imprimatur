// @ts-check
// Shows an agent's edits in the editor like tracked changes, against the copy
// the hook took in .claude/review-baseline/. The copy is dropped once git has
// no unstaged changes for the file (the user staged or committed it).
"use strict";
const vscode = require("vscode");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { diff, acceptHunk } = require("./diff.js");

const BASELINE_DIR = path.join(".claude", "review-baseline");

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  try {
    return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

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

/** @type {Map<string, {root: string, index: string}>} repo root by workspace folder path */
const repos = new Map();
/** @type {Map<string, import("./diff.js").Hunk[]>} hunks by document path */
const hunksByFile = new Map();
let status = /** @type {vscode.StatusBarItem} */ (/** @type {unknown} */ (undefined));

/** @param {string} file */
function repoOf(file) {
  for (const r of repos.values()) if (file.startsWith(r.root + path.sep)) return r;
  return undefined;
}

/** @param {string} file */
function copyPath(file) {
  const r = repoOf(file);
  return r && path.join(r.root, BASELINE_DIR, path.relative(r.root, file));
}

// Spaces in injected text collapse; keep them visible.
const keepSpaces = (s) => s.replace(/ /g, " ");

/** @param {vscode.TextEditor} editor */
function render(editor) {
  const doc = editor.document;
  const copy = doc.uri.scheme === "file" ? copyPath(doc.uri.fsPath) : undefined;
  const hunks = copy && fs.existsSync(copy) ? diff(fs.readFileSync(copy, "utf8"), doc.getText()) : [];
  hunksByFile.set(doc.uri.fsPath, hunks);
  /** @type {Record<string, vscode.DecorationOptions[]>} */
  const out = { added: [], changed: [], insertedText: [], deletedText: [], deletedBlock: [] };
  for (const h of hunks)
    for (const m of h.marks) {
      if (m.kind === "added") out.added.push({ range: doc.lineAt(m.line).range });
      else if (m.kind === "changed") {
        const line = doc.lineAt(m.line);
        const hover = new vscode.MarkdownString().appendText("Before: ").appendCodeblock(m.oldText);
        out.changed.push({ range: line.range, hoverMessage: hover });
        for (const [s, e] of m.inserted) out.insertedText.push({ range: new vscode.Range(m.line, s, m.line, e) });
        for (const d of m.deleted)
          out.deletedText.push({
            range: new vscode.Range(m.line, d.at, m.line, d.at),
            renderOptions: { before: { contentText: keepSpaces(d.text) } },
          });
      } else {
        const lineNo = Math.max(m.afterLine, 0);
        const n = m.oldLines.length;
        const where = m.afterLine < 0 ? " above" : "";
        out.deletedBlock.push({
          range: doc.lineAt(lineNo).range,
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

// Drop copies of files git sees no unstaged changes for.
/** @param {{root: string}} r */
function cleanup(r) {
  const dir = path.join(r.root, BASELINE_DIR);
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile()) continue;
    const copy = path.join(ent.parentPath, ent.name);
    const rel = path.relative(dir, copy);
    const st = git(r.root, ["status", "--porcelain=v1", "--", rel]);
    if (st === undefined) continue;
    if (st === "" || st[1] === " ") fs.rmSync(copy);
  }
}

/** @param {vscode.WorkspaceFolder} folder @param {vscode.ExtensionContext} ctx */
function addFolder(folder, ctx) {
  const cwd = folder.uri.fsPath;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const index = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (!root || !index) return;
  const r = { root, index };
  repos.set(cwd, r);
  // Non-recursive pattern: files.watcherExclude (which covers .git) does not apply.
  const iw = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(index)), path.basename(index)),
  );
  const onIndex = () => { cleanup(r); renderAll(); };
  const bw = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(root), `${BASELINE_DIR.split(path.sep).join("/")}/**`),
  );
  ctx.subscriptions.push(iw, bw, iw.onDidChange(onIndex), iw.onDidCreate(onIndex), bw.onDidChange(renderAll), bw.onDidCreate(renderAll), bw.onDidDelete(renderAll));
  cleanup(r);
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
    vscode.workspace.onDidChangeTextDocument((ev) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const e of vscode.window.visibleTextEditors) if (e.document === ev.document) render(e);
      }, 150);
    }),
    vscode.commands.registerTextEditorCommand("agentReview.accept", (editor) => {
      const file = editor.document.uri.fsPath;
      const copy = copyPath(file);
      const line = editor.selection.active.line;
      const hunk = (hunksByFile.get(file) ?? []).find((h) =>
        (line >= h.newStart && line < h.newEnd) || h.marks.some((m) => m.kind === "deleted" && Math.max(m.afterLine, 0) === line),
      );
      if (!copy || !hunk) return void vscode.window.showInformationMessage("No agent change at the cursor.");
      fs.writeFileSync(copy, acceptHunk(fs.readFileSync(copy, "utf8"), editor.document.getText(), hunk));
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
