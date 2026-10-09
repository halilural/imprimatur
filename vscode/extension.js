// @ts-check
// Shows an agent's edits in the editor like tracked changes, against the copy
// the hook took in .claude/imprimatur/baseline/. Every change looks the same,
// whichever agent edit made it. Git is not consulted: marks stay until accepted.
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { review, acceptHunk, acceptLines, acceptGroups } = require("./diff.js");
const { markdownItPlugin, markdownBlocks, reviewHtml } = require("./preview.js");
const { openGraph, refreshGraph, syncRecords, graphCommands, graphTrusted, setGraphLog } = require("./graphView.js");
const { WAITING_DIR, waitingSteps } = require("./waiting.js");
const { acceptEdit, spotsOf, graphRows } = require("./graph.js");
const { registerSetupView } = require("./setupView.js");
const { registerRecordViews } = require("./recordsView.js");
const records = require("./records.js");
const { readConfig, syncOnce, syncLoop, describe } = require("./sync.js");

/** @type {ReturnType<typeof registerSetupView> | undefined} */
let setupView;
const { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore, historyEdits } = require("./review-state.js");
const { toolCallIn, linkIn } = require("./calls.js");
const { archiveRepo, archiveDue } = require("./archive.js");

const color = (id) => new vscode.ThemeColor(id);
const ruler = { overviewRulerLane: vscode.OverviewRulerLane.Left };
/** Decoration types for agent changes. */
const makeTypes = () => {
  const c = (id) => color(id);
  return {
    added: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: c("diffEditor.insertedLineBackground"),
      overviewRulerColor: color("editorOverviewRuler.addedForeground"),
      ...ruler,
    }),
    changed: vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: c("imprimatur.changedLineBackground"),
      overviewRulerColor: color("editorOverviewRuler.modifiedForeground"),
      ...ruler,
    }),
    insertedText: vscode.window.createTextEditorDecorationType({
      backgroundColor: c("diffEditor.insertedTextBackground"),
    }),
    // Old text stays readable: plain text in a red box, no strike line.
    deletedText: vscode.window.createTextEditorDecorationType({
      before: {
        color: c("imprimatur.oldTextForeground"),
        backgroundColor: color("imprimatur.oldTextBackground"),
        border: "1px solid rgba(248, 81, 73, 0.6)",
      },
    }),
    deletedBlock: vscode.window.createTextEditorDecorationType({
      after: { color: c("imprimatur.deletedForeground"), margin: "0 0 0 1em" },
      overviewRulerColor: color("editorOverviewRuler.deletedForeground"),
      ...ruler,
    }),
  };
};
const types = makeTypes();

/** Git roots, normalized for comparison. @type {Set<string>} */
const roots = new Set();
/** @type {Map<string, ReturnType<typeof review>>} hunks by document path */
const hunksByFile = new Map();
let status = /** @type {vscode.StatusBarItem} */ (/** @type {unknown} */ (undefined));
/** The preview's markdown-it, also used to find Markdown blocks for Accept units. */
let markdownIt;
/** "Imprimatur" output channel: what Accept links did, for troubleshooting. */
let log = /** @type {vscode.LogOutputChannel} */ (/** @type {unknown} */ (undefined));
let graphButton = /** @type {vscode.StatusBarItem} */ (/** @type {unknown} */ (undefined));

const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

/** @param {string} file @returns {string | undefined} */
function copyPath(file) {
  const root = rootOf(file);
  return root && path.join(root, BASELINE_DIR, norm(file).slice(root.length + 1));
}

/**
 * Repo root of a file: a workspace root, or else the file's own git root (an
 * Accept link from the preview can arrive in another VS Code window).
 * @param {string} file
 */
function rootOf(file) {
  const f = norm(file);
  for (const root of roots) if (f.startsWith(root + path.sep)) return root;
  const dir = path.dirname(f);
  if (!ownRoots.has(dir)) ownRoots.set(dir, repoRoot(dir)); // git is asked once per folder
  const own = ownRoots.get(dir);
  return own && f.startsWith(norm(own) + path.sep) ? norm(own) : undefined;
}
/** @type {Map<string, string | undefined>} */
const ownRoots = new Map();

/** @param {string} file @param {string} text */
function hunksOf(file, text) {
  const copy = copyPath(file);
  const root = rootOf(file);
  if (!copy || !root || !fs.existsSync(copy)) return [];
  const log = path.join(root, HISTORY_DIR, `${path.relative(root, norm(file))}.jsonl`);
  return review(fs.readFileSync(copy, "utf8"), latestBefore(log), text);
}

/**
 * One file's agent edits as the graph shows them: what each Edit / Write call
 * wrote, other changes as outside edits (review-state.js). @param {string} file @param {string} text
 */
const editsOf = (file, text) => {
  const root = rootOf(file);
  return historyEdits(logOf(file) ?? "", text, root ? { toolCall: toolCallIn(root), link: linkIn(root, path.relative(root, norm(file))) } : {});
};

/** @param {string} file */
function logOf(file) {
  const root = rootOf(file);
  return root && path.join(root, HISTORY_DIR, `${path.relative(root, norm(file))}.jsonl`);
}

// Read-only documents for the diff view: imprimatur:/<name>?<file, edit, side>
const SCHEME = "imprimatur";
/** @param {string} file @param {number | "base"} n @param {"before" | "after" | "current"} side */
const historyUri = (file, n, side) =>
  vscode.Uri.from({ scheme: SCHEME, path: `/${path.basename(file)}`, query: JSON.stringify({ file, n, side }) });

/** @param {vscode.Uri} uri */
function historyContent(uri) {
  const { file, n, side } = JSON.parse(uri.query);
  if (n === "base") return fs.readFileSync(copyPath(file) ?? "", "utf8");
  const current = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText() ?? fs.readFileSync(file, "utf8");
  const edit = editsOf(file, current).find((e) => e.n === n);
  return edit ? edit[side === "before" ? "before" : "after"] : "";
}

/** Hunks of an open or on-disk file. @param {string} file */
const hunksOfFile = (file) => hunksOf(file, currentText(file) ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""));

/** Accept the agent's changes on new-text lines [start, end) of a file: write just those into the copy. */
function acceptRange(file, start, end) {
  const copy = copyPath(file);
  if (!copy || !fs.existsSync(copy)) {
    log.warn(`accept ${file} [${start}, ${end}): no review copy (${copy ?? "file outside any repo"})`);
    return;
  }
  log.info(`accept ${file} [${start}, ${end})`);
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
    const lenses = [];
    const hunks = hunksFor(doc);
    // One Accept per Markdown unit: a changed line alone, a newly added table or quote whole,
    // list items one by one (acceptGroups). Not per hunk: ten list items can be one hunk.
    const blocks = markdownIt && doc.languageId === "markdown" ? markdownBlocks(markdownIt, doc.getText()) : undefined;
    for (const [start, end] of acceptGroups(doc.getText(), hunks, blocks)) {
      const line = Math.min(start, doc.lineCount - 1);
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: end - start > 1 ? `$(check) Accept ${end - start} lines` : "$(check) Accept",
        command: "imprimatur.acceptRange",
        arguments: [doc.uri.fsPath, start, end],
      }));
    }
    for (const h of hunks) {
      // The editor cannot insert a real line: the old sentence sits above the new one as a lens.
      for (const m of h.marks)
        if (m.kind === "changed" && m.whole) {
          const old = m.oldText.trim();
          lenses.push(new vscode.CodeLens(new vscode.Range(m.line, 0, m.line, 0), {
            title: `− ${old.length > 200 ? `${old.slice(0, 199)}…` : old}`,
            tooltip: `Before: ${old}`,
            command: "",
          }));
        }
    }
    return lenses;
  },
};

/** @param {string} file @param {number} n */
function openEditDiff(file, n) {
  const e = editsOf(file, currentText(file) ?? "").find((x) => x.n === n);
  const time = e ? new Date(e.t).toLocaleString() : "";
  return vscode.commands.executeCommand("vscode.diff", historyUri(file, n, "before"), historyUri(file, n, "after"),
    `${path.basename(file)} · agent edit #${n} (${time})`);
}

/** Open-editor text (unsaved edits included), else undefined. @param {string} file */
const currentText = (file) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file)?.getText();

/** Accept one agent edit from the graph: its lines still under review go into the copy. @param {string} file @param {number} n */
function acceptEditOf(file, n) {
  const copy = copyPath(file);
  if (!copy || !fs.existsSync(copy)) return;
  const text = currentText(file) ?? fs.readFileSync(file, "utf8");
  const e = editsOf(file, text).find((x) => x.n === n);
  if (!e) return;
  log.info(`accept edit #${n} of ${file}`);
  fs.writeFileSync(copy, acceptEdit(fs.readFileSync(copy, "utf8"), e, text));
  renderAll();
  codeLensChanged.fire();
  refreshPreview();
  refreshGraph();
}

/**
 * One agent edit rendered as a Markdown review (the graph's hover, #50), or
 * undefined: not Markdown, the preview's markdown-it not loaded yet, nothing marked.
 * @param {string} file @param {number} n
 */
function renderEdit(file, n) {
  if (!markdownIt || !/\.mdx?$/i.test(file)) return undefined;
  const e = editsOf(file, currentText(file) ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")).find((x) => x.n === n);
  return e && reviewHtml(markdownIt, e.before, e.after);
}

/** Open the file at the first line of an agent edit that is still in it. @param {string} file @param {number} n */
async function goToEdit(file, n) {
  const doc = await vscode.workspace.openTextDocument(file);
  const e = editsOf(file, doc.getText()).find((x) => x.n === n);
  const [start, end] = (e && spotsOf(e, doc.getText())[0]) ?? [0, 0];
  const line = Math.min(start, doc.lineCount - 1);
  const range = new vscode.Range(line, 0, Math.max(line, Math.min(end, doc.lineCount) - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Selection(range.start, range.start), preview: false });
  vscode.window.activeTextEditor?.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/** The repo the graph shows: the active file's, else the first folder's. */
function graphRoot() {
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active?.scheme === "file" && rootOf(active.fsPath)) || [...roots][0];
}

function showGraph() {
  const root = graphRoot();
  if (!root) return void vscode.window.showInformationMessage("Agent Change Graph: no folder open.");
  openGraph(root, openEditDiff, currentText, acceptEditOf, goToEdit, renderEdit);
}

/**
 * A graph panel open before a reload comes back (WebviewPanelSerializer) with the
 * repo its page saved, if it is still there; else the usual one.
 * @param {vscode.WebviewPanel} panel @param {any} state the page's vscode.setState
 */
async function restoreGraph(panel, state) {
  const saved = typeof state?.root === "string" && state.root;
  const root = saved && (roots.has(norm(saved)) || fs.existsSync(saved)) ? saved : graphRoot();
  if (!root) return void panel.dispose();
  openGraph(root, openEditDiff, currentText, acceptEditOf, goToEdit, renderEdit, panel);
}

/** Status bar button, always there like Git Graph's: opens the graph, shows open asks. */
function updateGraphButton() {
  const root = graphRoot();
  if (!root) return graphButton.hide();
  const open = waitingSteps(root).filter((w) => w.state === "open").length;
  setupView?.refreshCounts();
  graphButton.text = open ? `$(git-merge) Agent Graph $(bell-dot) ${open}` : "$(git-merge) Agent Graph";
  graphButton.tooltip = open ? `Open the Agent Change Graph · ${open} waiting on you` : "Open the Agent Change Graph";
  graphButton.show();
}

async function showHistory() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== "file") return;
  const file = doc.uri.fsPath;
  const edits = editsOf(file, doc.getText()).filter((e) => e.added || e.removed);
  if (!edits.length) return void vscode.window.showInformationMessage("No agent edits recorded for this file.");
  const time = (t) => new Date(t).toLocaleString();
  /** @type {Array<vscode.QuickPickItem & {open: () => Thenable<unknown>}>} */
  const items = edits.map((e) => ({
    label: e.outside ? `$(question) after #${Math.floor(e.n)}  ${time(e.t)}` : `$(git-commit) #${e.n}  ${time(e.t)}`,
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

/** Markdown is reviewed in the preview unless imprimatur.showIn says otherwise. @param {vscode.TextDocument} doc */
function marksInEditor(doc) {
  const isMarkdown = doc.languageId === "markdown" || /\.mdx?$/i.test(doc.uri.fsPath);
  if (!isMarkdown) return true; // no preview for other files
  const config = vscode.workspace.getConfiguration("imprimatur", doc.uri);
  if (config.get("showIn", "preview") !== "preview") return true;
  // Paths that want marks in the source too (e.g. task lists read in both views).
  const globs = /** @type {string[]} */ (config.get("editorAlsoFor", []));
  return globs.some((pattern) => vscode.languages.match({ pattern }, doc) > 0);
}

/** @param {vscode.TextEditor} editor */
function render(editor) {
  const doc = editor.document;
  const all = inDiffTab(editor) ? [] : hunksFor(doc);
  const hunks = marksInEditor(doc) ? all : [];
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
        // A rewritten sentence's old text goes above the line (CodeLens); a single word stays inline.
        if (!m.whole)
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
  if (editor === vscode.window.activeTextEditor) updateStatus(all);
}

/** @param {ReturnType<typeof review>} hunks */
function updateStatus(hunks) {
  if (!hunks.length) return status.hide();
  status.text = `$(diff) ${hunks.length} agent change${hunks.length === 1 ? "" : "s"}`;
  status.tooltip = "Agent changes to review. Accept to clear.";
  status.show();
}

function renderAll() {
  for (const e of vscode.window.visibleTextEditors) render(e);
  if (!vscode.window.activeTextEditor) status.hide();
}

/** @type {NodeJS.Timeout | undefined} */
let previewTimer;
/** An Accept clicked in the preview already updated it there: no reload (it would jump). */
let skipPreviewUntil = 0;
/**
 * A preview refresh reloads the whole page (and restarts other preview scripts,
 * e.g. Mermaid renderers), so do it once, after things settle.
 */
function refreshPreview() {
  if (Date.now() < skipPreviewUntil) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => vscode.commands.executeCommand("markdown.preview.refresh").then(undefined, () => {}), 700);
}

function refreshEverything() {
  renderAll();
  updateGraphButton();
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

/**
 * Archive what is older than imprimatur.archive.afterDays (0: never) in every
 * repo, when a day has passed since the last run, or now (the command).
 * @param {boolean} [now] the command: run whatever the last run
 */
function archiveAll(now = false) {
  const days = vscode.workspace.getConfiguration("imprimatur").get("archive.afterDays", 7);
  /** @type {string[]} */
  const done = [];
  if (!(days > 0)) return done;
  for (const root of roots) {
    if (!now && !archiveDue(root)) continue;
    try {
      const r = archiveRepo(root, { days });
      log.info(`archive ${root}: ${r.edits} edits (${r.files} files), ${r.sessions} waiting logs, ${r.calls} calls, ${r.descriptions} descriptions`);
      if (r.edits || r.sessions) done.push(`${path.basename(root)}: ${r.edits} edits, ${r.sessions} waiting logs`);
    } catch (e) {
      log.error(`archive ${root}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (done.length) refreshEverything();
  return done;
}

/** @type {NodeJS.Timeout | undefined} */
let waitingTimer;
/** When the first of the waiting writes not refreshed yet came (0: none). */
let waitingFirst = 0;

/** @param {vscode.WorkspaceFolder} folder @param {vscode.ExtensionContext} ctx */
function addFolder(folder, ctx) {
  const found = repoRoot(folder.uri.fsPath) ?? folder.uri.fsPath;
  if (roots.has(norm(found))) return;
  roots.add(norm(found));
  // Copies and history change on every agent edit; re-render on any of them.
  // The waiting log changes every turn and only feeds the graph: no preview reload.
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(found), ".claude/imprimatur/**"));
  /** @param {vscode.Uri} uri */
  // So does the descriptions file the describe hook writes a few seconds after an edit.
  const waiting = path.join(found, WAITING_DIR) + path.sep;
  const descriptions = path.join(found, ".claude", "imprimatur", "descriptions.jsonl");
  const changed = (uri) => {
    if (!uri.fsPath.startsWith(waiting) && uri.fsPath !== descriptions) return refreshSoon();
    // The hooks write waiting/ on every tool call: one refresh a second after the
    // last write, and at least every 3 s while they keep coming. Cheap: the graph's
    // costly half is cached per file (graph.js fileEdits).
    clearTimeout(waitingTimer);
    const flush = () => {
      clearTimeout(waitingTimer);
      waitingFirst = 0;
      refreshGraph();
      updateGraphButton();
    };
    waitingFirst ||= Date.now();
    waitingTimer = setTimeout(flush, Math.max(0, Math.min(1000, waitingFirst + 3000 - Date.now())));
  };
  ctx.subscriptions.push(w, w.onDidChange(changed), w.onDidCreate(changed), w.onDidDelete(changed));
}

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  log = vscode.window.createOutputChannel("Imprimatur", { log: true });
  ctx.subscriptions.push(log);
  setGraphLog((msg) => log.info(msg));
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  graphButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  graphButton.command = "imprimatur.openGraph";
  ctx.subscriptions.push(
    status,
    graphButton,
    ...Object.entries(graphCommands).map(([id, fn]) => vscode.commands.registerCommand(id, fn)),
    ...Object.values(types),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: historyContent }),
    vscode.commands.registerCommand("imprimatur.showHistory", showHistory),
    vscode.commands.registerCommand("imprimatur.openGraph", showGraph),
    vscode.commands.registerCommand("imprimatur.acceptRange", acceptRange),
    // Process checks (#56): a repo turns them on with a committed .claude/imprimatur.json.
    vscode.commands.registerCommand("imprimatur.processOn", async () => {
      // It trusts the repo's docs TOC script: not from a folder VS Code does not trust.
      if (!vscode.workspace.isTrusted) {
        log.info("untrusted workspace: process checks not turned on");
        return void vscode.window.showInformationMessage("Imprimatur: process checks let the repo's scripts run; trust this folder first.");
      }
      const { starterSettings, CONFIG, trust } = require("./process.js");
      const list = [...roots].map((r) => repoRoot(r) ?? r);
      const root = list.length > 1 ? await vscode.window.showQuickPick(list, { title: "Turn on process checks in which repo?" }) : list[0];
      if (!root) return;
      const file = path.join(root, CONFIG);
      // Turning it on trusts the repo: its docs TOC script may run from Imprimatur's hook.
      trust(root);
      if (fs.existsSync(file)) {
        await vscode.window.showTextDocument(vscode.Uri.file(file));
        return vscode.window.showInformationMessage("Process checks are on here (this file sets them); the repo is now trusted to run its docs TOC script.");
      }
      const allow = await vscode.window.showInputBox({
        title: "On main, which paths may be edited without a branch?",
        prompt: "A regular expression on the repo-relative path; empty: nothing (every edit needs a branch)",
        value: "^docs/",
      });
      if (allow === undefined) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(starterSettings({ allow: allow.trim() ? [allow.trim()] : [] }), null, 2) + "\n");
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      vscode.window.showInformationMessage("Process checks are on for this repo from the next tool call. Commit .claude/imprimatur.json; each check is \"block\", \"warn\" or false.");
    }),
    vscode.commands.registerCommand("imprimatur.importMarkdown", () => {
      // Lazy: node:sqlite loads only when records are used.
      const { openDb } = require("./db.js");
      const { importRepo, summary } = require("./import.js");
      const lines = [];
      try {
        const db = openDb();
        try {
          for (const root of roots) {
            // roots are normalised (lower case on Windows); the repo row wants git's spelling.
            const r = importRepo(db, repoRoot(root) ?? root);
            for (const f of r.files) log.info(`import ${root}: ${f.file}: ${f.records} records, ${f.added} new, ${f.updated} updated${f.unparsed.length ? `, unparsed: ${f.unparsed.join(" | ")}` : ""}`);
            lines.push(`${path.basename(root)}: ${summary(r)}`);
          }
        } finally {
          db.close();
        }
        vscode.window.showInformationMessage(`Imprimatur import: ${lines.join("; ") || "no repo open"}. Details in Output → Imprimatur.`);
      } catch (e) {
        log.error(`import: ${e instanceof Error ? e.message : e}`);
        vscode.window.showErrorMessage(`Imprimatur import failed: ${e instanceof Error ? e.message : e}`);
      }
    }),
    vscode.commands.registerCommand("imprimatur.archiveNow", () => {
      const done = archiveAll(true);
      const days = vscode.workspace.getConfiguration("imprimatur").get("archive.afterDays", 7);
      vscode.window.showInformationMessage(
        !(days > 0) ? "Imprimatur archive is off (imprimatur.archive.afterDays = 0)."
        : done.length ? `Archived (older than ${days} days): ${done.join("; ")}. In .claude/imprimatur/archive/.`
        : `Nothing older than ${days} days to archive.`,
      );
    }),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLenses),
    // Accept buttons in the Markdown preview: vscode://<this extension>/accept?file&start&end
    vscode.window.registerUriHandler({
      handleUri(uri) {
        log.info(`uri ${uri.toString(true)}`);
        if (uri.path !== "/accept") return;
        const q = new URLSearchParams(uri.query);
        const file = q.get("file");
        if (file) {
          if (q.get("ui") === "1") skipPreviewUntil = Date.now() + 3000;
          acceptRange(file, Number(q.get("start")), Number(q.get("end")));
        }
      },
    }),
  );
  for (const f of vscode.workspace.workspaceFolders ?? []) addFolder(f, ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("imprimatur.graph", { deserializeWebviewPanel: restoreGraph }),
    // Trusted now: what was skipped (descriptions, the first scan) may run.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      log.info("workspace trusted: model calls allowed");
      graphTrusted();
      refreshEverything();
    }),
  );
  if (!vscode.workspace.isTrusted) log.info("untrusted workspace: Imprimatur shows changes and records but starts no claude, gh or repo scripts");
  // Once a day per repo: at start (after things settle), then checked hourly.
  const archiveTimer = setTimeout(() => archiveAll(), 30_000);
  const archiveHourly = setInterval(() => archiveAll(), 3_600_000);
  ctx.subscriptions.push({ dispose: () => (clearTimeout(archiveTimer), clearInterval(archiveHourly)) });

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(renderAll),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("imprimatur")) {
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
      updateGraphButton();
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
          refreshGraph();
        }
      }, 150);
    }),
    vscode.commands.registerTextEditorCommand("imprimatur.accept", (editor) => {
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
    vscode.commands.registerTextEditorCommand("imprimatur.acceptAll", (editor) => {
      const copy = copyPath(editor.document.uri.fsPath);
      if (copy && fs.existsSync(copy)) fs.rmSync(copy);
      render(editor);
    }),
  );
  // The side bar: records (Imprimatur's database), then a way to the graph and every file that shapes the agent.
  /** @type {{views: Record<string, any>, trees: Record<string, any>, ui: Record<string, any>} | undefined} */
  let recordViews;
  // Sync between machines (#61), when set up (config.json next to the database): now,
  // every 60 s, and 5 s after a local write. Only queued local changes start a sync:
  // applying pulled changes queues nothing, so the change it makes to the file ends there.
  /** @type {ReturnType<typeof syncLoop> | undefined} */
  let syncer;
  const runSync = async () => {
    const db = records.dbOf();
    if (!db) throw new Error(records.lastError ?? "database not available");
    const cfg = readConfig(db.file);
    if (!cfg) return "sync: not set up (npm run sync -- --setup <url>)";
    return describe(await syncOnce(db, cfg, { log: (line) => log.warn(line) }));
  };
  /** Starts the loop once sync is set up (at activation, or later by Sync Now). */
  const startSync = () => {
    const db = records.dbOf();
    if (syncer || !db || !readConfig(db.file)) return false;
    syncer = syncLoop(runSync, (line, error) => (error ? log.warn(line) : log.info(line)));
    ctx.subscriptions.push({ dispose: () => syncer?.dispose() });
    // Said once: a second clone of an origin does not sync (the first one by id does).
    for (const r of db.unsyncedClones()) log.info(`sync: ${r.root} is a second clone of ${r.origin}; only the first one syncs`);
    return true;
  };
  try {
    if (startSync()) syncer?.now();
  } catch (e) {
    log.error(`sync: ${e instanceof Error ? e.message : e}`);
  }
  // Through the loop, so it never runs alongside a timed sync.
  ctx.subscriptions.push(vscode.commands.registerCommand("imprimatur.syncNow", async () => {
    try {
      startSync();
    } catch {}
    if (!syncer) return void vscode.window.showInformationMessage("Imprimatur: sync is not set up; run npm run sync -- --setup <url> in the Imprimatur folder.");
    const { line, error } = await syncer.now();
    if (error) vscode.window.showErrorMessage(`Imprimatur ${error}`);
    else if (line) vscode.window.setStatusBarMessage(`Imprimatur ${line}`, 5000);
  }));
  try {
    // The repos as git spells them: roots are normalised (lower case on Windows).
    recordViews = registerRecordViews(ctx, () => [...roots].map((r) => repoRoot(r) ?? r), (msg) => log.warn(msg), () => {
      syncRecords();
      setupView?.refreshCounts();
      try {
        if (syncer && records.dbOf()?.outboxCount()) syncer.kick();
      } catch {}
    });
  } catch (e) {
    log.error(`records views: ${e instanceof Error ? e.message : e}`);
  }
  setupView = registerSetupView(ctx, () => [...roots], () => {
    const root = graphRoot();
    if (!root) return { edits: 0, waiting: 0 };
    return {
      edits: graphRows(root, currentText).rows.filter((r) => !r.accepted && !r.gone).length,
      waiting: waitingSteps(root).filter((w) => w.state === "open").length,
    };
  });
  renderAll();
  updateGraphButton();
  // Load the markdown extension's plugins now, so Accept units use its parser before any preview opens.
  vscode.commands.executeCommand("markdown.api.render", "").then(undefined, () => {});
  // Markdown preview: the built-in markdown extension calls this with its markdown-it.
  return {
    // The records views' data providers, read by the integration tests (#68); nothing else uses them.
    recordViews: recordViews?.views,
    recordTrees: recordViews?.trees,
    recordUi: recordViews?.ui,
    extendMarkdownIt: (md) => {
      markdownIt = md;
      codeLensChanged.fire();
      return markdownItPlugin(
        md,
        (env) => {
        /** @type {vscode.Uri | undefined} */
        const uri = env?.currentDocument;
        if (uri?.scheme !== "file") return [];
        if (vscode.workspace.getConfiguration("imprimatur", uri).get("showIn", "preview") === "editor") return [];
        // The preview renders the open document, unsaved edits included.
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        return hunksOf(uri.fsPath, doc ? doc.getText() : fs.readFileSync(uri.fsPath, "utf8"));
        },
        (env, start, end, rerender) => {
          /** @type {vscode.Uri | undefined} */
          const uri = env?.currentDocument;
          if (uri?.scheme !== "file") return undefined;
          // ui=1: the preview clears the block itself, no reload needed (a diagram needs one).
          const q = new URLSearchParams({ file: uri.fsPath, start: String(start), end: String(end), ui: rerender ? "0" : "1" });
          return `${vscode.env.uriScheme}://${ctx.extension.id}/accept?${q}`;
        },
        (env) => {
          /** @type {vscode.Uri | undefined} */
          const uri = env?.currentDocument;
          if (uri?.scheme !== "file") return undefined;
          const config = vscode.workspace.getConfiguration("imprimatur", uri);
          if (config.get("showIn", "preview") === "editor") return undefined;
          // Off by default: changing a Mermaid block's source races other Mermaid preview extensions.
          if (!config.get("mermaidDiff", false)) return undefined;
          const copy = copyPath(uri.fsPath);
          return copy && fs.existsSync(copy) ? fs.readFileSync(copy, "utf8") : undefined;
        },
      );
    },
  };
}

module.exports = { activate, deactivate() {} };
