// @ts-check
// Record views in the Imprimatur sidebar (#60): what waits on the user across
// repos, tasks (repo → task → records, 👉 first), questions, decisions, ADRs
// and PDRs, from Imprimatur's database (vscode/records.js). Right-click marks
// done, reopens, drops, moves the 👉, edits the title (an input box), adds a
// record; a record opens as a read-only Markdown page with its history. The
// views follow the database file: any writer (an agent through MCP, a hook,
// another window) shows up at once; nothing polls.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const records = require("./records.js");

const SCHEME = "imprimatur-record";
const USER = { kind: /** @type {"user"} */ ("user"), id: os.userInfo().username };

/** Icon per kind and status. @param {any} r */
function iconOf(r) {
  if (r.pointer) return new vscode.ThemeIcon("arrow-right", new vscode.ThemeColor("charts.orange"));
  if (r.status === "dropped") return new vscode.ThemeIcon("circle-slash");
  const done = r.status === "done";
  switch (r.kind) {
    case "question": return new vscode.ThemeIcon(done ? "comment-discussion" : "question", done ? undefined : new vscode.ThemeColor("charts.yellow"));
    case "answer": return new vscode.ThemeIcon("reply");
    case "decision": return new vscode.ThemeIcon("law");
    case "note": return new vscode.ThemeIcon("note");
    case "adr": return new vscode.ThemeIcon("symbol-structure");
    case "pdr": return new vscode.ThemeIcon("lightbulb");
    case "test": return new vscode.ThemeIcon("beaker");
    case "fixme": return new vscode.ThemeIcon(done ? "pass" : "bug", done ? new vscode.ThemeColor("testing.iconPassed") : new vscode.ThemeColor("charts.red"));
    default: return new vscode.ThemeIcon(done ? "pass-filled" : "circle-large-outline", done ? new vscode.ThemeColor("testing.iconPassed") : undefined);
  }
}

const TASK_ICON = { open: "issues", active: "play-circle", done: "issue-closed", dropped: "circle-slash" };

/**
 * One view. mode: asks (the user's open records, every repo), tasks, or a list
 * of record kinds (questions, decisions, adr, pdr), grouped by repo.
 */
class RecordsView {
  /** @param {"asks" | "tasks" | "kinds"} mode @param {string[]} [kinds] @param {() => string[]} [workspaceRoots] */
  constructor(mode, kinds = [], workspaceRoots = () => []) {
    this.mode = mode;
    this.kinds = kinds;
    this.workspaceRoots = workspaceRoots;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    /** @type {Map<string, any>} id → node, for reveal and getParent */
    this.nodes = new Map();
  }

  refresh() {
    this.changed.fire(undefined);
  }

  /** Repos, those open in this window first. */
  repos() {
    const db = records.dbOf();
    if (!db) return [];
    const here = new Set(this.workspaceRoots());
    return db.repos().sort((a, b) => Number(here.has(b.root)) - Number(here.has(a.root)));
  }

  /** @param {any} node */
  keep(node) {
    this.nodes.set(node.id, node);
    return node;
  }

  /** @param {any} [node] */
  getChildren(node) {
    const db = records.dbOf();
    if (!db) return [{ id: "error", type: "message", text: `Imprimatur database: ${records.lastError ?? "not available"}` }];
    if (!node) {
      if (this.mode === "asks") {
        const repos = new Map(db.repos().map((r) => [r.id, r]));
        const asks = db.openAsks({ limit: 200 });
        if (!asks.length) return [{ id: "empty", type: "message", text: "Nothing waits on you." }];
        return asks.map((r) => this.keep({ id: `r${r.id}`, type: "record", record: r, repo: repos.get(r.repo_id), showTask: true }));
      }
      const repos = this.repos();
      if (!repos.length) return [{ id: "empty", type: "message", text: "No records yet: agents add them through Imprimatur's MCP tools." }];
      return repos.map((repo) => this.keep({ id: `${this.mode}:repo${repo.id}`, type: "repo", repo }));
    }
    if (node.type === "repo" && this.mode === "tasks") {
      const tasks = db.tasksOf(node.repo.id, { limit: 1000 });
      const live = tasks.filter((t) => t.status === "open" || t.status === "active");
      const closed = tasks.filter((t) => t.status === "done" || t.status === "dropped");
      return [
        ...live.map((task) => this.keep({ id: `task${task.id}`, type: "task", task, repo: node.repo, parent: node })),
        ...(closed.length ? [this.keep({ id: `closed${node.repo.id}`, type: "closed", tasks: closed, repo: node.repo, parent: node })] : []),
      ];
    }
    if (node.type === "closed") return node.tasks.map((task) => this.keep({ id: `task${task.id}`, type: "task", task, repo: node.repo, parent: node }));
    if (node.type === "task") {
      const list = db.recordsOf(node.task.id);
      // 👉 first: where the work stopped.
      list.sort((a, b) => Number(b.pointer) - Number(a.pointer));
      return list.map((record) => this.keep({ id: `r${record.id}`, type: "record", record, repo: node.repo, parent: node }));
    }
    if (node.type === "repo") {
      const list = db.recordsByKind(node.repo.id, this.kinds);
      if (this.kinds.includes("question")) {
        const open = list.filter((r) => r.status === "open");
        const answered = list.filter((r) => r.status !== "open");
        return [
          ...open.map((record) => this.keep({ id: `${this.mode}:r${record.id}`, type: "record", record, repo: node.repo, parent: node, showTask: true })),
          ...(answered.length ? [this.keep({ id: `${this.mode}:answered${node.repo.id}`, type: "group", label: `Answered (${answered.length})`, list: answered, repo: node.repo, parent: node })] : []),
        ];
      }
      return list.map((record) => this.keep({ id: `${this.mode}:r${record.id}`, type: "record", record, repo: node.repo, parent: node, showTask: true }));
    }
    if (node.type === "group") return node.list.map((record) => this.keep({ id: `${this.mode}:g${record.id}`, type: "record", record, repo: node.repo, parent: node, showTask: true }));
    return [];
  }

  /** @param {any} node */
  getParent(node) {
    return node.parent;
  }

  /** @param {any} node */
  getTreeItem(node) {
    const C = vscode.TreeItemCollapsibleState;
    if (node.type === "message") {
      const item = new vscode.TreeItem(node.text, C.None);
      item.iconPath = new vscode.ThemeIcon(node.id === "error" ? "error" : "info");
      return item;
    }
    if (node.type === "repo") {
      const here = this.workspaceRoots().includes(node.repo.root);
      const item = new vscode.TreeItem(node.repo.name || path.basename(node.repo.root), here ? C.Expanded : C.Collapsed);
      item.id = node.id;
      item.description = here ? "" : node.repo.root;
      item.iconPath = new vscode.ThemeIcon("repo");
      return item;
    }
    if (node.type === "closed" || node.type === "group") {
      const item = new vscode.TreeItem(node.type === "closed" ? `Done (${node.tasks.length})` : node.label, C.Collapsed);
      item.id = node.id;
      item.iconPath = new vscode.ThemeIcon("archive");
      return item;
    }
    if (node.type === "task") {
      const t = node.task;
      const item = new vscode.TreeItem(`${t.key}${t.title ? ` · ${t.title}` : ""}`, t.status === "active" ? C.Expanded : C.Collapsed);
      item.id = node.id;
      item.description = t.summary ? t.summary.split("\n")[0] : t.status;
      item.tooltip = new vscode.MarkdownString(`**${t.key}** ${t.title ?? ""}\n\n${t.status}${t.summary ? `\n\n${t.summary}` : ""}`);
      item.iconPath = new vscode.ThemeIcon(TASK_ICON[/** @type {keyof typeof TASK_ICON} */ (t.status)] ?? "issues");
      item.contextValue = `task-${t.status === "done" || t.status === "dropped" ? "closed" : "live"}`;
      return item;
    }
    const r = node.record;
    const item = new vscode.TreeItem(r.title, C.None);
    item.id = node.id;
    const bits = [node.showTask ? r.task_key ?? "" : "", r.owner === "K" ? "you" : r.owner === "C" ? "agent" : "", r.status !== "open" ? r.status : ""];
    if (this.mode === "asks" && node.repo) bits.unshift(node.repo.name);
    item.description = bits.filter(Boolean).join(" · ");
    item.tooltip = new vscode.MarkdownString(`**${r.kind}** · ${r.status}${r.owner ? ` · ${r.owner === "K" ? "you" : "agent"}` : ""}${r.pointer ? " · 👉" : ""}\n\n${r.title}${r.body ? `\n\n---\n\n${r.body}` : ""}`);
    item.iconPath = iconOf(r);
    item.contextValue = `record-${r.status}${r.pointer ? "-pointer" : ""}`;
    item.command = { command: "imprimatur.records.show", title: "Show record", arguments: [node] };
    return item;
  }
}

/** A record as a read-only Markdown page: title, body, links and every version. @param {number} id */
function pageOf(id) {
  const db = records.dbOf();
  const r = db?.record(id);
  if (!r) return `Record ${id} not found.`;
  const task = db.taskById(r.task_id);
  const versions = db.versionsOf(id);
  const when = (ms) => new Date(ms).toLocaleString();
  return [
    `# ${r.title}`,
    "",
    `${task ? `${task.key}${task.title ? ` · ${task.title}` : ""} · ` : ""}${r.kind} · ${r.status}${r.owner ? ` · ${r.owner === "K" ? "you" : "agent"}` : ""}${r.pointer ? " · 👉" : ""}`,
    "",
    r.body ?? "",
    "",
    r.links ? `Links: \`${JSON.stringify(r.links.md ? { ...r.links, md: undefined } : r.links)}\`` : "",
    "",
    "## History",
    "",
    ...versions.map((v) => `- ${when(v.at)} · ${v.actor_kind}${v.actor ? ` ${v.actor}` : ""} · ${v.op}: ${JSON.stringify(v.after)}`),
  ].join("\n");
}

/**
 * Registers the views and their commands.
 * @param {vscode.ExtensionContext} ctx @param {() => string[]} roots the window's repos
 * @param {(msg: string) => void} log @param {() => void} [onChange] also told when the database changes (the graph)
 */
function registerRecordViews(ctx, roots, log, onChange = () => {}) {
  const views = {
    asks: new RecordsView("asks", [], roots),
    tasks: new RecordsView("tasks", [], roots),
    questions: new RecordsView("kinds", ["question"], roots),
    decisions: new RecordsView("kinds", ["decision"], roots),
    adr: new RecordsView("kinds", ["adr"], roots),
    pdr: new RecordsView("kinds", ["pdr"], roots),
  };
  const trees = Object.fromEntries(
    Object.entries(views).map(([name, provider]) => [name, vscode.window.createTreeView(`imprimatur.records.${name}`, { treeDataProvider: provider, showCollapseAll: name !== "asks" })]),
  );
  const refresh = () => Object.values(views).forEach((v) => v.refresh());
  const badge = () => {
    const n = records.dbOf()?.openAsks({ limit: 200 }).length ?? 0;
    trees.asks.badge = n ? { value: n, tooltip: `${n} waiting on you` } : undefined;
  };

  // Follow the database file: a write anywhere changes its WAL. Event-driven, debounced.
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const db = records.dbOf();
  if (db) {
    try {
      const dir = path.dirname(db.file);
      const base = path.basename(db.file);
      const watcher = fs.watch(dir, (_e, name) => {
        if (!name || !String(name).startsWith(base)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          records.checkFile();
          refresh();
          badge();
          refreshPages();
          onChange();
        }, 300);
      });
      ctx.subscriptions.push({ dispose: () => watcher.close() });
    } catch (e) {
      log(`records: cannot watch the database: ${e instanceof Error ? e.message : e}`);
    }
  }
  badge();

  const pages = new vscode.EventEmitter();
  /** Record pages shown: they follow changes too. @type {Set<string>} */
  const shownPages = new Set();
  const refreshPages = () => shownPages.forEach((u) => pages.fire(vscode.Uri.parse(u)));
  /** @param {any} node */
  const recordOf = (node) => node?.record ?? (node?.type === "record" ? node.record : undefined);
  /** Writes, then shows what failed. @param {() => void} fn */
  const write = (fn) => {
    try {
      fn();
    } catch (e) {
      vscode.window.showErrorMessage(`Imprimatur: ${e instanceof Error ? e.message : e}`);
    }
    refresh();
    badge();
    refreshPages();
    onChange();
  };
  const KIND_PICK = [
    { label: "todo", description: "something to do" },
    { label: "question", description: "a question to you" },
    { label: "decision", description: "a decision made" },
    { label: "note", description: "a note" },
    { label: "fixme", description: "something broken" },
    { label: "adr", description: "architecture decision" },
    { label: "pdr", description: "product decision" },
    { label: "test", description: "a manual test" },
  ];

  ctx.subscriptions.push(
    ...Object.values(trees),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { onDidChange: pages.event, provideTextDocumentContent: (uri) => pageOf(Number(uri.path.replace(/\D/g, ""))) }),
    vscode.commands.registerCommand("imprimatur.records.refresh", () => {
      records.reset();
      refresh();
      badge();
    }),
    vscode.commands.registerCommand("imprimatur.records.show", async (node) => {
      const r = recordOf(node);
      if (!r) return;
      const uri = vscode.Uri.parse(`${SCHEME}:/record-${r.id}.md`);
      shownPages.add(uri.toString());
      pages.fire(uri);
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    }),
    vscode.commands.registerCommand("imprimatur.records.done", (node) => write(() => records.dbOf().updateRecord(recordOf(node).id, { status: "done" }, USER))),
    vscode.commands.registerCommand("imprimatur.records.reopen", (node) => write(() => records.dbOf().updateRecord(recordOf(node).id, { status: "open" }, USER))),
    vscode.commands.registerCommand("imprimatur.records.drop", (node) => write(() => records.dbOf().updateRecord(recordOf(node).id, { status: "dropped" }, USER))),
    vscode.commands.registerCommand("imprimatur.records.pointer", (node) => write(() => records.dbOf().setPointer(recordOf(node).id, USER))),
    vscode.commands.registerCommand("imprimatur.records.editTitle", async (node) => {
      const r = recordOf(node);
      const title = await vscode.window.showInputBox({ prompt: `${r.kind} title`, value: r.title, validateInput: (v) => (v.trim() ? undefined : "Empty") });
      if (title !== undefined && title.trim() !== r.title) write(() => records.dbOf().updateRecord(r.id, { title: title.trim() }, USER));
    }),
    vscode.commands.registerCommand("imprimatur.records.copy", (node) => vscode.env.clipboard.writeText(recordOf(node)?.title ?? node?.task?.key ?? "")),
    vscode.commands.registerCommand("imprimatur.records.add", async (node) => {
      const task = node?.task ?? (node?.record ? records.dbOf().taskById(node.record.task_id) : undefined);
      if (!task) return;
      const kind = await vscode.window.showQuickPick(KIND_PICK, { title: `Add to ${task.key}` });
      if (!kind) return;
      const title = await vscode.window.showInputBox({ prompt: `${kind.label} in ${task.key}`, validateInput: (v) => (v.trim() ? undefined : "Empty") });
      if (!title?.trim()) return;
      const owner = kind.label === "question" ? "K" : kind.label === "todo" ? (await vscode.window.showQuickPick([{ label: "K", description: "you do it" }, { label: "C", description: "the agent does it" }], { title: "Who does it?" }))?.label : undefined;
      write(() => records.dbOf().addRecord(task.id, { kind: kind.label, title: title.trim(), ...(owner && { owner }) }, USER));
    }),
    vscode.commands.registerCommand("imprimatur.records.taskDone", (node) => write(() => records.dbOf().upsertTask(node.task.repo_id, node.task.key, { status: "done" }))),
    vscode.commands.registerCommand("imprimatur.records.taskReopen", (node) => write(() => records.dbOf().upsertTask(node.task.repo_id, node.task.key, { status: "active" }))),
    vscode.commands.registerCommand("imprimatur.records.search", async () => {
      if (!records.dbOf()) return;
      const text = await vscode.window.showInputBox({ prompt: "Search records (title and body, every repo)" });
      // Read again after each wait: Refresh may have reopened the connection.
      const db = records.dbOf();
      if (!text?.trim() || !db) return;
      const repos = new Map(db.repos().map((r) => [r.id, r]));
      const found = db.search(text.trim(), { limit: 100 });
      const pick = await vscode.window.showQuickPick(
        found.map((r) => {
          const task = db.taskById(r.task_id);
          return { label: r.title, description: `${repos.get(task?.repo_id)?.name ?? ""} · ${r.task_key} · ${r.kind} · ${r.status}`, record: r, root: repos.get(task?.repo_id)?.root };
        }),
        { title: `${found.length} record${found.length === 1 ? "" : "s"}`, matchOnDescription: true },
      );
      if (pick) vscode.commands.executeCommand("imprimatur.records.reveal", { root: pick.root, record: pick.record.id });
    }),
    // From the graph and Waiting on you: show a task or a record in the Tasks view.
    vscode.commands.registerCommand("imprimatur.records.reveal", async (/** @type {{root?: string, task?: string, record?: number}} */ at) => {
      const db = records.dbOf();
      if (!db || !at) return;
      let task;
      let record;
      if (at.record) {
        record = db.record(at.record);
        task = record && db.taskById(record.task_id);
      } else if (at.root && at.task) {
        task = db.taskByKey(db.repoByRoot(at.root)?.id ?? -1, at.task);
      }
      if (!task) return vscode.window.showInformationMessage(`Imprimatur: ${at.task ?? "this record"} has no records yet.`);
      // Walk the tree down to fill the node map: repo → (Done) → task → record.
      const view = views.tasks;
      const repoNode = view.getChildren().find((n) => n.type === "repo" && n.repo.id === task.repo_id);
      if (!repoNode) return;
      const level = view.getChildren(repoNode);
      let taskNode = level.find((n) => n.type === "task" && n.task.id === task.id);
      if (!taskNode) {
        const closed = level.find((n) => n.type === "closed");
        taskNode = closed && view.getChildren(closed).find((n) => n.task.id === task.id);
      }
      if (!taskNode) return;
      const target = record ? view.getChildren(taskNode).find((n) => n.record?.id === record.id) ?? taskNode : taskNode;
      await trees.tasks.reveal(target, { select: true, focus: true, expand: true });
      if (record) vscode.commands.executeCommand("imprimatur.records.show", target);
    }),
  );
  return { refresh };
}

module.exports = { registerRecordViews, RecordsView, pageOf };
