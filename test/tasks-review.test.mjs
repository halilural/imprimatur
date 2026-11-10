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
const tv = req("../vscode/inbox.js");

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
