// @ts-check
// The Imprimatur side bar's launcher (#69): rows that open the Imprimatur panel
// on a tab: Home, Tasks, Waiting on you (with what waits on the user),
// Architecture and Product (the design documents, #72) and Agent changes (edits under review). Its badge counts what waits on
// the user, as the old "Waiting on me" view's did.
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

const ROWS = [
  { id: "home", label: "Home", icon: "home", command: "imprimatur.openHome", tooltip: "Where we left off, what is waiting on you, tasks" },
  { id: "tasks", label: "Tasks", icon: "checklist", command: "imprimatur.openTasks", tooltip: "Tasks and their records" },
  { id: "architecture", label: "Architecture", icon: "symbol-structure", command: "imprimatur.openArchitecture", tooltip: "Architecture design document: how it is built" },
  { id: "product", label: "Product", icon: "package", command: "imprimatur.openProduct", tooltip: "Product design document: what the user gets" },
  { id: "glossary", label: "Glossary", icon: "book", command: "imprimatur.openGlossary", tooltip: "Project glossary: terms and their meanings" },
  { id: "edits", label: "Agent changes", icon: "git-merge", command: "imprimatur.openGraph", tooltip: "Agent Change Graph: the agent's edits" },
];

class LauncherView {
  /** @param {() => Counts} counts */
  constructor(counts) {
    this.counts = counts;
    /** @type {Counts} */
    this.now = { edits: 0, inbox: 0 };
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    /** @type {vscode.TreeView<any> | undefined} */
    this.view = undefined;
  }

  /** Counts again, redraws, sets the badge. */
  refresh() {
    try {
      this.now = this.counts();
    } catch {
      // the database or a log being written: the next change catches up
    }
    const n = this.now.inbox;
    if (this.view) this.view.badge = n ? { value: n, tooltip: `${n} waiting on you` } : undefined;
    this.changed.fire(undefined);
  }

  /** @param {any} [row] */
  getChildren(row) {
    if (!row) return ROWS;
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
    const it = new vscode.TreeItem(label, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    it.id = row.id;
    it.iconPath = new vscode.ThemeIcon(row.icon, row.id === "home" && this.now.inbox ? new vscode.ThemeColor("charts.orange") : undefined);
    it.tooltip = row.tooltip;
    if (row.id === "edits" && this.now.edits) it.description = `${this.now.edits} under review`;
    it.command = { command: row.command, title: row.label };
    return it;
  }
}

/** @param {vscode.ExtensionContext} ctx @param {() => Counts} counts */
function registerLauncher(ctx, counts) {
  const provider = new LauncherView(counts);
  provider.view = vscode.window.createTreeView("imprimatur.launcher", { treeDataProvider: provider });
  ctx.subscriptions.push(provider.view);
  provider.refresh();
  return provider;
}

module.exports = { registerLauncher, LauncherView, ROWS, PARTS };
