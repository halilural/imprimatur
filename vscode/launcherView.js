// @ts-check
// The Imprimatur side bar's launcher (#69): the Imprimatur panel's navigation, in VS Code's own tree
// (the panel has none of its own): Home (with what waits on the user), Tasks, Docs and its documents,
// Agent changes (edits under review), the setup checklist, then Exercises, Meetings and Social. Its
// badge counts what waits on the user, as the old "Waiting on me" view's did.
"use strict";
const vscode = require("vscode");

/** @typedef {Record<"question" | "todo" | "test" | "turn" | "doneTasks", Array<{id?: number, title: string, task?: string}>>} Parts */
/** @typedef {{edits: number, inbox: number, parts?: Parts}} Counts */

// Under Home: what its count is made of, item by item, so the number reads without
// opening the panel. The first four add up to it; "on done tasks" is part of them,
// asks a finished task left behind.
const PARTS = [
  { key: "question", label: "Questions", icon: "comment-discussion", tooltip: "The agent is stopped on a decision" },
  { key: "todo", label: "To-dos", icon: "checklist", tooltip: "Steps for you to do" },
  { key: "test", label: "Manual tests", icon: "eye", tooltip: "Things to check by eye" },
  { key: "turn", label: "Turn-end asks", icon: "bell", tooltip: "Asks left at the end of an agent turn, not yet saved as records" },
  { key: "doneTasks", label: "On done tasks", icon: "archive", tooltip: "Of the above: asks still open on tasks already done; close or drop them" },
];

const APP = "imprimatur.app.open";
const ROWS = [
  { id: "home", label: "Home", icon: "home", command: APP, args: { area: "home" }, tooltip: "What waits on you, what is in progress, what finished this week" },
  { id: "tasks", label: "Tasks", icon: "tasklist", command: APP, args: { area: "tasks" }, tooltip: "Active first, then open, then the last done" },
  { id: "docs", label: "Docs", icon: "book", command: APP, args: { area: "docs" }, tooltip: "Project, capabilities, ADRs, glossary, out of scope, wiki" },
  { id: "edits", label: "Agent changes", icon: "git-merge", command: APP, args: { area: "edits" }, tooltip: "The agent's edits waiting for your review" },
  { id: "checklist", label: "Setup checklist", icon: "checklist", command: "imprimatur.setup.focus", tooltip: "What needs doing in the agent setup: updates, upstream changes, problems, recommendations (#142)" },
  { id: "exercises", label: "Exercises", icon: "mortar-board", command: APP, args: { area: "exercises" }, tooltip: "Topics in small steps you tick (/exercise)" },
  { id: "meetings", label: "Meetings", icon: "organization", command: APP, args: { area: "meetings" }, tooltip: "What was decided and what you took on" },
  { id: "social", label: "Social", icon: "megaphone", command: APP, args: { area: "social" }, tooltip: "Posts written for each platform (/social-post)", social: true },
];
const DOC_ICONS = { project: "project", capabilities: "symbol-module", adrs: "law", glossary: "symbol-key", "out-of-scope": "circle-slash", wiki: "notebook" };

/** Social shows only where it is on (#109), like the panel's page. */
function socialOn() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    return !!root && require("./docs-export.js").socialOn(root);
  } catch {
    return false;
  }
}

/**
 * While the view is hidden (#114), a refresh counts only the badge; the full counts (the
 * edits under review, which also keep the status line's count fresh) run at most this often.
 */
const HIDDEN_FULL_MS = 60_000;

class LauncherView {
  /** @param {() => Counts} counts @param {{inbox?: () => number, now?: () => number}} [o] inbox: the badge's count alone, cheap */
  constructor(counts, { inbox, now = Date.now } = {}) {
    this.counts = counts;
    this.inbox = inbox;
    this.clock = now;
    /** When the full counts last ran (0: never). */
    this.fullAt = 0;
    /** A hidden refresh skipped the full counts: run them when the view shows. */
    this.stale = false;
    /** @type {Counts} */
    this.now = { edits: 0, inbox: 0 };
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    /** @type {vscode.TreeView<any> | undefined} */
    this.view = undefined;
    /** Open items in Agent Setup's checklist (#142), set by the setup view after each scan. */
    this.checklist = 0;
  }

  /** @param {number} n */
  setChecklist(n) {
    if (n === this.checklist) return;
    this.checklist = n;
    this.changed.fire(undefined);
  }

  /** Counts again, redraws, sets the badge. @param {number} [inbox] the badge's count, when the caller has it */
  refresh(inbox) {
    const hidden = this.view !== undefined && !this.view.visible;
    try {
      if (hidden && this.clock() - this.fullAt < HIDDEN_FULL_MS) {
        this.now = { ...this.now, inbox: inbox ?? this.inbox?.() ?? this.now.inbox };
        this.stale = true;
        if (this.view) this.view.badge = this.now.inbox ? { value: this.now.inbox, tooltip: `${this.now.inbox} waiting on you` } : undefined;
        return;
      }
      this.catchUp();
    } catch {
      // the database or a log being written: the next change catches up
    }
    const n = this.now.inbox;
    if (this.view) this.view.badge = n ? { value: n, tooltip: `${n} waiting on you` } : undefined;
    this.changed.fire(undefined);
  }

  /** The full counts now: a hidden refresh skipped them. */
  catchUp() {
    try {
      this.now = this.counts();
      this.fullAt = this.clock();
      this.stale = false;
    } catch {
      // the next change catches up
    }
  }

  /** @param {any} [row] */
  getChildren(row) {
    // Drawn (or read) after hidden refreshes: the rows match the badge.
    if (!row && this.stale) this.catchUp();
    if (!row) return ROWS.filter((r) => !r.social || socialOn());
    if (row.id === "docs") return require("./app/model.js").DOCS.map((/** @type {any} */ d) => ({ id: `docs.${d.id}`, label: d.label, icon: /** @type {any} */ (DOC_ICONS)[d.id] ?? "file", command: APP, args: { area: "docs", doc: d.id }, leaf: true }));
    const parts = this.now.parts;
    if (!parts) return [];
    if (row.id === "home") return PARTS.filter((p) => parts[/** @type {keyof Parts} */ (p.key)].length).map((p) => ({ ...p, id: `home.${p.key}`, items: parts[/** @type {keyof Parts} */ (p.key)] }));
    if (row.items) return row.items.map((/** @type {any} */ i, /** @type {number} */ k) => ({ title: i.title, task: i.task, rec: i.id, item: true, id: `${row.id}.${i.id ?? `t${k}`}` }));
    return [];
  }

  /** @param {any} row */
  getTreeItem(row) {
    if (row.item) {
      const one = new vscode.TreeItem(row.title, vscode.TreeItemCollapsibleState.None);
      one.id = row.id;
      one.description = row.task;
      one.tooltip = row.task ? `${row.task}: ${row.title}` : row.title;
      // A record opens its page; a turn-end ask has none, Home shows it.
      one.command = row.rec
        ? { command: "imprimatur.records.show", title: "Open", arguments: [{ record: { id: row.rec } }] }
        : { command: "imprimatur.openHome", title: "Home" };
      return one;
    }
    if (row.items) {
      const part = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.Collapsed);
      part.id = row.id;
      part.description = String(row.items.length);
      part.iconPath = new vscode.ThemeIcon(row.icon);
      part.tooltip = row.tooltip;
      return part;
    }
    const label = row.id === "home" && this.now.inbox ? `${row.label} (${this.now.inbox})` : row.label;
    const open = row.id === "home" && this.now.inbox > 0;
    const it = new vscode.TreeItem(label, open ? vscode.TreeItemCollapsibleState.Expanded : row.id === "docs" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    it.id = row.id;
    it.iconPath = new vscode.ThemeIcon(row.icon, row.id === "home" && this.now.inbox ? new vscode.ThemeColor("charts.orange") : undefined);
    it.tooltip = row.tooltip;
    if (row.id === "edits" && this.now.edits) it.description = `${this.now.edits} under review`;
    if (row.id === "checklist") it.description = this.checklist ? `${this.checklist} to do` : "nothing to do";
    it.command = { command: row.command, title: row.label, ...(row.args && { arguments: [row.args] }) };
    return it;
  }
}

/** @param {vscode.ExtensionContext} ctx @param {() => Counts} counts @param {() => number} [inbox] the badge's count alone */
function registerLauncher(ctx, counts, inbox) {
  const provider = new LauncherView(counts, { inbox });
  provider.view = vscode.window.createTreeView("imprimatur.launcher", { treeDataProvider: provider });
  // Counts skipped while hidden are caught up when it shows.
  ctx.subscriptions.push(provider.view.onDidChangeVisibility((e) => e.visible && provider.stale && provider.refresh()));
  // Which build runs here, next to the view's title: two machines can run different ones.
  provider.view.description = `v${ctx.extension.packageJSON.version}`;
  ctx.subscriptions.push(provider.view);
  provider.refresh();
  return provider;
}

module.exports = { registerLauncher, LauncherView, ROWS, PARTS, HIDDEN_FULL_MS };
