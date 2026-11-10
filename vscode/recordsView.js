// @ts-check
// Record commands (#60): mark done, reopen, drop, move the 👉, edit the title,
// add a record, search, and a record as a read-only Markdown page with its
// history. The records themselves show in the Imprimatur panel's task tabs
// (the new panel since #202), which replaced the sidebar's record views; reveal opens
// the panel on a task. Follows the database file, so any writer (an agent
// through MCP, a hook, another window) shows up at once (#71: within ~50 ms);
// while the panel is visible a 500 ms look at the change stamp backs that up.
"use strict";
const os = require("node:os");
const vscode = require("vscode");
const records = require("./records.js");
const { watchFile, changeGate, poller } = require("./watch.js");

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
  // Follow the database file: a write anywhere changes its WAL. Event-driven, throttled
  // (50 ms); armed again after a watch error, and before the database exists (vscode/watch.js).
  // Each look draws only when the change stamp moved: a checkpoint, or the watcher after
  // this window's own write (drawn already), draws nothing (#71).
  const moved = changeGate(() => records.dbOf()?.changeStamp());
  /** @param {boolean} [force] */
  const changed = (force = false) => {
    const reopened = records.checkFile();
    if (!moved(force || reopened)) return;
    refreshPages();
    onChange();
  };
  const file = records.dbOf()?.file ?? require("./db.js").dbPath();
  if (file !== ":memory:") ctx.subscriptions.push(watchFile(file, () => changed(), log));
  // The backstop while the panel is visible (extension.js starts and stops it).
  const backstop = poller(() => changed());
  ctx.subscriptions.push(backstop);

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
    // Drawn now; the watcher's look at the same change then draws nothing.
    changed(true);
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
    { label: "meeting", description: "a meeting's note" },
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
    vscode.commands.registerCommand("imprimatur.records.taskDone", (node) => write(() => records.dbOf().upsertTask(node.task.repo_id, node.task.key, { status: "done" }, USER))),
    vscode.commands.registerCommand("imprimatur.records.taskReopen", (node) => write(() => records.dbOf().upsertTask(node.task.repo_id, node.task.key, { status: "active" }, USER))),
    // Search (#189): one box, ranked as you type (BM25, Turkish letters folded) over records and
    // document sections, this window's repos first; the first row asks the question instead and
    // answers from the best hits, each claim citing its source.
    vscode.commands.registerCommand("imprimatur.records.search", async () => {
      if (!records.dbOf()) return;
      const { rankedSearch, askPrompt } = require("./search-index.js");
      const here = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
      const qp = vscode.window.createQuickPick();
      qp.placeholder = "Search records and documents, or ask a question";
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      /** @type {NodeJS.Timeout | undefined} */ let timer;
      const fill = () => {
        const db = records.dbOf();
        const text = qp.value.trim();
        if (!db || !text) return void (qp.items = []);
        const repos = new Map(db.repos().map((/** @type {any} */ r) => [r.id, r]));
        const hits = rankedSearch(db, text, { limit: 60 }).sort((/** @type {any} */ a, /** @type {any} */ b) => Number(here.has(repos.get(b.repo_id)?.root)) - Number(here.has(repos.get(a.repo_id)?.root)));
        const ask = { label: `$(sparkle) Ask: ${text}`, description: "an answer from the best matches, with sources", alwaysShow: true, ask: true };
        qp.items = [ask, ...hits.map((/** @type {any} */ h) => {
          const repo = repos.get(h.repo_id);
          return {
            label: `${h.type === "record" ? "$(note)" : "$(book)"} ${h.title.slice(0, 120)}`,
            description: `${repo?.name ?? ""} · ${h.type === "record" ? `${h.task_key} · ${h.kind}` : `${h.doc_kind}${h.scope ? ` ${h.scope}` : ""}`}`,
            detail: h.snippet, alwaysShow: true, hit: h, root: repo?.root,
          };
        })];
      };
      qp.onDidChangeValue(() => {
        clearTimeout(timer);
        timer = setTimeout(fill, 120);
      });
      qp.onDidAccept(async () => {
        const pick = /** @type {any} */ (qp.selectedItems[0]);
        const text = qp.value.trim();
        qp.hide();
        if (!pick) return;
        if (pick.ask) return askWithSources(text);
        const h = pick.hit;
        if (h.type === "record") vscode.commands.executeCommand("imprimatur.records.reveal", { root: pick.root, record: h.id });
        else vscode.commands.executeCommand("imprimatur.docs.reveal", { root: pick.root, kind: h.doc_kind, section: h.key });
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
      /** The question answered from the best hits by the model (the user's Claude), sources listed under it. @param {string} text */
      async function askWithSources(text) {
        const db = records.dbOf();
        if (!db || !text) return;
        const hits = rankedSearch(db, text, { limit: 8 });
        if (!hits.length) return void vscode.window.showInformationMessage(`Nothing in Imprimatur matches "${text}".`);
        const answer = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Imprimatur: asking…" },
          () => require("./model.js").askModel(askPrompt(text, hits), "sonnet").catch((/** @type {any} */ e) => `The model could not answer: ${e.message}`));
        const sources = hits.map((/** @type {any} */ h, /** @type {number} */ i) => `${i + 1}. ${h.type === "record" ? `${h.task_key} ${h.kind}` : `${h.doc_kind}${h.scope ? ` ${h.scope}` : ""}`}: ${h.title.replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
        const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: `# ${text}\n\n${String(answer).trim()}\n\n## Sources\n\n${sources}\n` });
        await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
      }
    }),
    // Go to Task (#160): "#817" + Enter opens the task on the Tasks tab; the button, its issue.
    vscode.commands.registerCommand("imprimatur.records.goToTask", async () => {
      const db = records.dbOf();
      if (!db) return;
      const { taskRows, issueUrl } = require("./go-to-task.js");
      const here = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const githubButton = { iconPath: new vscode.ThemeIcon("github"), tooltip: "Open the issue on GitHub" };
      const items = taskRows(db.repos(), (id) => db.tasksOf(id, { limit: 1000 }), here).map((row) => ({
        ...row,
        ...(row.issue ? { buttons: [githubButton] } : {}),
      }));
      const qp = vscode.window.createQuickPick();
      qp.items = items;
      qp.placeholder = "#817, or words of a task's title";
      qp.matchOnDescription = true;
      qp.onDidTriggerItemButton(({ item }) => {
        const row = /** @type {any} */ (item);
        let remote = "";
        try {
          remote = require("node:child_process").execFileSync("git", ["-C", row.root, "remote", "get-url", "origin"], { encoding: "utf8" });
        } catch {}
        const url = row.issue && issueUrl(remote, row.issue);
        if (url) vscode.env.openExternal(vscode.Uri.parse(url));
        qp.hide();
      });
      qp.onDidAccept(() => {
        const row = /** @type {any} */ (qp.selectedItems[0]);
        qp.hide();
        if (row) vscode.commands.executeCommand("imprimatur.records.reveal", { root: row.root, task: row.key });
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),
    // From the graph, Waiting on you and Search: the task (and record) on the panel's Tasks tab.
    vscode.commands.registerCommand("imprimatur.records.reveal", (/** @type {{root?: string, task?: string, record?: number}} */ at) => {
      if (!at || !records.dbOf()) return;
      return reveal(at);
    }),
  );
  // ui: the prompts, handed out by activate for the integration tests (#68).
  // backstop: started while the panel is visible. changed: look at the database now.
  return { ui, backstop, changed };
}

module.exports = { registerRecordCommands, pageOf };
