// Review fixes of the panel's task tabs (#69): atomic, checked answers; safe
// record actions; text limits; complete and single inbox counts; escaped Jira
// keys; loading states; unique ids; reads cached until the database changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const tv = req("../vscode/tasksView.js");

const AGENT = { kind: "agent", id: "claude-code:s1" };
const USER = { kind: "user", id: "me" };

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-69r-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  const file = path.join(dir, "imprimatur.db");
  const db = openDb({ path: file });
  const repo = db.repoOf(root, { name: "repo" });
  const task = db.upsertTask(repo.id, "#1", { title: "Task", status: "active" });
  const q = db.addRecord(task.id, { kind: "question", owner: "K", title: "Which?" }, AGENT);
  const todo = db.addRecord(task.id, { kind: "todo", owner: "K", title: "Yours", pointer: true }, AGENT);
  const dec = db.addRecord(task.id, { kind: "decision", title: "Chosen" }, USER);
  return { dir, file, db, root, repo, task, q, todo, dec };
}
const answersOf = (s) => s.db.recordsOf(s.task.id).filter((r) => r.kind === "answer");

test("review 1: an answer and its question's done commit together, or neither", () => {
  const s = seed();
  const update = s.db.updateRecord;
  s.db.updateRecord = () => {
    throw new Error("disk full");
  };
  try {
    assert.throws(() => tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: "This one" }, USER), /disk full/);
  } finally {
    s.db.updateRecord = update;
  }
  assert.deepEqual(answersOf(s), [], "no answer left without its question closed");
  assert.equal(s.db.record(s.q.id).status, "open");
  const a = tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: "This one" }, USER);
  assert.equal(a.parent_id, s.q.id);
  assert.equal(s.db.record(s.q.id).status, "done");
});

test("review 2: only an open question takes an answer", () => {
  const s = seed();
  assert.throws(() => tv.applyMessage(s.db, { type: "answer", id: s.todo.id, text: "x" }, USER), /is a todo, not a question/);
  tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: "first" }, USER);
  assert.throws(() => tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: "again" }, USER), /is done, not open/);
  assert.equal(answersOf(s).length, 1);
});

test("review 3: record actions are looked up as own keys only", () => {
  const s = seed();
  for (const op of ["constructor", "__proto__", "toString", "hasOwnProperty"])
    assert.throws(() => tv.applyMessage(s.db, { type: "rec", id: s.todo.id, op }, USER), /unknown record action/, op);
  assert.equal(s.db.record(s.todo.id).status, "open");
});

test("review 4: text must be a string; the title is cut at 300, the rest kept in the body (at most 20k)", () => {
  const s = seed();
  assert.throws(() => tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: { a: 1 } }, USER), /empty/);
  assert.throws(() => tv.applyMessage(s.db, { type: "add", task: s.task.id, text: ["? x"] }, USER), /nothing to add/);
  assert.equal(tv.parseQuickAdd(42), undefined);
  const long = "x".repeat(1000);
  const added = tv.applyMessage(s.db, { type: "add", task: s.task.id, text: long }, USER);
  assert.equal(added.title.length, tv.TITLE_MAX);
  assert.equal(added.body, long, "the whole text in the body");
  const huge = `title\n${"y".repeat(30_000)}`;
  const a = tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: huge }, USER);
  assert.equal(a.title, "title");
  assert.equal(a.body.length, tv.BODY_MAX);
  assert.deepEqual(tv.splitText("one line"), { title: "one line" });
});

test("review 5 + 6: a scoped inbox asks for its repo (complete past any limit) and one count serves everyone", () => {
  const s = seed();
  // Many asks elsewhere, newer than ours: a cross-repo limit would cut ours off.
  const other = s.db.repoOf(path.join(s.dir, "other"), { name: "other" });
  const ot = s.db.upsertTask(other.id, "O-1", { title: "Other", status: "active" });
  for (let i = 0; i < 30; i++) s.db.addRecord(ot.id, { kind: "question", owner: "K", title: `other ${i}` }, AGENT);
  const calls = [];
  const openAsks = s.db.openAsks.bind(s.db);
  s.db.openAsks = (o) => (calls.push(o), openAsks(o));
  const m = tv.inboxModel(s.db, s.root, {});
  assert.equal(calls[0].repoId, s.repo.id, "asked for this repo");
  assert.deepEqual(m.groups.flatMap((g) => g.items.map((r) => r.id)).sort(), [s.q.id, s.todo.id].sort());
  const waiting = [
    { kind: "question", state: "open", session: "a" },
    { kind: "verify", state: "open", session: "todo-files" },
  ];
  for (const all of [false, true]) assert.equal(tv.inboxCount(s.db, s.root, waiting, { all }), tv.inboxModel(s.db, s.root, { all, waiting }).count, `all: ${all}`);
  assert.equal(tv.inboxCount(s.db, s.root, waiting), 3);
  assert.equal(tv.inboxCount(undefined, s.root, waiting), 1, "without a database: turn-end asks, not the todo-files mirror");
});

test("review 7: a Jira key is matched as text, not as a pattern", () => {
  const s = seed();
  const t = s.db.upsertTask(s.repo.id, "A.B-1", { title: "Dotted", status: "open" });
  s.db.addRecord(t.id, { kind: "note", title: "see https://jira.example.com/browse/AxB-9" }, AGENT);
  s.db.close();
  process.env.IMPRIMATUR_DB = s.file;
  const records = req("../vscode/records.js");
  records.reset();
  try {
    assert.equal(records.jiraLink(s.root, "A.B-2"), undefined, "the dot is not a wildcard");
    assert.doesNotThrow(() => records.jiraLink(s.root, "(]-1"));
    assert.equal(records.jiraLink(s.root, "(]-1"), undefined);
    assert.equal(records.jiraLink(s.root, "AxB-2"), "https://jira.example.com/browse/AxB-2");
  } finally {
    records.reset();
  }
});

test("review 8: the hidden tab's table says it loads, not empty; a stale pane is dimmed", () => {
  const Module = req("node:module");
  const load = Module._load;
  Module._load = function (r, ...a) {
    return r === "vscode" ? { window: {}, workspace: {}, commands: {}, env: {}, Uri: {} } : load.call(this, r, ...a);
  };
  try {
    const { html } = req("../vscode/graphView.js");
    const data = { rows: [{ file: "a.md", n: 1, t: Date.now(), added: 1, removed: 0, lane: 0 }], lanes: [{ first: 0, last: 0 }], sessions: [] };
    const onTasks = html(data, "/tmp/x", "N", [], { view: { tab: "tasks" }, pane: "<div data-k='x'></div>" });
    assert.match(onTasks.split('<section id="edits"')[1].split("</tbody>")[0], /Yükleniyor…/);
    assert.match(onTasks.split('<section id="waiting"')[1].split("</tbody>")[0], /Yükleniyor…/);
    const onEdits = html(data, "/tmp/x", "N", [], { view: { tab: "edits" } });
    assert.match(onEdits.split('<section id="pane"')[1].split("</section>")[0], /Yükleniyor…/);
    assert.match(onEdits, /#pane\.stale::before/);
    assert.match(onEdits, /paneEl\.className = "stale"/);
  } finally {
    Module._load = load;
  }
});

test("review 9: a todo of yours shows in both lists with distinct ids; a link lights the todo row", () => {
  const s = seed();
  const page = tv.paneHtml(s.db, s.root, { tab: "tasks", sel: s.task.id, flash: s.todo.id });
  const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "no id twice");
  assert.ok(ids.includes(`ask-${s.todo.id}`) && ids.includes(`rec-${s.todo.id}`));
  assert.match(page, new RegExp(`class="trec flash" id="rec-${s.todo.id}"`));
  assert.doesNotMatch(page, new RegExp(`flash" id="ask-${s.todo.id}"`));
});

test("review 10: the list and decision authors are read once per database change", () => {
  const s = seed();
  let reads = 0;
  let versions = 0;
  const all = s.db.recordsOfRepo.bind(s.db);
  s.db.recordsOfRepo = (id) => (reads++, all(id));
  const versionsOf = s.db.versionsOf.bind(s.db);
  s.db.versionsOf = (id) => (versions++, versionsOf(id));
  const page = () => tv.tasksPage(s.db, s.root, { sel: s.task.id });
  assert.equal(page().cur.decisions[0].who, "sen");
  page();
  assert.equal(reads, 1, "the second draw reads nothing again");
  assert.equal(versions, 0, "authors in one query, not one per decision");
  s.db.addRecord(s.task.id, { kind: "note", title: "new" }, AGENT);
  page();
  assert.equal(reads, 2, "a write through this connection is seen");
  const other = openDb({ path: s.file });
  other.addRecord(s.task.id, { kind: "note", title: "from another connection" }, AGENT);
  other.close();
  assert.ok(page().groups[0].tasks[0].q.includes("from another connection"), "a write elsewhere is seen");
  assert.equal(reads, 3);
});
