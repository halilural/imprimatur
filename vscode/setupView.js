// @ts-check
// The Imprimatur side bar (activity bar icon), under the launcher (launcherView.js):
// "Agent setup": every file that shapes the agent, per repo
// and global, grouped by tool, marked new / changed / removed since the user
// last looked (Mark all as seen). Read only: it never edits the files.
"use strict";
const vscode = require("vscode");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { scanSetup, changesSince, snapshotOf, flatItems } = require("./agent-setup.js");
const { readUpstream, checkUpstream, staleOf } = require("./upstream.js");
const { recordVersions, versionLine } = require("./version-history.js");
const { checklistOf } = require("./setup-checklist.js");
/** @type {vscode.OutputChannel | undefined} Fix it's answers (#156). */
let fixOutput;
const { DriftScanner, driftLabel, DEFAULT_EXCLUDE } = require("./setup-drift.js");
const { SetupHistory, historyLines } = require("./setup-history.js");
const { trustGate } = require("./trust.js");
const { withScopes, inEffectFor, effectTree } = require("./setup-scope.js");
const { readSources, mergeSettings, mergedTree } = require("./setup-merged.js");

/** "For <active file>" (#28): what is in effect for the file, from the scope holding it. @param {any[]} scopes @param {string | undefined} file */
function forFileNode(scopes, file) {
  if (!file) return undefined;
  const repo = scopes.filter((s) => !s.global && !path.relative(s.root, file).startsWith("..") && !path.isAbsolute(path.relative(s.root, file))).sort((a, b) => b.root.length - a.root.length)[0];
  const glob = scopes.find((s) => s.global);
  const e = inEffectFor(file, { root: repo?.root ?? path.dirname(file), items: repo?.items ?? [], globalItems: glob?.items ?? [], hooks: repo?.merged?.hooks });
  return effectTree(e, path.basename(file));
}
const { checkHealth } = require("./setup-health.js");
const { recommendationsRow } = require("./setup-audit-tree.js");

const SEEN_KEY = "imprimatur.setupSeen";
const ICONS = {
  "Claude Code": "sparkle",
  Cursor: "symbol-event",
  "GitHub Copilot": "copilot",
  "Codex / AGENTS.md": "hubot",
  Gemini: "star-empty",
  Windsurf: "symbol-misc",
  Cline: "symbol-misc",
  Aider: "symbol-misc",
  "Git hooks": "git-commit",
  Other: "file",
};
/** A tool's files are grouped by kind (Skills, Agents, …) once it has this many and more than one kind. */
const GROUP_FROM = 4;
const KIND_NAMES = {
  settings: "Settings", "hook script": "Hook scripts", skill: "Skills", command: "Commands", agent: "Agents", rules: "Rules",
  "MCP servers": "MCP servers", "output style": "Output styles", plugin: "Plugins", prompt: "Prompts", "chat mode": "Chat modes",
  "git hook": "Git hooks", "commit rules": "Commit rules", ignore: "Ignore files", file: "Files",
};
/** Kinds in the order they show: what decides behaviour first. */
const KIND_ORDER = ["rules", "settings", "hook script", "skill", "agent", "command", "MCP servers", "plugin", "output style", "prompt", "chat mode", "ignore", "git hook", "commit rules", "file"];
const KIND_ICONS = { settings: "settings-gear", "hook script": "zap", skill: "mortar-board", command: "terminal", agent: "person", rules: "book", "MCP servers": "plug", "git hook": "git-commit", "commit rules": "checklist", ignore: "eye-closed" };

/**
 * @typedef {{type: "graph"} | {type: "scope", scope: Scope} | {type: "tool", scope: Scope, tool: string} | {type: "kind", scope: Scope, tool: string, kind: string}
 *   | {type: "file", scope: Scope, item: ReturnType<typeof scanSetup>[number], state?: string} | {type: "detail", text: string}
 *   | {type: "removed", scope: Scope, rel: string} | PlainNode
 *   | {type: "health"} | {type: "problem", scope: Scope, problem: ReturnType<typeof checkHealth>[number]}} Node
 * @typedef {{type: "group" | "leaf", label: string, description?: string, tooltip?: string, markdown?: boolean, icon?: string, color?: string, abs?: string,
 *   line?: number, context?: string, recordId?: number, command?: string, args?: any[], expanded?: boolean, children?: any[]}} PlainNode
 *   "For <file>", "Effective settings" and "Recommendations" rows, built by setup-scope.js / setup-merged.js / setup-audit-tree.js
 * @typedef {{id: string, label: string, root: string, global: boolean, merged?: ReturnType<typeof mergeSettings>,
 *   items: Array<ReturnType<typeof scanSetup>[number] & {scope?: {label: string}}>, state: Record<string, string>, removed: string[], health: ReturnType<typeof checkHealth>}} Scope
 */

/** A plain group / leaf row. @param {PlainNode} node @returns {vscode.TreeItem} */
function plainItem(node) {
  const T = vscode.TreeItemCollapsibleState;
  const it = new vscode.TreeItem(node.label, node.type === "group" ? (node.expanded || node.label.startsWith("For ") ? T.Expanded : T.Collapsed) : T.None);
  it.description = node.description;
  it.tooltip = node.markdown && node.tooltip ? new vscode.MarkdownString(node.tooltip) : node.tooltip;
  if (node.icon) it.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
  if (node.context) it.contextValue = node.context;
  if (node.command) it.command = { command: node.command, title: node.label, ...(node.args ? { arguments: node.args } : {}) };
  else if (node.type === "leaf" && node.abs) {
    const line = Math.max(0, (node.line ?? 1) - 1);
    it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(node.abs), ...(node.line ? [{ selection: new vscode.Range(line, 0, line, 0) }] : [])] };
  }
  return it;
}

class SetupView {
  /**
   * @param {vscode.ExtensionContext} ctx
   * @param {() => string[]} roots repo roots in the window
   * @param {() => {edits: number, waiting: number}} counts for the graph row
   */
  constructor(ctx, roots, counts) {
    this.ctx = ctx;
    this.roots = roots;
    this.counts = counts;
    /** @type {vscode.EventEmitter<Node | undefined>} */
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    /** @type {Scope[]} */
    this.scopes = [];
    /** The checklist (#142) and who hears its count (the launcher). */
    this.checklist = checklistOf([], 0);
    /** @type {((count: number) => void) | undefined} */
    this.onScanned = undefined;
    /** @type {vscode.TreeView<Node> | undefined} */
    this.view = undefined;
    this.graph = { edits: 0, waiting: 0 };
    // Drift across repos (#31) and git history (#32): filled in after the scan, async.
    this.drift = new DriftScanner();
    this.history = new SetupHistory({
      allowed: trustGate(() => vscode.workspace.isTrusted, (msg) => console.log(`Imprimatur: ${msg}`)),
      lang: () => vscode.workspace.getConfiguration("imprimatur").get("language") || require("./config.js").hookLang() || "English",
    });
    this.extrasBusy = false;
    this.extrasAgain = false;
    /** @type {any} the Recommendations row (#77), from the AUDIT records */
    this.audit = undefined;
    this.auditing = false;
  }

  /** The open recommendations Claude Code loads, in every scanned scope, for Fix it (#156). */
  openFindings() {
    const db = require("./records.js").dbOf();
    if (!db) return [];
    return this.scopes.flatMap((s) => {
      const repo = db.repoByRoot(s.root);
      const task = repo && require("./recs.js").recsTask(db, repo.id);
      return task ? db.recordsOf(task.id).filter((/** @type {any} */ r) => r.status === "open" && ((r.links?.audit && r.links.audit.effect !== "inactive") || r.links?.best)) : [];
    });
  }

  /** The AUDIT records of the window's repos and of the home, as the Recommendations row (#77). */
  loadAudit() {
    try {
      const records = require("./records.js");
      const db = records.dbOf();
      if (!db) return void (this.audit = undefined);
      // RECS (#87): the old AUDIT / BEST records move into it the first time it is read.
      this.audit = recommendationsRow(this.scopes.map((s) => {
        const repo = db.repoByRoot(s.root);
        const task = repo && require("./recs.js").recsTask(db, repo.id);
        return { label: s.label, root: s.root, records: task ? db.recordsOf(task.id, { dropped: true }) : [], summary: task?.summary };
      }));
    } catch (e) {
      console.log(`Imprimatur: audit records: ${e instanceof Error ? e.message : e}`);
      this.audit = undefined;
    }
  }

  /** Drift and history for the scanned repos; redraws when they arrive. */
  async extras() {
    if (this.extrasBusy) return void (this.extrasAgain = true);
    this.extrasBusy = true;
    try {
      const cfg = vscode.workspace.getConfiguration("imprimatur.setup");
      const repos = this.scopes.filter((s) => !s.global);
      await this.drift.scan(repos.map((s) => s.root), { driftRoots: cfg.get("driftRoots") ?? ["~/projects"], exclude: cfg.get("driftExclude") ?? DEFAULT_EXCLUDE });
      for (const s of repos) await this.history.refresh(s.root, s.items.map((i) => i.rel));
      this.changed.fire(undefined);
    } catch {
    } finally {
      this.extrasBusy = false;
      if (this.extrasAgain) {
        this.extrasAgain = false;
        this.extras();
      }
    }
  }

  /** A file row's tooltip, with drift and history (and the last change explained, when known). @param {Extract<Node, {type: "file"}>} node @param {string} [explained] */
  fileTooltip(node, explained) {
    const { item, state } = node;
    const d = node.scope.global ? undefined : this.drift.driftFor(item.rel, item.abs);
    const lines = [`**${item.rel}** · ${item.tool} ${item.kind}${item.scope ? ` · ${item.scope.label}` : ""}${state ? ` · _${state} since you last looked_` : ""}`, item.summary];
    if (d) lines.push(`${driftLabel(d)}: ${d.others.map((v) => `${v.repos.join(", ")} (\`${v.hash.slice(0, 7)}\`)`).join(" · ")}`);
    // Git history only for a file in the repo: a plugin, a session row or auto memory has none.
    if (inRepo(node)) lines.push(historyLines(this.history.info(node.scope.root, item.rel), explained).join("  \n"));
    return new vscode.MarkdownString(lines.join("\n\n"));
  }

  /** Hover on a file: explain its last change (lazy, cached; not in an untrusted folder). @param {vscode.TreeItem} it @param {Node} node */
  async resolveTreeItem(it, node) {
    if (node.type === "file" && !it.tooltip) it.tooltip = this.fileTooltip(node, inRepo(node) ? await this.history.explain(node.scope.root, node.item.rel) : undefined);
    return it;
    /** @type {string | undefined} the active editor's file, for "For <file>" */
    this.activeFile = undefined;
  }

  /** Rescan every scope (cheap: a folder walk and small reads). */
  scan() {
    this.graph = this.counts();
    const seen = /** @type {Record<string, Record<string, string>>} */ (this.ctx.globalState.get(SEEN_KEY) ?? {});
    const home = os.homedir();
    const defs = [...this.roots().map((r) => ({ id: r, label: path.basename(r), root: r, global: false })), { id: "~", label: "Global (~)", root: home, global: true }];
    const upstreamFile = path.join(this.ctx.globalStorageUri.fsPath, "upstream.json");
    const upstream = readUpstream(upstreamFile);
    this.scopes = defs.map((d) => {
      const items = withScopes(scanSetup(d.root, { global: d.global, upstream }), { global: d.global });
      // First look at a scope: remember it, mark nothing.
      if (!seen[d.id]) {
        seen[d.id] = snapshotOf(items);
        this.ctx.globalState.update(SEEN_KEY, seen);
      }
      const merged = d.global ? undefined : mergeSettings(readSources({ root: d.root, home }));
      return { ...d, items, merged, ...changesSince(items, seen[d.id]), health: checkHealth(items, { root: d.root, global: d.global }) };
    });
    // Version history of plugins and hand-installed skills (#140): kept here, shown on the row.
    const versions = recordVersions(path.join(this.ctx.globalStorageUri.fsPath, "versions.json"),
      this.scopes.flatMap((s) => flatItems(s.items).flatMap((i) => (i.kind === "installed plugin"
        ? [{ key: `${s.id} ${i.rel}`, value: i.hash, since: i.details.find((d) => d.startsWith("installed "))?.slice(10) }]
        : i.origin ? [{ key: `${s.id} ${i.rel}`, value: i.origin.commit }] : []))),
      new Date().toISOString().slice(0, 10));
    for (const s of this.scopes)
      for (const i of flatItems(s.items)) {
        const line = versionLine(versions[`${s.id} ${i.rel}`]);
        if (line) i.details.push(line);
      }
    // Hand-installed skills' upstream (#140): checked in the background at most once a day, then shown.
    const origins = this.scopes.flatMap((s) => flatItems(s.items).flatMap((i) => (i.origin ? [i.origin] : [])));
    if (!this.checkingUpstream && staleOf(origins, upstream, Date.now()).length) {
      this.checkingUpstream = true;
      checkUpstream(origins, upstreamFile)
        .then((checked) => checked && this.refresh())
        .catch(() => {})
        .finally(() => (this.checkingUpstream = false));
    }
    const fresh = this.scopes.reduce((n, s) => n + Object.keys(s.state).length + s.removed.length, 0);
    this.loadAudit();
    // The checklist (#142): what needs doing, from the scan, the health check and the audit.
    this.checklist = checklistOf(this.scopes, /** @type {any} */ (this.audit)?.open ?? 0);
    this.onScanned?.(this.checklist.count);
    this.extras();
    if (this.view) this.view.badge = fresh ? { value: fresh, tooltip: `${fresh} agent setup change${fresh === 1 ? "" : "s"} since you last looked` } : undefined;
  }

  refresh() {
    this.scan();
    this.changed.fire(undefined);
  }

  /** Only the graph row's counts (after an agent edit or a waiting record). */
  refreshCounts() {
    this.graph = this.counts();
    this.changed.fire(undefined);
  }

  /** Mark all as seen: the current setup becomes the reference. */
  markSeen() {
    const seen = /** @type {Record<string, Record<string, string>>} */ (this.ctx.globalState.get(SEEN_KEY) ?? {});
    for (const s of this.scopes) seen[s.id] = snapshotOf(s.items);
    this.ctx.globalState.update(SEEN_KEY, seen).then(() => this.refresh());
  }

  /** @param {Node} [node] @returns {Node[]} */
  getChildren(node) {
    if (!node) {
      const forFile = forFileNode(this.scopes, this.activeFile);
      return [/** @type {Node} */ (this.checklist.node), ...healthRoot(this.scopes), ...(this.audit ? [/** @type {Node} */ (this.audit)] : []), ...(forFile ? [/** @type {Node} */ (forFile)] : []), ...this.scopes.map((scope) => /** @type {Node} */ ({ type: "scope", scope }))];
    }
    if (node.type === "group") return node.children;
    if (node.type === "health") return healthChildren(this.scopes);
    if (node.type === "scope") {
      const tools = [...new Set(node.scope.items.map((i) => i.tool))];
      return [
        ...tools.map((tool) => /** @type {Node} */ ({ type: "tool", scope: node.scope, tool })),
        ...(node.scope.merged ? [/** @type {Node} */ (mergedTree(node.scope.merged))] : []),
        ...node.scope.removed.map((rel) => /** @type {Node} */ ({ type: "removed", scope: node.scope, rel })),
      ];
    }
    const fileNode = (item) => /** @type {Node} */ ({ type: "file", scope: node.scope, item, state: node.scope.state[item.rel] });
    if (node.type === "tool") {
      const files = node.scope.items.filter((i) => i.tool === node.tool);
      const kinds = [...new Set(files.map((f) => f.kind))].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
      if (files.length < GROUP_FROM || kinds.length < 2) return files.map(fileNode);
      return kinds.map((kind) => /** @type {Node} */ ({ type: "kind", scope: node.scope, tool: node.tool, kind }));
    }
    if (node.type === "kind") return node.scope.items.filter((i) => i.tool === node.tool && i.kind === node.kind).map(fileNode);
    if (node.type === "file") return [...node.item.details.map((text) => /** @type {Node} */ ({ type: "detail", text })), ...(node.item.children ?? []).map(fileNode)];
    return [];
  }

  /** @param {Node} node @returns {vscode.TreeItem} */
  getTreeItem(node) {
    const T = vscode.TreeItemCollapsibleState;
    if (node.type === "group" || node.type === "leaf") return plainItem(node);
    if (node.type === "graph") {
      const { edits, waiting } = this.graph;
      const it = new vscode.TreeItem("Agent Change Graph", T.None);
      it.iconPath = new vscode.ThemeIcon("git-merge");
      it.description = [edits && `${edits} under review`, waiting && `${waiting} waiting on you`].filter(Boolean).join(" · ");
      it.command = { command: "imprimatur.openGraph", title: "Open Agent Change Graph" };
      return it;
    }
    if (node.type === "scope") {
      const n = Object.keys(node.scope.state).length + node.scope.removed.length;
      const it = new vscode.TreeItem(node.scope.label, node.scope.global ? T.Collapsed : T.Expanded);
      it.iconPath = new vscode.ThemeIcon(node.scope.global ? "home" : "repo");
      it.description = `${node.scope.items.length} files${n ? ` · ${n} changed` : ""}`;
      it.tooltip = node.scope.global ? `${node.scope.root}: applies to every repo` : node.scope.root;
      if (!node.scope.items.length && !node.scope.global) it.description = "no agent setup";
      return it;
    }
    if (node.type === "tool") {
      const files = node.scope.items.filter((i) => i.tool === node.tool);
      const n = files.filter((f) => node.scope.state[f.rel]).length;
      const it = new vscode.TreeItem(node.tool, T.Collapsed);
      it.iconPath = new vscode.ThemeIcon(ICONS[node.tool] ?? "file");
      it.description = `${files.length}${n ? ` · ${n} changed` : ""}`;
      return it;
    }
    if (node.type === "kind") {
      const files = node.scope.items.filter((i) => i.tool === node.tool && i.kind === node.kind);
      const n = files.filter((f) => node.scope.state[f.rel]).length;
      // Small groups open, big ones (18 skills) stay folded.
      const it = new vscode.TreeItem(KIND_NAMES[node.kind] ?? node.kind, files.length > 6 ? T.Collapsed : T.Expanded);
      it.iconPath = new vscode.ThemeIcon(KIND_ICONS[node.kind] ?? "folder");
      it.description = `${files.length}${n ? ` · ${n} changed` : ""}`;
      it.id = `${node.scope.id}|${node.tool}|${node.kind}`;
      return it;
    }
    if (node.type === "file") {
      const { item, state } = node;
      const it = new vscode.TreeItem(item.label, item.details.length || item.children?.length ? T.Collapsed : T.None);
      const drift = node.scope.global ? undefined : this.drift.driftFor(item.rel, item.abs);
      // When it applies (#28), unless the summary already says it (.mdc).
      const when = item.scope && !item.summary.startsWith(item.scope.label) ? `${item.scope.label} · ` : "";
      it.description = `${state ? `${state} · ` : ""}${when}${drift ? `${driftLabel(drift)} · ` : ""}${item.summary}`;
      const explained = node.scope.global ? undefined : this.history.explained(node.scope.root, item.rel);
      // A committed repo file not yet explained gets its tooltip on hover (resolveTreeItem).
      // A file with problems builds its tooltip now: the problems are appended to it (markHealth).
      const problems = (node.scope.health ?? []).filter((p) => p.file === item.abs);
      const lazy = !problems.length && inRepo(node) && !explained && this.history.info(node.scope.root, item.rel);
      it.tooltip = lazy ? undefined : this.fileTooltip(node, explained);
      it.contextValue = `setupFile${drift ? "-drift" : ""}${node.scope.global ? "" : "-repo"}${item.update ? "-update" : ""}${item.compare ? "-upstream" : ""}`;
      it.iconPath = state
        ? new vscode.ThemeIcon(KIND_ICONS[item.kind] ?? "file", new vscode.ThemeColor(state === "new" ? "gitDecoration.addedResourceForeground" : "gitDecoration.modifiedResourceForeground"))
        : new vscode.ThemeIcon(KIND_ICONS[item.kind] ?? "file");
      // A session row (#139) may have no file: an MCP server's instructions, a tool count.
      if (item.abs) {
        it.resourceUri = vscode.Uri.file(item.abs);
        it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(item.abs)] };
      }
      markHealth(it, node.scope.health.filter((p) => p.file === item.abs));
      return it;
    }
    if (node.type === "health" || node.type === "problem") return healthItem(node, this.scopes);
    if (node.type === "removed") {
      const it = new vscode.TreeItem(node.rel, T.None);
      it.description = "removed since you last looked";
      it.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("gitDecoration.deletedResourceForeground"));
      return it;
    }
    const it = new vscode.TreeItem(node.text, T.None);
    it.iconPath = new vscode.ThemeIcon("debug-breakpoint-log");
    return it;
  }
}

/** Whether a row is a file inside its repo, so git knows it. @param {any} node */
const inRepo = (node) => !node.scope.global && !!node.item.abs && path.resolve(node.item.abs).startsWith(path.resolve(node.scope.root) + path.sep);

/**
 * Fix it (#156): after the user confirms, Claude Code's CLI runs the fix in the background
 * (`claude -p`: user settings only, no MCP, no commands, edits only the target files) under a
 * progress notification, then shows the agent's answer; its edits are tracked for review.
 * Untrusted workspace or no CLI: the prompt goes to the clipboard.
 * @param {SetupView} provider @param {any} node a checklist row or a recommendation row
 */
async function fixWithClaude(provider, node) {
  const prompts = require("./fix-prompts.js");
  const runner = require("./fix-runner.js");
  const db = require("./records.js").dbOf();
  const repo = provider.scopes.find((s) => !s.global)?.root ?? os.homedir();
  /** @type {{prompt: string, label: string, edit: string[], editDirs: string[], read: string[], audit?: boolean}} */
  let fix = { prompt: "", label: "", edit: [], editDirs: [], read: [] };
  const kind = node?.fix?.kind;
  if (kind === "health") fix = { prompt: prompts.healthPrompt(node.fix.problem), label: path.basename(node.fix.problem.file), edit: [node.fix.problem.file], editDirs: [], read: [] };
  else if (kind === "findings") {
    const open = provider.openFindings();
    const files = open.map((/** @type {any} */ r) => r.links?.audit?.file).filter(Boolean);
    if (open.length) fix = { prompt: prompts.findingsPrompt(open), label: `${open.length} recommendations`, edit: files, editDirs: [], read: [], audit: true };
  } else if (!kind && node?.recordId && db) {
    const r = db.record(node.recordId);
    if (r) fix = { prompt: prompts.findingPrompt(r), label: r.title.slice(0, 40), edit: r.links?.audit?.file ? [r.links.audit.file] : [], editDirs: [], read: [], audit: true };
  }
  const skill = kind === "skill" ? node.fix.item : undefined;
  if (skill && !prompts.skillUpdatePrompt(skill)) return void vscode.window.showWarningMessage("Imprimatur: this skill's SOURCE.txt is not a plain GitHub source; review the change by hand.");
  if (!skill && !fix.prompt) return void vscode.window.showInformationMessage("Imprimatur: nothing to fix here.");
  const bin = runner.claudeBin();
  if (!vscode.workspace.isTrusted || !bin) {
    const text = skill ? prompts.skillUpdatePrompt(skill, "(download it from the compare page)") : fix.prompt;
    await vscode.env.clipboard.writeText(text);
    return void vscode.window.showInformationMessage(`Imprimatur: ${!bin ? "no Claude Code CLI here" : "this folder is not trusted, so Fix it does not run an agent"}; the fix prompt is on the clipboard.`);
  }
  if (skill) {
    // The new version is downloaded here, with GET requests only: the agent gets no shell.
    const dir = path.dirname(skill.abs);
    const to = /\.\.\.([0-9a-f]+)$/.exec(skill.compare)?.[1] ?? "";
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), `imprimatur-skill-${skill.label}-`));
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Imprimatur: downloading ${skill.label} at ${to.slice(0, 7)}…` },
        () => require("./upstream.js").fetchSkillFolder(skill.origin, to, dest));
    } catch (e) {
      return void vscode.window.showErrorMessage(`Imprimatur: could not download ${skill.label}: ${e instanceof Error ? e.message : e}`);
    }
    fix = { prompt: prompts.skillUpdatePrompt(skill, dest), label: skill.label, edit: [], editDirs: [dir], read: [dest] };
  }
  const may = [...fix.edit.map((f) => f.replace(os.homedir(), "~")), ...fix.editDirs.map((d) => `${d.replace(os.homedir(), "~")}/`)];
  const go = await vscode.window.showWarningMessage(`Run Claude in the background to fix ${fix.label}?`,
    { modal: true, detail: `It may edit only: ${may.join(", ") || "nothing"}. No commands, no web. Its edits wait for your review in Agent changes.\n\n${fix.prompt.slice(0, 1200)}` }, "Run");
  if (go !== "Run") return;
  const out = (fixOutput ??= vscode.window.createOutputChannel("Imprimatur Fix it"));
  out.appendLine(`\n=== ${new Date().toLocaleString()} · Fix it: ${fix.label} (in ${repo})\n${fix.prompt}\n---`);
  const args = runner.claudeArgs(fix.prompt, { edit: fix.edit, editDirs: fix.editDirs, addDirs: runner.outside(repo, [...fix.edit, ...fix.editDirs.map((d) => path.join(d, "x")), ...fix.read.map((d) => path.join(d, "x"))]) });
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Imprimatur: Claude is fixing ${fix.label}…`, cancellable: true },
    (_p, token) => new Promise((resolve) => {
      const { spawn } = require("node:child_process");
      // stdin closed: -p reads it when it is a pipe.
      const child = spawn(bin, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => ((stdout += d), out.append(String(d))));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
      token.onCancellationRequested(() => child.kill());
      child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e.message) }));
      child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
    }));
  const r = /** @type {{code: number, stdout: string, stderr: string}} */ (res);
  if (r.stderr) out.appendLine(`\n[stderr] ${r.stderr.trim()}`);
  for (const d of fix.read) fs.rmSync(d, { recursive: true, force: true });
  if (r.code !== 0) {
    provider.refresh();
    const pick = await vscode.window.showErrorMessage(`Imprimatur: Fix it stopped (${r.code === null ? "cancelled" : `exit ${r.code}`}). ${r.stderr.trim().split("\n")[0].slice(0, 160)}`, "Show output");
    if (pick) out.show();
    return;
  }
  // The run has no MCP: the audit runs here, so the counts show what is left.
  if (fix.audit) await runAudit(provider);
  else provider.refresh();
  const first = r.stdout.trim().split("\n").find((l) => l.trim()) ?? "Done.";
  const pick = await vscode.window.showInformationMessage(`Imprimatur: Fix it finished: ${first.slice(0, 200)}`, "Show answer", "Review changes");
  if (pick === "Show answer") out.show();
  if (pick === "Review changes") vscode.commands.executeCommand("imprimatur.openGraph");
}

/**
 * Updates a plugin that is behind its marketplace (#140) in a terminal, at the scope it was
 * installed and in its repo for project and local scope: Claude Code's own update, after a
 * marketplace refresh. @param {any} item a SetupItem with update
 */
function updatePlugin(item) {
  const u = item?.update;
  // The id and scope go into a shell line: only plain names.
  if (!u || !/^[\w.-]+@[\w.-]+$/.test(u.id) || !/^(user|project|local)$/.test(u.scope)) return;
  const t = vscode.window.createTerminal({ name: `Update ${u.id}`, cwd: u.cwd || undefined });
  t.show();
  t.sendText(`claude plugin marketplace update ${u.id.split("@")[1]} && claude plugin update ${u.id} --scope ${u.scope} && echo "Updated: restart Claude Code sessions to load it."`);
}

// Kinds from the wider scan (#27): auto memory, @imports, managed policy, Cursor hooks.
Object.assign(KIND_NAMES, { "installed plugin": "Installed plugins", "synced skill": "Skills synced from claude.ai",
  "loaded instructions": "Instructions loaded", "hook output": "Hooks: what they added and how long they took", "MCP instructions": "MCP server instructions",
  tools: "Tools by server", listings: "Skills and agents listed", "model and mode": "Model, mode and context",
  "data sources": "Data sources: memory the agent can read (not vetted)" });
Object.assign(KIND_ICONS, { "installed plugin": "extensions", "synced skill": "cloud", "loaded instructions": "book", "hook output": "zap",
  "MCP instructions": "plug", tools: "tools", listings: "list-unordered", "model and mode": "hubot", "data sources": "database" });
KIND_ORDER.splice(KIND_ORDER.indexOf("plugin") + 1, 0, "installed plugin", "synced skill");
KIND_ORDER.push("loaded instructions", "hook output", "MCP instructions", "tools", "listings", "data sources", "model and mode");
Object.assign(KIND_NAMES, { memory: "Auto memory", import: "Imports", "managed policy": "Managed policy", hooks: "Hooks" });
Object.assign(KIND_ICONS, { memory: "notebook", import: "references", "managed policy": "shield", hooks: "zap" });
KIND_ORDER.splice(KIND_ORDER.indexOf("settings"), 0, "managed policy");
KIND_ORDER.splice(KIND_ORDER.indexOf("hook script"), 0, "hooks", "memory");

/**
 * Health (#30): one "Health (n)" row on top while any scope has a problem.
 * @param {Scope[]} scopes @returns {Node[]}
 */
function healthRoot(scopes) {
  return scopes.some((s) => s.health.length) ? [{ type: "health" }] : [];
}

/** The problems, errors first. @param {Scope[]} scopes @returns {Node[]} */
function healthChildren(scopes) {
  const all = scopes.flatMap((scope) => scope.health.map((problem) => /** @type {Node} */ ({ type: "problem", scope, problem })));
  return all.sort((a, b) => (a.type === "problem" && b.type === "problem" ? (a.problem.level === b.problem.level ? 0 : a.problem.level === "error" ? -1 : 1) : 0));
}

/** @param {Node & {type: "health" | "problem"}} node @param {Scope[]} [scopes] */
function healthItem(node, scopes) {
  const T = vscode.TreeItemCollapsibleState;
  if (node.type === "health") {
    const it = new vscode.TreeItem("Health", T.Collapsed);
    it.iconPath = new vscode.ThemeIcon("pulse");
    it.id = "imprimatur.setup.health";
    if (scopes) {
      const all = scopes.flatMap((s) => s.health);
      const errors = all.filter((p) => p.level === "error").length;
      it.label = `Health (${all.length})`;
      it.description = [errors && `${errors} error${errors === 1 ? "" : "s"}`, all.length - errors && `${all.length - errors} warning${all.length - errors === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
      it.iconPath = new vscode.ThemeIcon(errors ? "error" : "warning", new vscode.ThemeColor(errors ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"));
    }
    return it;
  }
  const { problem, scope } = node;
  const rel = path.relative(scope.root, problem.file);
  const it = new vscode.TreeItem(path.basename(problem.file), T.None);
  it.description = problem.message;
  it.tooltip = `${rel.startsWith("..") ? problem.file : rel}: ${problem.message}`;
  it.iconPath = new vscode.ThemeIcon(problem.level === "error" ? "error" : "warning", new vscode.ThemeColor(problem.level === "error" ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"));
  const line = Math.max(0, (problem.line ?? 1) - 1);
  it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(problem.file), { selection: new vscode.Range(line, 0, line, 0) }] };
  return it;
}

/** A file row with problems: error/warning icon, problems in the tooltip. @param {vscode.TreeItem} it @param {Scope["health"]} problems */
function markHealth(it, problems) {
  if (!problems.length) return;
  const error = problems.some((p) => p.level === "error");
  it.iconPath = new vscode.ThemeIcon(error ? "error" : "warning", new vscode.ThemeColor(error ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"));
  const md = /** @type {vscode.MarkdownString | undefined} */ (it.tooltip);
  if (!(md instanceof vscode.MarkdownString)) return;
  md.appendMarkdown(`\n\n${problems.map((p) => `${p.level === "error" ? "$(error)" : "$(warning)"} ${p.message}`).join("\n\n")}`);
  md.supportThemeIcons = true;
}

/**
 * @param {vscode.ExtensionContext} ctx @param {() => string[]} roots
 * @param {() => {edits: number, waiting: number}} counts
 */
function registerSetupView(ctx, roots, counts) {
  const provider = new SetupView(ctx, roots, counts);
  const view = vscode.window.createTreeView("imprimatur.setup", { treeDataProvider: provider, showCollapseAll: true });
  provider.view = view;
  provider.scan();
  // Agent files anywhere in the window: rescan when one changes (debounced).
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @param {vscode.Uri} [uri] */
  const soon = (uri) => {
    // .claude/imprimatur is Imprimatur's own data, written on every agent edit: not setup.
    if (uri?.fsPath.includes(`${path.sep}.claude${path.sep}imprimatur${path.sep}`)) return;
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 500);
  };
  const pattern = "{**/CLAUDE.md,**/CLAUDE.local.md,**/AGENTS.md,**/GEMINI.md,**/CONVENTIONS.md,.claude/**,.cursor/**,.cursorrules,.github/**,.mcp.json,.husky/**,.windsurf/**,.windsurfrules,.clinerules,.clinerules/**,commitlint.config.*,.pre-commit-config.yaml}";
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  ctx.subscriptions.push(
    view,
    watcher,
    watcher.onDidCreate(soon),
    watcher.onDidChange(soon),
    watcher.onDidDelete(soon),
    view.onDidChangeVisibility((e) => e.visible && soon()),
    vscode.window.onDidChangeWindowState((s) => s.focused && view.visible && soon()),
    vscode.commands.registerCommand("imprimatur.setup.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("imprimatur.setup.fixWithClaude", (node) => fixWithClaude(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.showUpstream", (node) => {
      const url = (node ?? view.selection[0])?.item?.compare;
      if (typeof url === "string" && url.startsWith("https://github.com/")) vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("imprimatur.setup.updatePlugin", (node) => updatePlugin((node ?? view.selection[0])?.item)),
    vscode.commands.registerCommand("imprimatur.setup.markSeen", () => provider.markSeen()),
    vscode.commands.registerCommand("imprimatur.setup.compareVariant", (node) => compareVariant(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.explainLastChange", (node) => explainLastChange(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.audit", () => recommendationsMenu(provider)),
    vscode.commands.registerCommand("imprimatur.setup.auditAgent", () => runAudit(provider)),
    vscode.commands.registerCommand("imprimatur.setup.dismissFinding", (node) => setFinding(provider, node ?? view.selection[0], "dropped")),
    vscode.commands.registerCommand("imprimatur.setup.reopenFinding", (node) => setFinding(provider, node ?? view.selection[0], "open")),
    vscode.commands.registerCommand("imprimatur.setup.applyFinding", (node) => setFinding(provider, node ?? view.selection[0], "done")),
  );
  followActiveEditor(ctx, provider);
  return provider;
}

/**
 * "Audit agent setup" (#77): agnix over each repo of the window and the home's agent
 * folders; the findings land in each root's AUDIT task. agnix runs a downloaded binary:
 * not in an untrusted folder.
 * @param {SetupView} provider
 */
async function runAudit(provider) {
  if (!vscode.workspace.isTrusted) return void vscode.window.showInformationMessage("Imprimatur: the audit runs agnix (fetched with npx); trust this folder first.");
  if (provider.auditing) return;
  const db = require("./records.js").dbOf();
  if (!db) return void vscode.window.showErrorMessage(`Imprimatur: no database for the audit records (${require("./records.js").lastError ?? "unknown"}).`);
  const { locateAgnixAsync, runAgnixAsync, explainRulesAsync, auditRoot, pathsOf, describeSummary } = require("./setup-audit.js");
  provider.auditing = true;
  try {
    const lines = await vscode.window.withProgress({ location: { viewId: "imprimatur.setup" }, title: "Auditing the agent setup" }, async () => {
      const bin = await locateAgnixAsync();
      const rules = new Map();
      const out = [];
      for (const s of provider.scopes) {
        const scope = { root: s.root, global: s.global };
        const paths = pathsOf(scope);
        const report = paths.length ? await runAgnixAsync(bin, s.root, { paths }) : { files_checked: 0, diagnostics: [] };
        // Rules explained here, not in auditRoot: its spawnSync would block the extension host.
        await explainRulesAsync(bin, report, rules);
        out.push(describeSummary(auditRoot(db, scope, { bin, rules, report })));
      }
      return out;
    });
    for (const l of lines) console.log(`Imprimatur audit: ${l}`);
    provider.refresh();
    const open = provider.audit?.open ?? 0;
    vscode.window.showInformationMessage(`Imprimatur: agent setup audited, ${open} open recommendation${open === 1 ? "" : "s"}. See Recommendations in Agent setup.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Imprimatur audit failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    provider.auditing = false;
  }
}

/**
 * Dismiss a finding (with why; it never comes back) or reopen one.
 * @param {SetupView} provider @param {any} node @param {"open" | "dropped"} status
 */
async function setFinding(provider, node, status) {
  if (!node?.recordId) return void vscode.window.showInformationMessage("Imprimatur: pick a recommendation first.");
  const db = require("./records.js").dbOf();
  if (!db) return;
  if (await require("./recs-ui.js").setRecommendation(db, node.recordId, status)) provider.refresh();
}

/**
 * The lightbulb (#87): what to run — the agent setup audit (agnix, quick, free), the
 * project review (Claude, a minute or two), or both.
 * @param {SetupView} provider
 */
async function recommendationsMenu(provider) {
  const pick = await vscode.window.showQuickPick([
    { label: "$(hubot) Audit the agent setup", description: "agnix · fast, free", id: "audit" },
    { label: "$(repo) Review the project", description: "Claude · ISO 25010 + NIST SSDF · 1–2 min", id: "review" },
    { label: "$(checklist) Both", id: "both" },
  ], { title: "Recommendations" });
  if (!pick) return;
  if (pick.id !== "review") await runAudit(provider);
  if (pick.id !== "audit") await vscode.commands.executeCommand("imprimatur.bestPractices.run");
}

/** Diff this repo's copy of a drifted file with a variant from another repo (#31). @param {SetupView} provider @param {Node | undefined} node */
async function compareVariant(provider, node) {
  if (node?.type !== "file") return void vscode.window.showInformationMessage("Imprimatur: pick an agent file in Agent setup first.");
  const d = provider.drift.driftFor(node.item.rel, node.item.abs);
  if (!d) return void vscode.window.showInformationMessage(`Imprimatur: ${node.item.rel} is the same in every repo that has it.`);
  const pick =
    d.others.length === 1
      ? d.others[0]
      : (await vscode.window.showQuickPick(d.others.map((v) => ({ label: v.repos.join(", "), description: v.hash.slice(0, 7), v })), { title: `Compare ${node.item.rel} with` }))?.v;
  const other = pick && provider.drift.pathOf(node.item.rel, pick.hash);
  if (!pick || !other) return;
  await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(other), vscode.Uri.file(node.item.abs), `${node.item.rel}: ${pick.repos[0]} ↔ ${node.scope.label}`);
}

/** "Explain last change": one sentence on the file's last commit (#32). @param {SetupView} provider @param {Node | undefined} node */
async function explainLastChange(provider, node) {
  if (node?.type !== "file" || node.scope.global) return void vscode.window.showInformationMessage("Imprimatur: pick an agent file of a repo in Agent setup first.");
  const { root } = node.scope;
  if (!provider.history.info(root, node.item.rel)) return void vscode.window.showInformationMessage(`Imprimatur: ${node.item.rel} is not committed yet.`);
  if (!provider.history.explained(root, node.item.rel) && !vscode.workspace.isTrusted)
    return void vscode.window.showInformationMessage("Imprimatur: explaining a change asks a model (claude); trust this folder first.");
  const text = await vscode.window.withProgress({ location: { viewId: "imprimatur.setup" } }, () => provider.history.explain(root, node.item.rel));
  provider.changed.fire(undefined);
  vscode.window.showInformationMessage(text ? `${node.item.label}: ${text}` : `Imprimatur: could not explain the last change of ${node.item.rel}.`);
}

/**
 * "For <file>" follows the active editor (debounced: switching tabs fast
 * redraws once). Only files on disk count.
 * @param {vscode.ExtensionContext} ctx @param {SetupView} provider
 */
function followActiveEditor(ctx, provider) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const update = () => {
    const doc = vscode.window.activeTextEditor?.document;
    const file = doc?.uri.scheme === "file" ? doc.uri.fsPath : undefined;
    if (file === provider.activeFile) return;
    provider.activeFile = file;
    provider.changed.fire(undefined);
  };
  update();
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      clearTimeout(timer);
      timer = setTimeout(update, 300);
    }),
    { dispose: () => clearTimeout(timer) },
  );
}

module.exports = { registerSetupView };
