// @ts-check
// The Imprimatur side bar's launcher (#69): the Imprimatur panel's navigation, in VS Code's own tree
// (the panel has none of its own): Home (with what waits on the user), Tasks (by status), Docs and its documents,
// Agent changes (edits under review), the setup checklist, then Exercises, Meetings and Social. Its
// badge counts what waits on the user, as the old "Waiting on me" view's did.
"use strict";
const vscode = require("vscode");

/** @typedef {Record<"question" | "todo" | "test" | "turn" | "doneTasks", Array<{id?: number, title: string, task?: string}>>} Parts */
/** @typedef {Array<{id: string, label: string, tasks: Array<{key: string, title: string, summary?: string}>}>} TaskLists */
/** @typedef {{edits: number, inbox: number, parts?: Parts, tasks?: TaskLists}} Counts */

// Under Home: what its count is made of, item by item, so the number reads without
// opening the panel. The first three add up to it; "on done tasks" is part of them,
// asks a finished task left behind.
const PARTS = [
  { key: "question", label: "Questions for you", icon: "comment-discussion", tooltip: "Decisions the agent waits on: answer them in the chat" },
  { key: "todo", label: "Your to-dos", icon: "checklist", tooltip: "Steps only you can do, from records and from the end of agent turns" },
  { key: "test", label: "Manual tests", icon: "eye", tooltip: "Things to check by eye" },
  { key: "doneTasks", label: "On done tasks", icon: "archive", tooltip: "Of the above: asks still open on tasks already done; close or drop them" },
];

const APP = "imprimatur.app.open";
const ROWS = [
  { id: "home", label: "Home", icon: "home", command: APP, args: { area: "home" }, tooltip: "What waits on you: questions, your to-dos, manual tests" },
  { id: "tasks", label: "Tasks", icon: "tasklist", command: APP, args: { area: "tasks" }, tooltip: "The project's work items (issues), by status: active, open, the last done" },
  { id: "docs", label: "Docs", icon: "book", command: APP, args: { area: "docs" }, tooltip: "Project, capabilities, ADRs, glossary, out of scope, wiki" },
  { id: "edits", label: "Agent changes", icon: "git-merge", command: APP, args: { area: "edits" }, tooltip: "The agent's edits waiting for your review" },
  { id: "checklist", label: "Setup checklist", icon: "checklist", command: "imprimatur.setup.focus", tooltip: "What needs doing in the agent setup: updates, upstream changes, problems, recommendations (#142)" },
  { id: "exercises", label: "Exercises", icon: "mortar-board", command: APP, args: { area: "exercises" }, tooltip: "Topics in small steps you tick (/exercise)" },
  { id: "meetings", label: "Meetings", icon: "organization", command: APP, args: { area: "meetings" }, tooltip: "What was decided and what you took on" },
  { id: "social", label: "Social", icon: "megaphone", command: APP, args: { area: "social" }, tooltip: "Posts written for each platform (/social-post)", social: true },
];
const TASK_ICONS = { active: "play-circle", open: "circle-large-outline", done: "pass" };
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
    if (row.id === "tasks") return (this.now.tasks ?? []).filter((l) => l.tasks.length).map((l) => ({ id: `tasks.${l.id}`, label: l.label, icon: TASK_ICONS[/** @type {keyof typeof TASK_ICONS} */ (l.id)], open: l.id === "active", items: l.tasks.map((t) => ({ id: t.key, title: t.title, task: t.key, key: t.key, tip: t.summary })) }));
    const parts = this.now.parts;
    if (row.items) return row.items.map((/** @type {any} */ i, /** @type {number} */ k) => ({ title: i.title, task: i.task, rec: i.key ? undefined : i.id, key: i.key, tip: i.tip, item: true, id: `${row.id}.${i.id ?? `t${k}`}` }));
    if (!parts) return [];
    if (row.id === "home") return PARTS.filter((p) => parts[/** @type {keyof Parts} */ (p.key)].length).map((p) => ({ ...p, id: `home.${p.key}`, items: parts[/** @type {keyof Parts} */ (p.key)] }));
    return [];
  }

  /**
   * A row's parent, so the view can open groups (reveal) before the in-tree find: ids are
   * "home", "home.todo", "home.todo.<record>"; a group's parent is its top row, an item's its group.
   * @param {any} row
   */
  getParent(row) {
    const id = String(row?.id ?? "");
    if (ROWS.some((r) => r.id === id)) return undefined;
    const top = ROWS.find((r) => id.startsWith(`${r.id}.`));
    if (!top) return undefined;
    if (!row.item) return top;
    return this.getChildren(top).find((/** @type {any} */ g) => id.startsWith(`${g.id}.`)) ?? top;
  }

  /**
   * Find in the view itself (VS Code's own find, not the search box at the top of the window):
   * Home's and Tasks' groups are opened first, since the find only sees rows that are loaded.
   */
  async findHere() {
    if (!this.view) return;
    for (const top of ROWS.filter((r) => r.id === "home" || r.id === "tasks"))
      for (const g of this.getChildren(top)) await this.view.reveal(g, { expand: true, select: false, focus: false }).then(undefined, () => {});
    await vscode.commands.executeCommand("imprimatur.launcher.focus");
    await vscode.commands.executeCommand("list.find");
  }

  /** @param {any} row */
  getTreeItem(row) {
    if (row.item) {
      const one = new vscode.TreeItem(row.title, vscode.TreeItemCollapsibleState.None);
      one.id = row.id;
      // Right click: hand it to Claude Code, or copy a reference to paste into a chat.
      one.contextValue = "imprimaturItem";
      one.description = row.task;
      one.tooltip = (row.task ? `${row.task}: ${row.title}` : row.title) + (row.tip ? `\n${row.tip}` : "");
      // A task opens its page, a record its page; a turn-end ask has none, Home shows it.
      one.command = row.key
        ? { command: APP, title: "Open", arguments: [{ area: "tasks", task: row.key }] }
        : row.rec
        ? { command: "imprimatur.records.show", title: "Open", arguments: [{ record: { id: row.rec } }] }
        : { command: "imprimatur.openHome", title: "Home" };
      return one;
    }
    if (row.items) {
      const part = new vscode.TreeItem(row.label, row.open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      part.id = row.id;
      part.description = String(row.items.length);
      part.iconPath = new vscode.ThemeIcon(row.icon);
      part.tooltip = row.tooltip;
      return part;
    }
    const label = row.id === "home" && this.now.inbox ? `${row.label} (${this.now.inbox})` : row.label;
    const open = row.id === "home" && this.now.inbox > 0;
    const it = new vscode.TreeItem(label, open ? vscode.TreeItemCollapsibleState.Expanded : row.id === "docs" || row.id === "tasks" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    it.id = row.id;
    it.iconPath = new vscode.ThemeIcon(row.icon, row.id === "home" && this.now.inbox ? new vscode.ThemeColor("charts.orange") : undefined);
    it.tooltip = row.tooltip;
    if (row.id === "edits" && this.now.edits) it.description = `${this.now.edits} under review`;
    if (row.id === "checklist") it.description = this.checklist ? `${this.checklist} to do` : "nothing to do";
    it.command = { command: row.command, title: row.label, ...(row.args && { arguments: [row.args] }) };
    return it;
  }
}

/** How a row is named to Claude: "Imprimatur #157, record 9535: <title>". @param {any} row */
const refOf = (row) => `Imprimatur ${[row.task ?? row.key, row.rec ? `record ${row.rec}` : ""].filter(Boolean).join(", ")}: ${row.title}`.replace(/^Imprimatur : /, "Imprimatur: ");

/** The prompt that asks Claude Code to handle a row. @param {any} row */
const askOf = (row) => `Handle this: ${refOf(row)}.${row.task ?? row.key ? " Read it first with the imprimatur MCP tools (task_get), then do it." : ""}`;

/**
 * Puts text into the open Claude Code chat's input: Claude Code has no command that types into it,
 * so the text goes through the clipboard, the input is focused and VS Code's paste is handed to it.
 * Without an open chat, a new one opens with the text typed in. The text stays on the clipboard.
 * @param {string} text @returns {Promise<boolean>} whether it went into a chat
 */
async function intoChat(text) {
  await vscode.env.clipboard.writeText(text);
  try {
    await vscode.commands.executeCommand("claude-vscode.focus");
    await new Promise((r) => setTimeout(r, 150));
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    return true;
  } catch {}
  try {
    await vscode.commands.executeCommand("claude-vscode.editor.open", undefined, text);
    return true;
  } catch {
    vscode.window.showInformationMessage("Imprimatur: copied; paste it into Claude Code (the Claude Code extension did not open).");
    return false;
  }
}

/**
 * The possibly stale documents (#211), from Agent Setup's checklist row: pick one to have Claude
 * check it against the code, or mark it reviewed; or mark them all reviewed (a first run flags
 * every old part whose code moved on).
 */
async function pickStale() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const records = require("./records.js");
  const db = records.dbOf();
  const repo = root && db?.repoByRoot(root);
  if (!repo) return;
  const stale = require("./stale-docs.js");
  const parts = stale.staleParts(db, repo, root);
  if (!parts.length) return void vscode.window.showInformationMessage("Imprimatur: no document is stale.");
  const uidOf = (/** @type {any} */ p) => db.q(`SELECT uid FROM ${p.kind === "section" ? "doc_sections" : "records"} WHERE id = ?`).get(p.id)?.uid;
  const ALL = { label: `$(check-all) Mark all ${parts.length} reviewed`, all: true };
  const items = parts.map((p) => ({ label: p.title, description: `${p.kind === "section" ? p.doc : p.kind}${p.task ? ` · ${p.task}` : ""} · ${p.commits.length} commit${p.commits.length === 1 ? "" : "s"}`, detail: p.files.join(", "), part: p }));
  const got = /** @type {any} */ (await vscode.window.showQuickPick([ALL, ...items], { title: "Possibly stale documents: their code changed since they were written", matchOnDescription: true, matchOnDetail: true }));
  if (!got) return;
  if (got.all) {
    const ok = await vscode.window.showWarningMessage(`Mark all ${parts.length} reviewed? They come back when their code changes again.`, { modal: true }, "Mark reviewed");
    if (ok) for (const p of parts) stale.markReviewed(db, uidOf(p));
    return;
  }
  const p = got.part;
  const what = p.kind === "section" ? `the ${p.doc}${p.task ? ` ${p.task}` : ""} section "${p.title}"` : `${p.kind} ${p.id} (${p.task}): ${p.title}`;
  const act = await vscode.window.showQuickPick([{ label: "$(sparkle) Ask Claude to check it against the code", ask: true }, { label: "$(check) Mark reviewed" }], { title: p.title });
  if (!act) return;
  if (!(/** @type {any} */ (act)).ask) return void stale.markReviewed(db, uidOf(p));
  await intoChat(`Check whether ${what} still holds: ${p.files.join(", ")} changed in ${p.commits.length} commit(s) since it was written (newest: ${p.commits[0].hash} ${p.commits[0].subject}). Read it with the imprimatur MCP tools, read the change (git log/diff on those files), and update it with ${p.kind === "section" ? "doc_section_upsert" : "record_update"}: correct it if it no longer holds, or add one line \"Checked against <commit>: still holds.\" if it does (any edit clears the flag).`);
}

/** @param {vscode.ExtensionContext} ctx @param {() => Counts} counts @param {() => number} [inbox] the badge's count alone */
function registerLauncher(ctx, counts, inbox) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("imprimatur.launcher.askClaude", (/** @type {any} */ row) => row?.title && intoChat(askOf(row))),
    vscode.commands.registerCommand("imprimatur.staleDocs", () => pickStale()),
    vscode.commands.registerCommand("imprimatur.launcher.find", () => provider.findHere()),
    vscode.commands.registerCommand("imprimatur.launcher.copyRef", async (/** @type {any} */ row) => {
      if (!row?.title) return;
      if (await intoChat(refOf(row))) vscode.window.setStatusBarMessage("Imprimatur: reference added to the Claude Code chat (also on the clipboard)", 4000);
    }),
  );
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

module.exports = { registerLauncher, LauncherView, ROWS, PARTS, HIDDEN_FULL_MS, refOf, askOf };
