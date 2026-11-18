// #224: Active tasks by last activity, the one worked on last marked, a relative time per row; page and side bar agree.
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { appModel, taskLists, ago } = req("../vscode/app/model.js");
const { appHtml } = req("../vscode/app/html.js");

// The side bar's provider needs only these pieces of the vscode API.
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
const H = 3600_000;

function seed() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-224-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const now = Date.now();
  const ids = {};
  // Task rows updated in the order A (newest), B, C: the old order.
  for (const [key, title, at] of [["#3", "C", now - 9 * H], ["#2", "B", now - 8 * H], ["#1", "A", now - 7 * H]]) {
    ids[title] = db.upsertTask(repo.id, key, { title, status: "active" }).id;
    db.q("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, ids[title]);
  }
  for (const [key, at] of [["#10", now - 5 * H], ["#11", now - 4 * H]]) {
    const t = db.upsertTask(repo.id, key, { title: key, status: "open" });
    db.q("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, t.id);
  }
  const record = (title, at) => {
    const r = db.addRecord(ids[title], { kind: "note", title: `work on ${title}` }, agent);
    db.q("UPDATE records SET updated_at = ? WHERE id = ?").run(at, r.id);
  };
  return { root, db, repo, now, record };
}

test("ago: short relative times", () => {
  const now = 10 * 86_400_000;
  assert.deepEqual([ago(now - 20_000, now), ago(now - 5 * 60_000, now), ago(now - 2 * H, now), ago(now - 3 * 86_400_000, now)], ["just now", "5 min ago", "2 h ago", "3 d ago"]);
});

test("Active by last activity: the task with the newest record leads and is marked; a newer record moves the mark; open keeps its order", () => {
  const { db, repo, now, record } = seed();
  const keys = () => taskLists(db, repo.id, now)[0].tasks.map((t) => `${t.key}${t.last ? "*" : ""}`);
  assert.deepEqual(keys(), ["#1*", "#2", "#3"], "no records: the old order");
  record("B", now - 2 * H);
  assert.deepEqual(keys(), ["#2*", "#1", "#3"], "#B got the latest record");
  assert.equal(taskLists(db, repo.id, now)[0].tasks[0].when, "2 h ago");
  record("A", now - 1 * H);
  assert.deepEqual(keys(), ["#1*", "#2", "#3"], "a record on #A moves it and the mark");
  assert.deepEqual(taskLists(db, repo.id, now)[0].tasks.map((t) => t.when), ["1 h ago", "2 h ago", "9 h ago"]);
  assert.deepEqual(taskLists(db, repo.id, now)[1].tasks.map((t) => t.key), ["#11", "#10"], "open: as before");
});

test("Tasks page: the marker on the first active row only, a relative time on each active row", () => {
  const { root, db, repo, record, now } = seed();
  record("B", now - 2 * H);
  const html = appHtml(appModel(db, repo, root, { area: "tasks" }), { nonce: "n", cspSource: "x", render: (s) => s });
  assert.equal(html.match(/Last worked on/g)?.length, 1);
  assert.match(html, /data-task="#2"><span class="key">#2<\/span><span><b>B<\/b> <span class="tag lastworked">Last worked on<\/span> <span class="when">2 h ago<\/span>/);
  assert.match(html, /data-task="#3"><span class="key">#3<\/span><span><b>C<\/b> <span class="when">9 h ago<\/span>/);
});

test("side bar: Tasks › Active in the same order, the first described as Last worked on", () => {
  const { db, repo, record, now } = seed();
  record("C", now - 30 * 60_000);
  const view = new LauncherView(() => ({ edits: 0, inbox: 0, tasks: taskLists(db, repo.id, now) }));
  view.refresh();
  const tasks = view.getChildren().find((r) => r.id === "tasks");
  const active = view.getChildren(tasks).find((g) => g.id === "tasks.active");
  const rows = view.getChildren(active).map((r) => view.getTreeItem(r));
  assert.deepEqual(rows.map((r) => r.label), ["#3 · C", "#1 · A", "#2 · B"]);
  assert.deepEqual(rows.map((r) => r.description), ["Last worked on · 30 min ago", "7 h ago", "8 h ago"]);
  assert.equal(rows[0].iconPath?.id, "history");
});
