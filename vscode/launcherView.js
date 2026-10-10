// @ts-check
// The Imprimatur side bar's launcher (#69): rows that open the Imprimatur panel
// on a tab: Ana sayfa, Görevler, Bende bekleyenler (with what waits on the user)
// and Ajan değişiklikleri (edits under review). Its badge counts what waits on
// the user, as the old "Waiting on me" view's did.
"use strict";
const vscode = require("vscode");

/** @typedef {{edits: number, inbox: number}} Counts */

const ROWS = [
  { id: "home", label: "Ana sayfa", icon: "home", command: "imprimatur.openHome", tooltip: "Nerede kaldık, senden beklenenler, görevler" },
  { id: "tasks", label: "Görevler", icon: "checklist", command: "imprimatur.openTasks", tooltip: "Görevler ve kayıtları" },
  { id: "inbox", label: "Bende bekleyenler", icon: "bell", command: "imprimatur.openInbox", tooltip: "Ajanın senden beklediği her şey" },
  { id: "edits", label: "Ajan değişiklikleri", icon: "git-merge", command: "imprimatur.openGraph", tooltip: "Agent Change Graph: ajanın düzenlemeleri" },
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
    if (this.view) this.view.badge = n ? { value: n, tooltip: `${n} bende bekliyor` } : undefined;
    this.changed.fire(undefined);
  }

  getChildren() {
    return ROWS;
  }

  /** @param {typeof ROWS[number]} row */
  getTreeItem(row) {
    const label = row.id === "inbox" && this.now.inbox ? `${row.label} (${this.now.inbox})` : row.label;
    const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    it.id = row.id;
    it.iconPath = new vscode.ThemeIcon(row.icon, row.id === "inbox" && this.now.inbox ? new vscode.ThemeColor("charts.orange") : undefined);
    it.tooltip = row.tooltip;
    if (row.id === "edits" && this.now.edits) it.description = `${this.now.edits} incelemede`;
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
