// @ts-check
// Shows an agent's edits in the editor like tracked changes, against the copy
// the hook took in .claude/agent-review/baseline/. The agent's latest edit is
// bright, earlier ones dim. Git is not consulted: marks stay until accepted.
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { review, acceptHunk, acceptLines } = require("./diff.js");
const { markdownItPlugin } = require("./preview.js");
const { openGraph, refreshGraph } = require("./graphView.js");
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
    // Old text stays readable: plain text in a red box, no strike line.
    deletedText: vscode.window.createTextEditorDecorationType({
      before: {
        color: c("agentReview.oldTextForeground", "agentReview.earlierOldTextForeground"),
        backgroundColor: color("agentReview.oldTextBackground"),
        border: "1px solid rgba(248, 81, 73, 0.6)",
      },
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

/** Hunks of an open or on-disk file. @param {string} file */
const hunksOfFile = (file) => hunksOf(file, currentText(file) ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""));

/** Accept the agent's changes on new-text lines [start, end) of a file: write just those into the copy. */
function acceptRange(file, start, end) {
  const copy = copyPath(file);
  if (!copy || !fs.existsSync(copy)) return;
  const text = currentText(file) ?? fs.readFileSync(file, "utf8");
  // Only these lines: a hunk can span several blocks (an added item's EN and TR paragraphs).
  fs.writeFileSync(copy, acceptLines(fs.readFileSync(copy, "utf8"), text, start, end));
  // Move on to the next change in the editor, like a review queue.
  const next = hunksOfFile(file).find((h) => h.newStart >= start) ?? hunksOfFile(file)[0];
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file);
  if (next && editor) {
    const line = Math.min(next.newStart, editor.document.lineCount - 1);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
  renderAll();
  codeLensChanged.fire();
  refreshPreview();
}

const codeLensChanged = new vscode.EventEmitter();

/** "✓ Accept" above each change block in the editor. */
const codeLenses = {
  onDidChangeCodeLenses: codeLensChanged.event,
  /** @param {vscode.TextDocument} doc */
  provideCodeLenses(doc) {
    // CodeLens belongs to the document, not the editor: hide while it is in a diff tab.
    if (doc.uri.scheme !== "file" || diffTabUris().has(doc.uri.toString()) || !marksInEditor(doc)) return [];
    return hunksFor(doc).map((h) => {
      const start = Math.min(h.newStart < h.newEnd ? h.newStart : Math.max(h.marks[0].afterLine ?? 0, 0), doc.lineCount - 1);
      const end = Math.max(h.newEnd, start + 1);
      return new vscode.CodeLens(new vscode.Range(start, 0, start, 0), {
        title: `$(check) Accept${h.fresh ? "" : " (earlier edit)"}`,
        command: "agentReview.acceptRange",
        arguments: [doc.uri.fsPath, start, end],
      });
    });
  },
};

/** @param {string} file @param {number} n */
function openEditDiff(file, n) {
  const e = historyEdits(logOf(file) ?? "", currentText(file) ?? "").find((x) => x.n === n);
  const time = e ? new Date(e.t).toLocaleString() : "";
  return vscode.commands.executeCommand("vscode.diff", historyUri(file, n, "before"), historyUri(file, n, "after"),
    `${path.basename(file)} · agent edit #${n} (${time})`);
}

/** Open-editor text (unsaved edits included), else undefined. @param {string} file */
const currentText = (file) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText();

function showGraph() {
  const active = vscode.window.activeTextEditor?.document.uri;
  const root = (active?.scheme === "file" && rootOf(active.fsPath)) || [...roots][0];
  if (!root) return void vscode.window.showInformationMessage("Agent Change Graph: no folder open.");
  openGraph(root, openEditDiff, currentText);
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
    detail: [e.prompt, e.session && `session ${e.session.slice(0, 8)}`].filter(Boolean).join(" · ") || undefined,
    open: () => openEditDiff(file, e.n),
  }));
  const copy = copyPath(file);
  if (copy && fs.existsSync(copy))
    items.unshift({
      label: "$(diff) All changes under review",
      description: "copy before the agent's first edit ↔ now",
      open: () => vscode.commands.executeCommand("vscode.diff", historyUri(file, "base", "before"), doc.uri, `${path.basename(file)} · all agent changes`),
    });
  items.unshift({ label: "$(git-merge) Open Agent Change Graph", description: "every agent edit in this repo", open: async () => showGraph() });
  const pick = await vscode.window.showQuickPick(items, { title: `Agent edits · ${path.basename(file)}`, matchOnDescription: true });
  await pick?.open();
}

/** @param {vscode.TextDocument} doc */
const hunksFor = (doc) => (doc.uri.scheme === "file" ? hunksOf(doc.uri.fsPath, doc.getText()) : []);

// Spaces in injected text collapse; keep them visible.
const keepSpaces = (s) => s.replace(/ /g, " ");

/** URIs shown right now in an active diff tab (Working Tree, git compare): git already colors those. */
function diffTabUris() {
  const out = new Set();
  for (const g of vscode.window.tabGroups.all) {
    const input = g.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) {
      out.add(input.modified.toString());
      out.add(input.original.toString());
    }
  }
  return out;
}

/**
 * Is this editor one side of a diff tab? A diff side's viewColumn can be
 * undefined, so match by URI; an editor in a group whose active tab is a plain
 * text tab is not a diff side even if the same file is also in a diff elsewhere.
 * @param {vscode.TextEditor} editor
 */
function inDiffTab(editor) {
  if (!diffTabUris().has(editor.document.uri.toString())) return false;
  const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn);
  return !(group?.activeTab?.input instanceof vscode.TabInputText);
}

/** Markdown is reviewed in the preview unless agentReview.showIn says otherwise. @param {vscode.TextDocument} doc */
function marksInEditor(doc) {
  const isMarkdown = doc.languageId === "markdown" || /\.mdx?$/i.test(doc.uri.fsPath);
  if (!isMarkdown) return true; // no preview for other files
  return vscode.workspace.getConfiguration("agentReview", doc.uri).get("showIn", "preview") !== "preview";
}

/** @param {vscode.TextEditor} editor */
function render(editor) {
  const doc = editor.document;
  const all = inDiffTab(editor) ? [] : hunksFor(doc);
  const hunks = marksInEditor(doc) ? all : [];
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
  if (editor === vscode.window.activeTextEditor) updateStatus(all);
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

/** @type {NodeJS.Timeout | undefined} */
let previewTimer;
/**
 * A preview refresh reloads the whole page (and restarts other preview scripts,
 * e.g. Mermaid renderers), so do it once, after things settle.
 */
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => vscode.commands.executeCommand("markdown.preview.refresh").then(undefined, () => {}), 700);
}

function refreshEverything() {
  renderAll();
  updateHistoryButton();
  refreshGraph();
  codeLensChanged.fire();
}

/** @type {NodeJS.Timeout[]} */
let refreshTimers = [];
/**
 * The hook writes the copy and history just BEFORE the agent's edit lands on
 * disk, so redraw the editor now and again shortly after, when the edit is
 * there; the preview once, when it is quiet.
 */
function refreshSoon() {
  refreshTimers.forEach(clearTimeout);
  refreshEverything();
  refreshTimers = [500, 2000].map((ms) => setTimeout(refreshEverything, ms));
  refreshPreview();
}

/** @param {vscode.WorkspaceFolder} folder @param {vscode.ExtensionContext} ctx */
function addFolder(folder, ctx) {
  const found = repoRoot(folder.uri.fsPath) ?? folder.uri.fsPath;
  if (roots.has(norm(found))) return;
  roots.add(norm(found));
  // Copies and history change on every agent edit; re-render on any of them.
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(found), ".claude/agent-review/**"));
  ctx.subscriptions.push(w, w.onDidChange(refreshSoon), w.onDidCreate(refreshSoon), w.onDidDelete(refreshSoon));
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
    vscode.commands.registerCommand("agentReview.openGraph", showGraph),
    vscode.commands.registerCommand("agentReview.acceptRange", acceptRange),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLenses),
    // Accept buttons in the Markdown preview: vscode://<this extension>/accept?file&start&end
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path !== "/accept") return;
        const q = new URLSearchParams(uri.query);
        const file = q.get("file");
        if (file) acceptRange(file, Number(q.get("start")), Number(q.get("end")));
      },
    }),
  );
  for (const f of vscode.workspace.workspaceFolders ?? []) addFolder(f, ctx);

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(renderAll),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentReview")) {
        refreshEverything();
        refreshPreview();
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      renderAll();
      codeLensChanged.fire();
    }),
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
        // A file under review changed (the agent's edit landed): preview, lenses, button too.
        const copy = ev.document.uri.scheme === "file" ? copyPath(ev.document.uri.fsPath) : undefined;
        // The preview re-renders a changed document by itself; no extra refresh here.
        if (copy && fs.existsSync(copy)) {
          codeLensChanged.fire();
          updateHistoryButton();
          refreshGraph();
        }
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
    codeLensChanged,
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
      markdownItPlugin(
        md,
        (env) => {
        /** @type {vscode.Uri | undefined} */
        const uri = env?.currentDocument;
        if (uri?.scheme !== "file") return [];
        if (vscode.workspace.getConfiguration("agentReview", uri).get("showIn", "preview") === "editor") return [];
        // The preview renders the open document, unsaved edits included.
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        return hunksOf(uri.fsPath, doc ? doc.getText() : fs.readFileSync(uri.fsPath, "utf8"));
        },
        (env, start, end) => {
          /** @type {vscode.Uri | undefined} */
          const uri = env?.currentDocument;
          if (uri?.scheme !== "file") return undefined;
          const q = new URLSearchParams({ file: uri.fsPath, start: String(start), end: String(end) });
          return `${vscode.env.uriScheme}://${ctx.extension.id}/accept?${q}`;
        },
      ),
  };
}

module.exports = { activate, deactivate() {} };
