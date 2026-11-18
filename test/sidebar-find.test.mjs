// #225: the magnifier finds tasks (the key first), "Ask" is last, and a task is revealed in the side bar.
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { rankedSearch, pickItems } = req("../vscode/search-index.js");

class TreeItem {
  constructor(label, collapsibleState) {
    Object.assign(this, { label, collapsibleState });
  }
}
const vscodeStub = {
  EventEmitter: class { event = () => {}; fire() {} },
  TreeItem,
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  workspace: { workspaceFolders: [] },
};
const load = Module._load;
Module._load = function (r, ...a) {
  return r === "vscode" ? vscodeStub : load.call(this, r, ...a);
};
const { LauncherView } = req("../vscode/launcherView.js");
Module._load = load;

const agent = { kind: "agent", id: "s" };

function seed() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-225-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(path.join(root, "repo"), { name: "repo" });
  const t895 = db.upsertTask(repo.id, "#895", { title: "Webhook retries", status: "open", summary: "Backoff decided" });
  db.upsertTask(repo.id, "#8950", { title: "Something else", status: "open" });
  db.upsertTask(repo.id, "PROJ-12", { title: "Jira one", status: "active" });
  db.upsertTask(repo.id, "RECS", { title: "Recommendations bucket" });
  const t1 = db.upsertTask(repo.id, "#1", { title: "Other", status: "active" });
  db.addRecord(t1.id, { kind: "note", title: "See #895 for the retry plan", body: "895 895 895 webhook" }, agent);
  db.addRecord(t895.id, { kind: "decision", title: "Exponential backoff", body: "Up to five tries." }, agent);
  db.upsertSection(db.docOf(repo.id, "glossary").id, "retry", { title: "Retry", body: "Trying a webhook again." }, agent);
  return { db, repo };
}

test("ranked search: a task key returns the task first, ahead of records naming it; title words find it; buckets are no tasks", () => {
  const { db, repo } = seed();
  for (const q of ["#895", "895"]) {
    const hits = rankedSearch(db, q, { repoId: repo.id });
    assert.deepEqual([hits[0].type, hits[0].key], ["task", "#895"], q);
    assert.ok(hits.some((h) => h.type === "record" && /See #895/.test(h.title)), `${q}: the record is still found`);
  }
  assert.equal(rankedSearch(db, "proj-12", { repoId: repo.id })[0].key, "PROJ-12", "a Jira key, any case");
  assert.equal(rankedSearch(db, "webhook retr", { repoId: repo.id }).find((h) => h.type === "task")?.key, "#895", "title words, the last as a prefix");
  assert.ok(!rankedSearch(db, "recommendations", { repoId: repo.id }).some((h) => h.type === "task"), "a bucket is no task");
  assert.ok(!rankedSearch(db, "895", { repoId: repo.id, type: "record" }).some((h) => h.type === "task"), "a typed search (the MCP tool's) has no tasks");
  assert.equal(rankedSearch(db, "exponential", { repoId: repo.id })[0].title, "Exponential backoff", "records as before");
  assert.equal(rankedSearch(db, "again", { repoId: repo.id })[0].type, "section", "sections as before");
  db.upsertTask(repo.id, "#900", { title: "Brand new", status: "open" });
  assert.equal(rankedSearch(db, "#900", { repoId: repo.id })[0]?.key, "#900", "a task added since is found");
});

test("magnifier rows: the top hit first, this window's repo before another, a task labelled with its key, Ask last", () => {
  const hits = [
    { type: "record", id: 1, title: "Elsewhere", repo_id: 2, task_key: "#3", kind: "note" },
    { type: "task", id: 9, key: "#895", title: "Webhook retries", status: "open", repo_id: 1 },
    { type: "section", id: 4, title: "Retry", repo_id: 1, doc_kind: "glossary" },
  ];
  const repos = new Map([[1, { name: "here", root: "/here" }], [2, { name: "there", root: "/there" }]]);
  const rows = pickItems(hits, "retry", repos, new Set(["/here"]));
  assert.deepEqual(rows.map((r) => r.label), ["$(tasklist) #895 · Webhook retries", "$(book) Retry", "$(note) Elsewhere", "$(sparkle) Ask: retry"]);
  assert.equal(rows[0].description, "here · task, open");
  assert.equal(rows[2].description, "there · #3 note", "another repo's hit names its repo");
  assert.equal(rows.at(-1).ask, true);
  assert.deepEqual(pickItems([], "x", repos, new Set()).map((r) => !!r.ask), [true], "no hits: only Ask");
});

test("reveal in the side bar: a task under a collapsed group is revealed, selected and focused, its parent its group", async () => {
  const lists = [
    { id: "active", label: "Active", tasks: [{ key: "#1", title: "One" }] },
    { id: "open", label: "Open", tasks: [{ key: "#895", title: "Webhook retries" }] },
    { id: "done", label: "Done", tasks: [] },
  ];
  const view = new LauncherView(() => ({ edits: 0, inbox: 0, tasks: lists }));
  const calls = [];
  view.view = { visible: true, reveal: async (row, o) => void calls.push([row, o]) };
  view.refresh();
  assert.equal(await view.revealTask("#895"), true);
  const [row, o] = calls[0];
  assert.deepEqual(o, { select: true, focus: true, expand: true });
  assert.equal(row.id, "tasks.open.#895");
  const group = view.getParent(row);
  assert.equal(group.id, "tasks.open");
  assert.equal(view.getTreeItem(group).collapsibleState, vscodeStub.TreeItemCollapsibleState.Collapsed, "the group was collapsed");
  assert.ok(view.getChildren(group).includes(row), "the same object the tree holds");
  assert.equal(await view.revealTask("#404"), false);
  assert.equal(calls.length, 1, "an unknown key reveals nothing");
});

test("Ctrl+F in the side bar opens its groups before VS Code's find", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../vscode/package.json", import.meta.url), "utf8"));
  const kb = pkg.contributes.keybindings.find((k) => k.command === "imprimatur.launcher.find");
  assert.deepEqual([kb.key, kb.mac, kb.when], ["ctrl+f", "cmd+f", "focusedView == imprimatur.launcher"]);
});
