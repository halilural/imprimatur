// @ts-check
// The Imprimatur side bar (activity bar icon): a link to the Agent Change
// Graph on top, then "Agent setup": every file that shapes the agent, per repo
// and global, grouped by tool, marked new / changed / removed since the user
// last looked (Mark all as seen). Read only: it never edits the files.
"use strict";
const vscode = require("vscode");
const os = require("node:os");
const path = require("node:path");
const { scanSetup, changesSince, snapshotOf } = require("./agent-setup.js");
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
 *   | {type: "removed", scope: Scope, rel: string} | PlainNode} Node
 * @typedef {{type: "group" | "leaf", label: string, description?: string, tooltip?: string, icon?: string, abs?: string, children?: any[]}} PlainNode
 *   "For <file>" and "Effective settings" rows, built by setup-scope.js / setup-merged.js
 * @typedef {{id: string, label: string, root: string, global: boolean, merged?: ReturnType<typeof mergeSettings>,
 *   items: Array<ReturnType<typeof scanSetup>[number] & {scope?: {label: string}}>, state: Record<string, string>, removed: string[]}} Scope
 */

/** A plain group / leaf row. @param {PlainNode} node @returns {vscode.TreeItem} */
function plainItem(node) {
  const T = vscode.TreeItemCollapsibleState;
  const it = new vscode.TreeItem(node.label, node.type === "group" ? (node.label.startsWith("For ") ? T.Expanded : T.Collapsed) : T.None);
  it.description = node.description;
  it.tooltip = node.tooltip;
  if (node.icon) it.iconPath = new vscode.ThemeIcon(node.icon);
  if (node.type === "leaf" && node.abs) it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(node.abs)] };
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
    /** @type {vscode.TreeView<Node> | undefined} */
    this.view = undefined;
    this.graph = { edits: 0, waiting: 0 };
    /** @type {string | undefined} the active editor's file, for "For <file>" */
    this.activeFile = undefined;
  }

  /** Rescan every scope (cheap: a folder walk and small reads). */
  scan() {
    this.graph = this.counts();
    const seen = /** @type {Record<string, Record<string, string>>} */ (this.ctx.globalState.get(SEEN_KEY) ?? {});
    const home = os.homedir();
    const defs = [...this.roots().map((r) => ({ id: r, label: path.basename(r), root: r, global: false })), { id: "~", label: "Global (~)", root: home, global: true }];
    this.scopes = defs.map((d) => {
      const items = withScopes(scanSetup(d.root, { global: d.global }), { global: d.global });
      // First look at a scope: remember it, mark nothing.
      if (!seen[d.id]) {
        seen[d.id] = snapshotOf(items);
        this.ctx.globalState.update(SEEN_KEY, seen);
      }
      const merged = d.global ? undefined : mergeSettings(readSources({ root: d.root, home }));
      return { ...d, items, merged, ...changesSince(items, seen[d.id]) };
    });
    const fresh = this.scopes.reduce((n, s) => n + Object.keys(s.state).length + s.removed.length, 0);
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
      return [{ type: "graph" }, ...(forFile ? [/** @type {Node} */ (forFile)] : []), ...this.scopes.map((scope) => /** @type {Node} */ ({ type: "scope", scope }))];
    }
    if (node.type === "group") return node.children;
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
    if (node.type === "file") return node.item.details.map((text) => ({ type: "detail", text }));
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
      const it = new vscode.TreeItem(item.label, item.details.length ? T.Collapsed : T.None);
      // When it applies (#28), unless the summary already says it (.mdc).
      const when = item.scope && !item.summary.startsWith(item.scope.label) ? `${item.scope.label} · ` : "";
      it.description = `${state ? `${state} · ` : ""}${when}${item.summary}`;
      it.tooltip = new vscode.MarkdownString(`**${item.rel}** · ${item.tool} ${item.kind}${state ? ` · _${state} since you last looked_` : ""}\n\n${item.summary}`);
      it.iconPath = state
        ? new vscode.ThemeIcon(KIND_ICONS[item.kind] ?? "file", new vscode.ThemeColor(state === "new" ? "gitDecoration.addedResourceForeground" : "gitDecoration.modifiedResourceForeground"))
        : new vscode.ThemeIcon(KIND_ICONS[item.kind] ?? "file");
      it.resourceUri = vscode.Uri.file(item.abs);
      it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(item.abs)] };
      return it;
    }
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
    vscode.commands.registerCommand("imprimatur.setup.markSeen", () => provider.markSeen()),
  );
  followActiveEditor(ctx, provider);
  return provider;
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
