// @ts-check
// Record commands (#60): mark done, reopen, drop, move the 👉, edit the title,
// add a record, search, and a record as a read-only Markdown page with its
// history. The records themselves show in the Imprimatur panel's task tabs
// (tasksView.js, #69), which replaced the sidebar's record views; reveal opens
// the panel on a task. Follows the database file, so any writer (an agent
// through MCP, a hook, another window) shows up at once; nothing polls.
"use strict";
const os = require("node:os");
const vscode = require("vscode");
const records = require("./records.js");
const { watchFile } = require("./watch.js");

const SCHEME = "imprimatur-record";
const USER = { kind: /** @type {"user"} */ ("user"), id: os.userInfo().username };
/** The prompts the commands show; the integration tests replace them (#60). */
const ui = {
  /** @type {typeof vscode.window.showInputBox} */
  showInputBox: (...a) => vscode.window.showInputBox(...a),
  /** @type {typeof vscode.window.showQuickPick} */
  showQuickPick: (...a) => /** @type {any} */ (vscode.window.showQuickPick)(...a),
};

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
 * Registers the record commands (#60; the record views became the panel's task tabs, #69)
 * and follows the database file: any writer (an agent through MCP, a hook, another
 * window) shows up at once; nothing polls.
 * @param {vscode.ExtensionContext} ctx @param {(msg: string) => void} log
 * @param {() => void} onChange told when the database changes (the panel, the launcher)
 * @param {(at: {root?: string, task?: string, record?: number}) => unknown} reveal opens the panel on a task or record
 * @param {(all: boolean) => void} setAllRepos the panel's "every repo" switch
 */
function registerRecordCommands(ctx, log, onChange, reveal, setAllRepos) {
  // Follow the database file: a write anywhere changes its WAL. Event-driven, debounced;
  // armed again after a watch error, and before the database exists (vscode/watch.js).
  const file = records.dbOf()?.file ?? require("./db.js").dbPath();
  if (file !== ":memory:")
    ctx.subscriptions.push(watchFile(file, () => {
      records.checkFile();
      refreshPages();
      onChange();
    }, log));

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
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { onDidChange: pages.event, provideTextDocumentContent: (uri) => pageOf(Number(uri.path.replace(/\D/g, ""))) }),
    ...["allRepos", "thisWindow"].map((name) =>
      vscode.commands.registerCommand(`imprimatur.records.${name}`, () => {
        setAllRepos(name === "allRepos");
        onChange();
      }),
    ),
    vscode.commands.registerCommand("imprimatur.records.refresh", () => {
      records.reset();
      onChange();
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
      const title = await ui.showInputBox({ prompt: `${r.kind} title`, value: r.title, validateInput: (v) => (v.trim() ? undefined : "Empty") });
      if (title !== undefined && title.trim() !== r.title) write(() => records.dbOf().updateRecord(r.id, { title: title.trim() }, USER));
    }),
    vscode.commands.registerCommand("imprimatur.records.copy", (node) => vscode.env.clipboard.writeText(recordOf(node)?.title ?? node?.task?.key ?? "")),
    vscode.commands.registerCommand("imprimatur.records.add", async (node) => {
      const task = node?.task ?? (node?.record ? records.dbOf().taskById(node.record.task_id) : undefined);
      if (!task) return;
      const kind = await ui.showQuickPick(KIND_PICK, { title: `Add to ${task.key}` });
      if (!kind) return;
      const title = await ui.showInputBox({ prompt: `${kind.label} in ${task.key}`, validateInput: (v) => (v.trim() ? undefined : "Empty") });
      if (!title?.trim()) return;
      const owner = kind.label === "question" ? "K" : kind.label === "todo" ? (await ui.showQuickPick([{ label: "K", description: "you do it" }, { label: "C", description: "the agent does it" }], { title: "Who does it?" }))?.label : undefined;
      write(() => records.dbOf().addRecord(task.id, { kind: kind.label, title: title.trim(), ...(owner && { owner }) }, USER));
    }),
    vscode.commands.registerCommand("imprimatur.records.taskDone", (node) => write(() => records.dbOf().upsertTask(node.task.repo_id, node.task.key, { status: "done" }))),
    vscode.commands.registerCommand("imprimatur.records.taskReopen", (node) => write(() => records.dbOf().upsertTask(node.task.repo_id, node.task.key, { status: "active" }))),
    vscode.commands.registerCommand("imprimatur.records.search", async () => {
      if (!records.dbOf()) return;
      const text = await ui.showInputBox({ prompt: "Search records (title and body, every repo)" });
      // Read again after each wait: Refresh may have reopened the connection.
      const db = records.dbOf();
      if (!text?.trim() || !db) return;
      const repos = new Map(db.repos().map((r) => [r.id, r]));
      const found = db.search(text.trim(), { limit: 100 });
      const pick = await ui.showQuickPick(
        found.map((r) => {
          const task = db.taskById(r.task_id);
          return { label: r.title, description: `${repos.get(task?.repo_id)?.name ?? ""} · ${r.task_key} · ${r.kind} · ${r.status}`, record: r, root: repos.get(task?.repo_id)?.root };
        }),
        { title: `${found.length} record${found.length === 1 ? "" : "s"}`, matchOnDescription: true },
      );
      if (pick) vscode.commands.executeCommand("imprimatur.records.reveal", { root: pick.root, record: pick.record.id });
    }),
    // From the graph, Bende bekleyenler and Search: the task (and record) on the panel's Görevler tab.
    vscode.commands.registerCommand("imprimatur.records.reveal", (/** @type {{root?: string, task?: string, record?: number}} */ at) => {
      if (!at || !records.dbOf()) return;
      return reveal(at);
    }),
  );
  // ui: the prompts, handed out by activate for the integration tests (#68).
  return { ui };
}

module.exports = { registerRecordCommands, pageOf };
