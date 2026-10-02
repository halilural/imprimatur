// @ts-check
// Shows an agent's edits in the editor like tracked changes, against the copy
// the hook took in .claude/agent-review/baseline/. The agent's latest edit is
// bright, earlier ones dim. Git is not consulted: marks stay until accepted.
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { review, acceptHunk } = require("./diff.js");
const { markdownItPlugin } = require("./preview.js");
const { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore, historyEdits } = require("./review-state.js");

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
let historyButton = /** @type {vscode.StatusBarItem} */ (/** @type {unknown} */ (undefined));

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

/** @param {string} file @param {string} text */
function hunksOf(file, text) {
  const copy = copyPath(file);
  const root = rootOf(file);
  if (!copy || !root || !fs.existsSync(copy)) return [];
  const log = path.join(root, HISTORY_DIR, `${path.relative(root, norm(file))}.jsonl`);
  return review(fs.readFileSync(copy, "utf8"), latestBefore(log), text);
}

/** @param {string} file */
function logOf(file) {
  const root = rootOf(file);
  return root && path.join(root, HISTORY_DIR, `${path.relative(root, norm(file))}.jsonl`);
}

/** Status bar button: shown whenever the active file has an agent history. */
function updateHistoryButton() {
  const doc = vscode.window.activeTextEditor?.document;
  const log = doc?.uri.scheme === "file" ? logOf(doc.uri.fsPath) : undefined;
  const edits = log ? historyEdits(log, doc.getText()).length : 0;
  if (!edits) return historyButton.hide();
  historyButton.text = `$(history) ${edits} agent edit${edits === 1 ? "" : "s"}`;
  historyButton.tooltip = "Show the agent's edits to this file, newest first";
  historyButton.show();
}

// Read-only documents for the diff view: agent-review:/<name>?<file, edit, side>
const SCHEME = "agent-review";
/** @param {string} file @param {number | "base"} n @param {"before" | "after" | "current"} side */
const historyUri = (file, n, side) =>
  vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(file)}`, query: JSON.stringify({ file, n, side }) });

/** @param {vscode.Uri} uri */
function historyContent(uri) {
  const { file, n, side } = JSON.parse(uri.query);
  if (n === "base") return fs.readFileSync(copyPath(file) ?? "", "utf8");
  const current = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText() ?? fs.readFileSync(file, "utf8");
  const edit = historyEdits(logOf(file) ?? "", current).find((e) => e.n === n);
  return edit ? edit[side === "before" ? "before" : "after"] : "";
}

async function showHistory() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== "file") return;
  const file = doc.uri.fsPath;
  const edits = historyEdits(logOf(file) ?? "", doc.getText());
  if (!edits.length) return void vscode.window.showInformationMessage("No agent edits recorded for this file.");
  const time = (t) => new Date(t).toLocaleString();
  /** @type {Array<vscode.QuickPickItem & {open: () => Thenable<unknown>}>} */
  const items = edits.map((e) => ({
    label: `$(git-commit) #${e.n}  ${time(e.t)}`,
    description: `${e.tool ?? "edit"} · +${e.added} −${e.removed}`,
    detail: e.session ? `session ${e.session.slice(0, 8)}` : undefined,
    open: () =>
      vscode.commands.executeCommand("vscode.diff", historyUri(file, e.n, "before"), historyUri(file, e.n, "after"),
        `${path.basename(file)} · agent edit #${e.n} (${time(e.t)})`),
  }));
  const copy = copyPath(file);
  if (copy && fs.existsSync(copy))
    items.unshift({
      label: "$(diff) All changes under review",
      description: "copy before the agent's first edit ↔ now",
      open: () => vscode.commands.executeCommand("vscode.diff", historyUri(file, "base", "before"), doc.uri, `${path.basename(file)} · all agent changes`),
    });
  const pick = await vscode.window.showQuickPick(items, { title: `Agent edits · ${path.basename(file)}`, matchOnDescription: true });
  await pick?.open();
}

/** @param {vscode.TextDocument} doc */
const hunksFor = (doc) => (doc.uri.scheme === "file" ? hunksOf(doc.uri.fsPath, doc.getText()) : []);

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
  const onChange = () => {
    renderAll();
    updateHistoryButton();
    vscode.commands.executeCommand("markdown.preview.refresh").then(undefined, () => {});
  };
  ctx.subscriptions.push(w, w.onDidChange(onChange), w.onDidCreate(onChange), w.onDidDelete(onChange));
}

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  historyButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  historyButton.command = "agentReview.showHistory";
  ctx.subscriptions.push(
    status,
    historyButton,
    ...Object.values(layers.bright),
    ...Object.values(layers.dim),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: historyContent }),
    vscode.commands.registerCommand("agentReview.showHistory", showHistory),
  );
  for (const f of vscode.workspace.workspaceFolders ?? []) addFolder(f, ctx);

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(renderAll),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) updateStatus(hunksByFile.get(e.document.uri.fsPath) ?? []);
      else status.hide();
      updateHistoryButton();
    }),
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
      render(editor); // the copy watcher refreshes the preview
    }),
    vscode.commands.registerTextEditorCommand("agentReview.acceptAll", (editor) => {
      const copy = copyPath(editor.document.uri.fsPath);
      if (copy && fs.existsSync(copy)) fs.rmSync(copy);
      render(editor);
    }),
  );
  renderAll();
  updateHistoryButton();
  // Markdown preview: the built-in markdown extension calls this with its markdown-it.
  return {
    extendMarkdownIt: (md) =>
      markdownItPlugin(md, (env) => {
        /** @type {vscode.Uri | undefined} */
        const uri = env?.currentDocument;
        if (uri?.scheme !== "file") return [];
        // The preview renders the open document, unsaved edits included.
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        return hunksOf(uri.fsPath, doc ? doc.getText() : fs.readFileSync(uri.fsPath, "utf8"));
      }),
  };
}

module.exports = { activate, deactivate() {} };
