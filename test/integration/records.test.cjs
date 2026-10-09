// The record views (#60) in a real extension host: the steps of the manual tests
// MT-AR-060…064 that need no eyes. Each test seeds its own task through a second
// database connection (as the MCP server or another window would), so the tests
// do not depend on each other's data. Colours, icons' look and layout stay manual.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const ID = "halilural.imprimatur";
const EXT = path.join(__dirname, "..", "..", "vscode");
const { openDb } = require(path.join(EXT, "db.js"));
const ROOT = process.env.IMPRIMATUR_IT_ROOT;
const AGENT = { kind: "agent", id: "claude-code:it-session" };

/** The extension's exports, activating it if it is not yet. */
async function api() {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, `${ID} is loaded`);
  return ext.isActive ? ext.exports : ext.activate();
}

/** A second connection to the test database, closed after fn. @template T @param {(db: any) => T} fn @returns {T} */
function withDb(fn) {
  const db = openDb({ path: process.env.IMPRIMATUR_DB });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** A fresh task in the workspace repo with these records. @param {string} key @param {object} task @param {object[]} [list] */
function seedTask(key, task, list = []) {
  return withDb((db) => {
    const repo = db.repoOf(ROOT);
    const t = db.upsertTask(repo.id, key, task);
    const recs = list.map((r) => db.addRecord(t.id, r, AGENT));
    return { repo, task: t, records: recs };
  });
}

/** Polls until fn returns something truthy. @template T @param {() => T} fn @param {string} what */
async function until(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Waits until the provider has not fired for quietMs (earlier writes' watcher events are done). */
async function settle(provider, quietMs = 700) {
  let last = Date.now();
  const sub = provider.onDidChangeTreeData(() => (last = Date.now()));
  try {
    await until(() => Date.now() - last >= quietMs, "the views to settle", 10_000);
  } finally {
    sub.dispose();
  }
}

/** The Tasks view's node of a task in the workspace repo (live or under Done). @param {any} view @param {string} key */
function taskNode(view, key) {
  const repo = view.getChildren().find((n) => n.type === "repo" && n.repo.root === ROOT);
  assert.ok(repo, "the workspace repo in Tasks");
  const level = view.getChildren(repo);
  const closed = level.find((n) => n.type === "closed");
  return [...level, ...(closed ? view.getChildren(closed) : [])].find((n) => n.type === "task" && n.task.key === key);
}

const record = (id) => withDb((db) => db.record(id));
const lastVersion = (id) => withDb((db) => db.versionsOf(id).at(-1));
const asksIn = (view) => view.getChildren().filter((n) => n.type === "record");

suite("Record views (#60, MT-AR-060…064)", () => {
  suiteSetup(async () => {
    await api();
    await vscode.commands.executeCommand("imprimatur.records.thisWindow");
  });

  test("MT-AR-060 Waiting on me: this window's repo, count and badge, all repos, the record page", async () => {
    const { recordViews, recordTrees } = await api();
    const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-it-other-")), "other");
    const otherTitle = `Ask in another repo ${Date.now()}`;
    withDb((db) => {
      const repo = db.repoOf(other, { name: "it-other" });
      const t = db.upsertTask(repo.id, "OT-1", { title: "Other task", status: "active" });
      db.addRecord(t.id, { kind: "question", owner: "K", title: otherTitle }, AGENT);
    });
    const { records: [todo] } = seedTask("IT-60", { title: "Waiting on me", status: "active" }, [
      { kind: "todo", owner: "K", title: "A todo for the user", body: "Body of the todo." },
      { kind: "todo", owner: "C", title: "A todo for the agent" },
      { kind: "note", owner: "K", title: "A note, not an ask" },
    ]);
    await vscode.commands.executeCommand("imprimatur.records.refresh");

    const expected = withDb((db) => db.openAsks({ repoId: db.repoByRoot(ROOT).id, limit: 500 }));
    const asks = asksIn(recordViews.asks);
    assert.deepEqual(asks.map((n) => n.record.id).sort(), expected.map((r) => r.id).sort(), "open owner-K todos and questions of this repo");
    assert.ok(asks.every((n) => n.repo.root === ROOT), "only this window's repo");
    assert.ok(!asks.some((n) => n.record.title === otherTitle));
    assert.ok(asks.some((n) => n.record.id === todo.id));
    assert.ok(!asks.some((n) => n.record.title === "A todo for the agent" || n.record.title === "A note, not an ask"));
    assert.equal(recordTrees.asks.badge?.value, expected.length, "badge = open asks");
    assert.match(recordViews.asks.getTreeItem(asks.find((n) => n.record.id === todo.id)).description, /IT-60 · you/);

    try {
      await vscode.commands.executeCommand("imprimatur.records.allRepos");
      const all = asksIn(recordViews.asks);
      const ask = all.find((n) => n.record.title === otherTitle);
      assert.ok(ask, "another repo's ask with all repos on");
      assert.equal(ask.repo.root, other);
      assert.match(recordViews.asks.getTreeItem(ask).description, /^it-other · OT-1 · you/);
      assert.equal(recordTrees.asks.badge?.value, all.length);
    } finally {
      await vscode.commands.executeCommand("imprimatur.records.thisWindow");
    }
    assert.ok(!asksIn(recordViews.asks).some((n) => n.record.title === otherTitle), "back to this window's repo");

    const node = asks.find((n) => n.record.id === todo.id);
    assert.equal(recordViews.asks.getTreeItem(node).command.command, "imprimatur.records.show");
    await vscode.commands.executeCommand("imprimatur.records.show", node);
    const doc = await until(
      () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "imprimatur-record" && d.uri.path === `/record-${todo.id}.md`),
      "the record page opened",
    );
    const text = doc.getText();
    assert.match(text, /^# A todo for the user$/m);
    assert.match(text, /Body of the todo\./);
    assert.match(text, /^## History$/m);
    assert.match(text, /agent claude-code:it-session · create/);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(doc.uri, Buffer.from("x"))), "the page is read-only");
  });

  test("MT-AR-061 Tasks: repo → task → records, 👉 first, Done (n), the summary's first line", async () => {
    const { recordViews } = await api();
    const { records: [, , last] } = seedTask("IT-61", { title: "Tasks view", status: "active", summary: "Status: halfway\nmore lines" }, [
      { kind: "todo", owner: "C", title: "First record" },
      { kind: "question", owner: "K", title: "Second record" },
      { kind: "note", title: "Where we left off", pointer: true },
    ]);
    seedTask("IT-61-DONE", { title: "Finished", status: "done" }, [{ kind: "todo", title: "Old work", status: "done" }]);
    const view = recordViews.tasks;

    const repo = view.getChildren().find((n) => n.type === "repo" && n.repo.root === ROOT);
    assert.equal(view.getTreeItem(repo).collapsibleState, vscode.TreeItemCollapsibleState.Expanded, "this window's repo open");
    const level = view.getChildren(repo);
    const live = taskNode(view, "IT-61");
    assert.ok(level.some((n) => n.id === live.id), "a live task directly under the repo");
    const item = view.getTreeItem(live);
    assert.equal(item.label, "IT-61 · Tasks view");
    assert.equal(item.description, "Status: halfway", "the summary's first line");

    const recs = view.getChildren(live);
    assert.equal(recs[0].record.id, last.id, "the 👉 record first");
    assert.equal(recs[0].record.pointer, true);
    assert.equal(view.getTreeItem(recs[0]).iconPath.id, "arrow-right");
    assert.match(view.getTreeItem(recs[0]).contextValue, /-pointer$/);
    assert.deepEqual(recs.slice(1).map((n) => n.record.title), ["First record", "Second record"]);

    const closed = level.find((n) => n.type === "closed");
    assert.ok(closed, "a Done group");
    const doneCount = withDb((db) => db.tasksOf(db.repoByRoot(ROOT).id, { limit: 1000 }).filter((t) => t.status === "done" || t.status === "dropped").length);
    assert.equal(view.getTreeItem(closed).label, `Done (${doneCount})`);
    assert.ok(view.getChildren(closed).some((n) => n.task.key === "IT-61-DONE"));
    assert.ok(!level.some((n) => n.type === "task" && n.task.key === "IT-61-DONE"), "done tasks only under Done");
    assert.equal(view.getParent(recs[0]).id, live.id);
  });

  test("MT-AR-062 context commands write as the user: done, reopen, pointer, drop, edit title, add", async () => {
    const { recordViews, recordUi } = await api();
    const { task, records: [rec] } = seedTask("IT-62", { title: "Commands", status: "active" }, [{ kind: "todo", owner: "K", title: "Change me" }]);
    const node = () => ({ type: "record", record: record(rec.id) });
    const byUser = (id, what) => {
      const v = lastVersion(id);
      assert.equal(v.actor_kind, "user", `${what}: a version row by the user`);
      return v;
    };

    await vscode.commands.executeCommand("imprimatur.records.done", node());
    assert.equal(record(rec.id).status, "done");
    assert.deepEqual(byUser(rec.id, "done").after, { status: "done" });
    assert.match(recordViews.tasks.getTreeItem({ type: "record", record: record(rec.id) }).contextValue, /^record-done/);

    await vscode.commands.executeCommand("imprimatur.records.reopen", node());
    assert.equal(record(rec.id).status, "open");
    assert.deepEqual(byUser(rec.id, "reopen").after, { status: "open" });

    await vscode.commands.executeCommand("imprimatur.records.pointer", node());
    assert.equal(record(rec.id).pointer, true);
    assert.deepEqual(byUser(rec.id, "pointer").after, { pointer: true });

    const saved = { ...recordUi };
    try {
      recordUi.showInputBox = async (o) => {
        assert.equal(o.value, "Change me", "the box starts with the title");
        return "  Changed title  ";
      };
      await vscode.commands.executeCommand("imprimatur.records.editTitle", node());
      assert.equal(record(rec.id).title, "Changed title");
      assert.deepEqual(byUser(rec.id, "editTitle").after, { title: "Changed title" });

      /** @type {string[]} */
      const asked = [];
      recordUi.showQuickPick = async (items) => {
        const list = await items;
        asked.push(list.map((i) => i.label).join(","));
        return list.find((i) => i.label === "todo") ?? list.find((i) => i.label === "K");
      };
      recordUi.showInputBox = async () => "Added from the menu";
      await vscode.commands.executeCommand("imprimatur.records.add", { type: "task", task });
      assert.equal(asked.length, 2, "kind, then who does it");
      assert.ok(asked[1].startsWith("K,C"));
      const added = withDb((db) => db.recordsOf(task.id).find((r) => r.title === "Added from the menu"));
      assert.ok(added, "the record added");
      assert.equal(added.kind, "todo");
      assert.equal(added.owner, "K");
      assert.equal(byUser(added.id, "add").op, "create");

      // Cancelling the box changes nothing.
      recordUi.showInputBox = async () => undefined;
      const before = withDb((db) => db.versionsOf(rec.id).length);
      await vscode.commands.executeCommand("imprimatur.records.editTitle", node());
      assert.equal(withDb((db) => db.versionsOf(rec.id).length), before);
    } finally {
      Object.assign(recordUi, saved);
    }

    await vscode.commands.executeCommand("imprimatur.records.drop", node());
    assert.equal(record(rec.id).status, "dropped");
    assert.equal(record(rec.id).pointer, false, "a dropped record loses the 👉");
    assert.equal(byUser(rec.id, "drop").actor_kind, "user");
    assert.ok(!recordViews.tasks.getChildren(taskNode(recordViews.tasks, "IT-62")).some((n) => n.record.id === rec.id), "dropped records leave the task");

    // The record page's History says who: the user.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`imprimatur-record:/record-${rec.id}.md`));
    const history = doc.getText().split("## History")[1];
    assert.ok(history, "a History section");
    assert.ok((history.match(/· user /g)?.length ?? 0) >= 5, "done, reopen, pointer, title, drop by the user");
    assert.deepEqual(withDb((db) => db.versionsOf(rec.id)).slice(1).filter((v) => v.actor_kind !== "user"), [], "every change after the create by the user");
  });

  test("MT-AR-063 an outside write shows in Tasks without a refresh, and as a record row in the graph", async () => {
    const { recordViews } = await api();
    const { task } = seedTask("IT-63", { title: "Outside writes", status: "active" }, [{ kind: "todo", owner: "C", title: "Existing" }]);
    const view = recordViews.tasks;
    await settle(view);

    let fired = 0;
    const sub = view.onDidChangeTreeData(() => fired++);
    const title = `Note from the MCP server ${Date.now()}`;
    const t0 = Date.now();
    try {
      withDb((db) => db.addRecord(task.id, { kind: "note", title }, AGENT));
      await until(() => fired > 0, "the Tasks view told of the change (the database watcher)", 2500);
    } finally {
      sub.dispose();
    }
    assert.ok(Date.now() - t0 < 2500, `within ~2 s, took ${Date.now() - t0} ms`);
    assert.ok(view.getChildren(taskNode(view, "IT-63")).some((n) => n.record.title === title), "the note in its task");

    // The graph: a record row "note added: …" in the task's lane, nothing to accept.
    const { graphRows } = require(path.join(EXT, "graph.js"));
    const { rows, lanes } = graphRows(ROOT);
    const row = rows.find((r) => r.record && r.intent === `note added: ${title}`);
    assert.ok(row, `a record row, got ${JSON.stringify(rows.filter((r) => r.record).map((r) => r.intent))}`);
    assert.equal(row.task, "IT-63");
    assert.equal(row.accepted, true, "nothing to accept");
    assert.equal(lanes[row.lane].task, "IT-63");
    assert.equal(lanes[row.lane].title, "Outside writes");
  });

  test("MT-AR-064 an outside owner-K todo shows in Waiting on you, and ticks when marked done", async () => {
    await api();
    const { waitingSteps } = require(path.join(EXT, "waiting.js"));
    // Records sync into Waiting on you while the graph is shown.
    await vscode.commands.executeCommand("imprimatur.openGraph");
    await until(
      () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("imprimatur.graph")),
      "the graph open",
      10_000,
    );
    const { task } = seedTask("IT-64", { title: "Waiting on you", status: "active" });
    const title = `Owner-K todo from the MCP server ${Date.now()}`;
    const rec = withDb((db) => db.addRecord(task.id, { kind: "todo", owner: "K", title }, AGENT));

    const step = () => waitingSteps(ROOT).find((s) => s.text === title);
    const open = await until(() => step()?.state === "open" && step(), "the todo open in Waiting on you", 5000);
    assert.equal(open.task, "IT-64");
    assert.match(open.title, /^IT-64 · Waiting on you$/);

    await vscode.commands.executeCommand("imprimatur.records.done", { type: "record", record: record(rec.id) });
    const done = await until(() => step()?.state === "done" && step(), "the step ticked on the next sync", 5000);
    assert.match(done.note, /no longer open in Imprimatur \(IT-64\)/);
  });
});
