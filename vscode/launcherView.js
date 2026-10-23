// @ts-check
// The Imprimatur side bar's launcher (#69): rows that open the Imprimatur panel
// on a tab: Home, Tasks, Waiting on you (with what waits on the user),
// Architecture and Product (the design documents, #72) and Agent changes (edits under review). Its badge counts what waits on
// the user, as the old "Waiting on me" view's did.
"use strict";
const vscode = require("vscode");

/** @typedef {{edits: number, inbox: number}} Counts */

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

  getChildren() {
    return ROWS;
  }

  /** @param {typeof ROWS[number]} row */
  getTreeItem(row) {
    // What waits on the user counts on Home (no Waiting on you row): asks are on their task pages.
    const label = row.id === "home" && this.now.inbox ? `${row.label} (${this.now.inbox})` : row.label;
    const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
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

module.exports = { registerLauncher, LauncherView, ROWS };
