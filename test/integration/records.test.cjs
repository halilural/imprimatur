// Records in a real extension host: the steps of the manual tests MT-AR-060…064
// that need no eyes, since #69 on the Imprimatur panel's task tabs (its models
// from tasksView.js, its messages through the panel's own handler). Each test seeds its own task through a second
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

const record = (id) => withDb((db) => db.record(id));
const lastVersion = (id) => withDb((db) => db.versionsOf(id).at(-1));
const tv = require(path.join(EXT, "tasksView.js"));
const { waitingSteps } = require(path.join(EXT, "waiting.js"));
const panelOpen = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("imprimatur.graph"));

suite("Records on the Imprimatur panel (#60, #69, MT-AR-060…064)", () => {
  suiteSetup(async () => {
    await api();
    await vscode.commands.executeCommand("imprimatur.records.thisWindow");
  });

  test("MT-AR-060 Bende bekleyenler: this window's repo, count and badge, all repos, the record page", async () => {
    const { launcher } = await api();
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

    const model = (all) => withDb((db) => tv.inboxModel(db, ROOT, { all }));
    const items = (m) => m.groups.flatMap((g) => g.items.filter((r) => !r.done));
    const expected = withDb((db) => {
      const repoId = db.repoByRoot(ROOT).id;
      return [...db.openAsks({ repoId, limit: 500 }), ...db.openTests({ repoId, limit: 500 })];
    });
    const mine = items(model(false));
    assert.deepEqual(mine.map((r) => r.id).sort(), expected.map((r) => r.id).sort(), "open owner-K todos and questions (and manual tests) of this repo");
    assert.ok(!mine.some((r) => r.title === otherTitle));
    assert.ok(mine.some((r) => r.id === todo.id));
    assert.ok(!mine.some((r) => r.title === "A todo for the agent" || r.title === "A note, not an ask"));
    assert.equal(model(false).groups.find((g) => g.task.key === "IT-60").repo.root, ROOT);

    launcher.refresh();
    const count = withDb((db) => tv.inboxCount(db, ROOT, waitingSteps(ROOT)));
    assert.equal(launcher.view.badge?.value, count, "the launcher's badge = what waits on you");
    assert.equal(launcher.getTreeItem(launcher.getChildren().find((r) => r.id === "inbox")).label, `Bende bekleyenler (${count})`);

    const g = model(true).groups.find((x) => x.items.some((r) => r.title === otherTitle));
    assert.ok(g, "another repo's ask with every repo");
    assert.equal(g.repo.root, other);
    assert.equal(g.task.key, "OT-1");

    // The panel's switch is kept like the record views' was.
    await vscode.commands.executeCommand("imprimatur.openInbox");
    await until(panelOpen, "the panel open", 10_000);
    const { panelState } = await api();
    try {
      await vscode.commands.executeCommand("imprimatur.records.allRepos");
      assert.equal(panelState().view.all, true);
      await until(() => panelState().html.includes(otherTitle), "the other repo's ask drawn on Bende bekleyenler");
    } finally {
      await vscode.commands.executeCommand("imprimatur.records.thisWindow");
    }
    assert.equal(panelState().view.all, false);

    await vscode.commands.executeCommand("imprimatur.records.show", { record: record(todo.id) });
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

  test("MT-AR-061 Görevler: the list by status, the task page with its 👉 callout, Bitenleri göster (n), the summary", async () => {
    await api();
    const { task, records: [, , last] } = seedTask("IT-61", { title: "Tasks view", status: "active", summary: "Status: halfway\nmore lines" }, [
      { kind: "todo", owner: "C", title: "First record" },
      { kind: "question", owner: "K", title: "Second record" },
      { kind: "todo", title: "Where we left off", pointer: true },
      { kind: "todo", owner: "C", title: "Old work", status: "done" },
    ]);
    seedTask("IT-61-DONE", { title: "Finished", status: "done" }, [{ kind: "todo", title: "Old work", status: "done" }]);

    const m = withDb((db) => tv.tasksPage(db, ROOT, { sel: task.id }));
    const keys = m.groups.flatMap((g) => g.tasks.map((t) => t.key));
    assert.ok(keys.includes("IT-61"), "a live task under Aktif");
    assert.ok(!keys.includes("IT-61-DONE"), "done tasks only under Biten");
    const doneCount = withDb((db) => db.tasksOf(db.repoByRoot(ROOT).id, { limit: 1000 }).filter((t) => t.status === "done" || t.status === "dropped").length);
    assert.equal(m.counts.done, doneCount);
    assert.ok(withDb((db) => tv.tasksPage(db, ROOT, { filter: "done" })).groups.some((g) => g.tasks.some((t) => t.key === "IT-61-DONE")));

    const c = m.cur;
    assert.equal(c.key, "IT-61");
    assert.equal(c.summary, "Status: halfway\nmore lines");
    assert.equal(c.pointer.id, last.id, "Nerede kaldık: the 👉 record");
    assert.deepEqual(c.todos.map((r) => r.title), ["First record", "Where we left off"]);
    assert.equal(c.hiddenDone, 1);
    assert.deepEqual(c.asks.map((r) => r.title), ["Second record"]);
    const html = withDb((db) => tv.tasksHtml(tv.tasksPage(db, ROOT, { sel: task.id })));
    assert.ok(html.includes("Bitenleri göster (1)"));
    assert.ok(html.includes("Nerede kaldık"));
  });

  test("MT-AR-062 the panel writes as the user: done, reopen, pointer, answer, quick-add, task status; the commands too", async () => {
    const { panelMessage, recordUi } = await api();
    const { task, records: [rec, q] } = seedTask("IT-62", { title: "Commands", status: "active" }, [
      { kind: "todo", owner: "K", title: "Change me" },
      { kind: "question", owner: "K", title: "Which one?" },
    ]);
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: ROOT, task: "IT-62" });
    const byUser = (id, what) => {
      const v = lastVersion(id);
      assert.equal(v.actor_kind, "user", `${what}: a version row by the user`);
      return v;
    };

    panelMessage({ type: "rec", id: rec.id, op: "done" });
    assert.equal(record(rec.id).status, "done");
    assert.deepEqual(byUser(rec.id, "done").after, { status: "done" });
    panelMessage({ type: "rec", id: rec.id, op: "open" });
    assert.equal(record(rec.id).status, "open");
    panelMessage({ type: "rec", id: rec.id, op: "pointer" });
    assert.equal(record(rec.id).pointer, true);
    assert.deepEqual(byUser(rec.id, "pointer").after, { pointer: true });

    panelMessage({ type: "answer", id: q.id, text: "The first one." });
    assert.equal(record(q.id).status, "done");
    const answer = withDb((db) => db.recordsOf(task.id).find((r) => r.kind === "answer" && r.parent_id === q.id));
    assert.equal(answer?.title, "The first one.");
    assert.equal(byUser(answer.id, "answer").op, "create");

    panelMessage({ type: "add", task: task.id, text: "@ben Added from the panel" });
    const added = withDb((db) => db.recordsOf(task.id).find((r) => r.title === "Added from the panel"));
    assert.deepEqual([added?.kind, added?.owner], ["todo", "K"]);
    assert.equal(byUser(added.id, "add").op, "create");

    panelMessage({ type: "taskStatus", task: task.id, status: "done" });
    assert.equal(withDb((db) => db.taskById(task.id).status), "done");
    panelMessage({ type: "taskStatus", task: task.id, status: "active" });

    // The record commands stay for the palette and other callers.
    const saved = { ...recordUi };
    try {
      recordUi.showInputBox = async (o) => {
        assert.equal(o.value, "Change me", "the box starts with the title");
        return "  Changed title  ";
      };
      await vscode.commands.executeCommand("imprimatur.records.editTitle", { record: record(rec.id) });
      assert.equal(record(rec.id).title, "Changed title");
      assert.deepEqual(byUser(rec.id, "editTitle").after, { title: "Changed title" });
    } finally {
      Object.assign(recordUi, saved);
    }
    await vscode.commands.executeCommand("imprimatur.records.drop", { record: record(rec.id) });
    assert.equal(record(rec.id).status, "dropped");
    assert.equal(record(rec.id).pointer, false, "a dropped record loses the 👉");

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`imprimatur-record:/record-${rec.id}.md`));
    const history = doc.getText().split("## History")[1];
    assert.ok((history.match(/· user /g)?.length ?? 0) >= 5, "done, reopen, pointer, title, drop by the user");
    assert.deepEqual(withDb((db) => db.versionsOf(rec.id)).slice(1).filter((v) => v.actor_kind !== "user"), [], "every change after the create by the user");
  });

  test("MT-AR-063 an outside write redraws the open task page, and shows as a record row in the graph", async () => {
    const { panelState } = await api();
    const { task } = seedTask("IT-63", { title: "Outside writes", status: "active" }, [{ kind: "todo", owner: "C", title: "Existing" }]);
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: ROOT, task: "IT-63" });
    await until(() => panelState().view.tab === "tasks" && panelState().view.sel === task.id, "the panel on IT-63");
    await until(() => panelState().html.includes("Outside writes"), "IT-63's page drawn");

    const title = `Note from the MCP server ${Date.now()}`;
    const t0 = Date.now();
    withDb((db) => db.addRecord(task.id, { kind: "note", title }, AGENT));
    await until(() => panelState().html.includes(title), "the page redrawn with the note (the database watcher)", 2500);
    assert.ok(Date.now() - t0 < 2500, `within ~2 s, took ${Date.now() - t0} ms`);

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

  test("MT-AR-064 an outside owner-K todo shows in Bende bekleyenler, and its mirror for the hooks ticks when done", async () => {
    const { panelState } = await api();
    await vscode.commands.executeCommand("imprimatur.openInbox");
    await until(panelOpen, "the panel open", 10_000);
    const { task } = seedTask("IT-64", { title: "Waiting on you", status: "active" });
    const title = `Owner-K todo from the MCP server ${Date.now()}`;
    const rec = withDb((db) => db.addRecord(task.id, { kind: "todo", owner: "K", title }, AGENT));

    await until(() => panelState().html.includes(title), "the todo on Bende bekleyenler");
    const step = () => waitingSteps(ROOT).find((s) => s.text === title);
    const open = await until(() => step()?.state === "open" && step(), "the todo mirrored in the waiting log");
    assert.equal(open.task, "IT-64");
    assert.match(open.title, /^IT-64 · Waiting on you$/);

    await vscode.commands.executeCommand("imprimatur.records.done", { record: record(rec.id) });
    const done = await until(() => step()?.state === "done" && step(), "the step ticked on the next sync");
    assert.match(done.note, /no longer open in Imprimatur \(IT-64\)/);
  });

  test("deep links: reveal by record opens Görevler on its task and lights the record", async () => {
    const { panelState } = await api();
    const { task, records: [, rec] } = seedTask("IT-65", { title: "Deep link", status: "open" }, [
      { kind: "todo", owner: "C", title: "One" },
      { kind: "decision", title: "Linked decision" },
    ]);
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: ROOT, record: rec.id });
    await until(() => panelState().view.sel === task.id, "the task selected");
    const s = panelState();
    assert.equal(s.view.tab, "tasks");
    assert.equal(s.view.filter, "open", "the list's filter follows the task's status");
    assert.equal(s.view.flash, rec.id);
    await until(() => panelState().html.includes(`id="rec-${rec.id}"`) && panelState().html.includes('class="card dec flash"'), "the record lit");
  });
});

