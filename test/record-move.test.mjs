// record_move (MEETROUTE): a record on the wrong task moves with the records under it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { callTool } = await import("../mcp/server.mjs");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-move-")));

function setup() {
  const root = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const db = openDb({ path: path.join(tmpDir(), "imprimatur.db") });
  const repo = db.repoOf(root);
  const wrong = db.upsertTask(repo.id, "LATD-13931", { status: "done" }, agent);
  db.addRecord(db.upsertTask(repo.id, "LATD-translations", {}, agent).id, { kind: "todo", title: "already there" }, agent);
  const meeting = db.addRecord(wrong.id, { kind: "meeting", title: "Translations planning" }, agent);
  const kids = ["d1", "t1", "x1"].map((t) => db.addRecord(wrong.id, { kind: "decision", title: t, parent_id: meeting.id }, agent));
  const other = db.addRecord(wrong.id, { kind: "note", title: "the wrong task's own" }, agent);
  const call = (name, a) => callTool(db, name, a, { client: "test" });
  return { db, root, meeting, kids, other, call };
}

test("record_move: a meeting moves with its children, in order, each move versioned; the rest stays", () => {
  const { db, meeting, kids, other, call } = setup();
  const { records } = call("record_move", { id: meeting.id, task: "LATD-translations" });
  assert.deepEqual(records.map((r) => r.id), [meeting.id, ...kids.map((k) => k.id)]);
  const to = db.taskByKey(db.taskById(records[0].task_id).repo_id, "LATD-translations");
  assert.ok(records.every((r) => r.task_id === to.id));
  assert.deepEqual(db.recordsOf(to.id).map((r) => r.title), ["already there", "Translations planning", "d1", "t1", "x1"]);
  assert.equal(db.record(kids[0].id).parent_id, meeting.id, "children keep their parent");
  assert.equal(db.record(other.id).task_id, meeting.task_id, "a record not under it stays");
  for (const r of records) {
    const v = db.versionsOf(r.id).at(-1);
    assert.deepEqual([v.actor_kind, v.before.task, v.after.task], ["agent", "LATD-13931", "LATD-translations"]);
  }
});

test("record_move: a child moved alone loses its parent link (versioned); a missing task is made", () => {
  const { db, kids, call } = setup();
  const { records } = call("record_move", { id: kids[1].id, task: "LATD-14189" });
  assert.equal(records.length, 1);
  assert.equal(records[0].parent_id, null);
  assert.equal(db.taskById(records[0].task_id).key, "LATD-14189");
  assert.deepEqual(db.versionsOf(kids[1].id).at(-1).after, { parent_id: null });
});

test("record_move: an unknown record is refused; its own task changes nothing", () => {
  const { meeting, call } = setup();
  assert.throws(() => call("record_move", { id: 9999, task: "X" }), /no record 9999/);
  assert.ok(call("record_move", { id: meeting.id, task: "LATD-13931" }).records.length === 4, "same task: nothing changes, still listed");
});
