// The meeting record kind (#167): a meeting's note, its decisions and to-dos as child records,
// the migration that lets an existing database hold it, and the Meetings page's model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb, MIGRATIONS, VERSION, KINDS } = req("../vscode/db.js");
const tv = req("../vscode/meetings.js");

const AGENT = { kind: "agent", id: "claude-code:s1" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-167-"));

test("a meeting holds its note; its decisions and to-dos hang under it", () => {
  const dir = tmp();
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const repo = db.repoOf(root, { name: "repo" });
  const t = db.upsertTask(repo.id, "LATD-1", { title: "Payments", status: "active" });
  const m = db.addRecord(t.id, { kind: "meeting", title: "Payments weekly", body: "## Özet\nKafka.", uid: "meeting:m1" }, AGENT);
  const d = db.addRecord(t.id, { kind: "decision", title: "Payments move to Kafka", parent_id: m.id }, AGENT);
  db.addRecord(t.id, { kind: "todo", owner: "K", title: "Write the retry policy", parent_id: m.id }, AGENT);
  assert.ok(KINDS.includes("meeting"));
  assert.equal(d.parent_id, m.id);

  // #169: meetings have a page of their own (the new panel's More, #202).
  const model = tv.meetingsModel(db, root, {});
  assert.equal(model.meetings.length, 1);
  assert.equal(model.meetings[0].task.key, "LATD-1");
  assert.deepEqual(model.meetings[0].decisions.map((/** @type {any} */ k) => k.title), ["Payments move to Kafka"]);
  assert.deepEqual(model.meetings[0].todos.map((/** @type {any} */ k) => k.title), ["Write the retry policy"]);
  // A generic title gives way to the note's bold first line; the gist is the summary's first sentence.
  const g = db.addRecord(t.id, { kind: "meeting", title: "Toplantı", body: "**Kafka cutover**\n\n## Özet\nWe agreed on **Kafka**. Then lunch.\n\n## Kararlar\n- x", uid: "meeting:m2" }, AGENT);
  const gm = tv.meetingsModel(db, root, {}).meetings.find((/** @type {any} */ x) => x.id === g.id);
  assert.equal(gm.title, "Kafka cutover");
  assert.equal(gm.gist, "We agreed on Kafka.");
  // Another repo's meetings stay out, even with the sticky "every repo" scope on.
  const other = db.repoOf(path.join(dir, "other"), { name: "other" });
  const ot = db.upsertTask(other.id, "X-1", { title: "Elsewhere" });
  db.addRecord(ot.id, { kind: "meeting", title: "Elsewhere sync", uid: "meeting:m3" }, AGENT);
  assert.equal(tv.meetingsModel(db, root, { all: true }).meetings.length, 2);
  db.updateRecord(g.id, { status: "dropped" }, AGENT);
  // A dropped meeting leaves the list.
  db.updateRecord(m.id, { status: "dropped" }, AGENT);
  assert.equal(tv.meetingsModel(db, root, {}).meetings.length, 0);
});

test("an existing database gets the meeting kind; its records, versions and links stay", () => {
  const file = path.join(tmp(), "imprimatur.db");
  // The database as the version before #167 left it: the old kinds in the CHECK.
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys = ON");
  // The meeting migration is the one that rebuilds records; later ones run on top of it.
  const MEET = MIGRATIONS.findIndex((sql) => sql.includes("CREATE TABLE records_new"));
  for (const sql of MIGRATIONS.slice(0, MEET)) old.exec(sql.replaceAll(", 'meeting'", ""));
  old.exec(`PRAGMA user_version = ${MEET}`);
  const now = Date.now();
  old.exec(`INSERT INTO repos (uid, name, root, created_at) VALUES ('r', 'repo', '/x', ${now})`);
  old.exec(`INSERT INTO tasks (uid, repo_id, key, title, status, created_at, updated_at) VALUES ('t', 1, '#1', 'T', 'open', ${now}, ${now})`);
  old.exec(`INSERT INTO records (uid, task_id, kind, title, position, created_at, updated_at) VALUES ('q', 1, 'question', 'Q?', 1, ${now}, ${now})`);
  old.exec(`INSERT INTO records (uid, task_id, kind, title, position, parent_id, created_at, updated_at) VALUES ('a', 1, 'answer', 'A', 2, 1, ${now}, ${now})`);
  old.exec(`INSERT INTO record_versions (record_id, at, actor_kind, op) VALUES (2, ${now}, 'agent', 'create')`);
  assert.throws(() => old.exec(`INSERT INTO records (uid, task_id, kind, title, position, created_at, updated_at) VALUES ('m', 1, 'meeting', 'M', 3, ${now}, ${now})`), /CHECK/);
  old.close();

  const db = openDb({ path: file });
  const m = db.addRecord(1, { kind: "meeting", title: "M" }, AGENT);
  assert.equal(m.kind, "meeting");
  db.close?.();
  const s = new DatabaseSync(file, { readOnly: true });
  assert.equal(s.prepare("PRAGMA user_version").get().user_version, VERSION);
  assert.equal(s.prepare("SELECT parent_id FROM records WHERE uid = 'a'").get().parent_id, 1);
  assert.equal(s.prepare("SELECT count(*) n FROM record_versions WHERE record_id = 2").get().n, 1);
  assert.deepEqual(s.prepare("PRAGMA foreign_key_check").all(), []);
  assert.match(s.prepare("SELECT sql FROM sqlite_schema WHERE name = 'record_versions'").get().sql, /REFERENCES "?records"?\(id\)/);
});

// #220: a meeting's raw transcript is its child record; the page joins the parts, search finds it.
test("a meeting's transcript hangs under it: joined on the page, found by search with its meeting", async () => {
  const { callTool, INSTRUCTIONS } = await import("../mcp/server.mjs");
  const dir = tmp();
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  (await import("node:child_process")).execFileSync("git", ["init", "-q", root]);
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const repo = db.repoOf(root, { name: "repo" });
  const t = db.upsertTask(repo.id, "MEETINGS", { title: "Toplantılar" });
  const m = db.addRecord(t.id, { kind: "meeting", title: "Payments weekly", body: "## Özet\nKafka.", uid: "meeting:m1" }, AGENT);
  db.addRecord(t.id, { kind: "decision", title: "Payments move to Kafka", parent_id: m.id, uid: "meeting:m1:d1" }, AGENT);
  db.addRecord(t.id, { kind: "transcript", title: "Transcript (1/2)", body: "Ali: we go to Kafka", parent_id: m.id, uid: "meeting:m1:x1" }, AGENT);
  db.addRecord(t.id, { kind: "transcript", title: "Transcript (2/2)", body: "Ayşe: and the zebra rollback stays", parent_id: m.id, uid: "meeting:m1:x2" }, AGENT);

  const page = tv.meetingsModel(db, root, {}).meetings[0];
  assert.equal(page.decisions.length, 1, "a transcript is no decision");
  assert.equal(page.todos.length, 0, "nor a to-do");
  assert.equal(page.transcript, "Ali: we go to Kafka\nAyşe: and the zebra rollback stays");

  // A word only the transcript holds: the hit is the transcript, naming its meeting.
  const out = callTool(db, "search", { text: "zebra", repo: root });
  assert.deepEqual(out.records.map((/** @type {any} */ r) => [r.kind, r.parent_id]), [["transcript", m.id]]);
  assert.match(INSTRUCTIONS, /on meetings read note and transcript/);
});

test("an existing database at the meeting version gets the transcript kind; its records stay", () => {
  const file = path.join(tmp(), "imprimatur.db");
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys = ON");
  const TRANSCRIPT = MIGRATIONS.length - 1;
  for (const sql of MIGRATIONS.slice(0, TRANSCRIPT)) old.exec(sql.replaceAll(", 'transcript'", ""));
  old.exec(`PRAGMA user_version = ${TRANSCRIPT}`);
  const now = Date.now();
  old.exec(`INSERT INTO repos (uid, name, root, created_at) VALUES ('r', 'repo', '/x', ${now})`);
  old.exec(`INSERT INTO tasks (uid, repo_id, key, title, status, created_at, updated_at) VALUES ('t', 1, 'MEETINGS', 'T', 'open', ${now}, ${now})`);
  old.exec(`INSERT INTO records (uid, task_id, kind, title, position, created_at, updated_at) VALUES ('meeting:a', 1, 'meeting', 'M', 1, ${now}, ${now})`);
  old.exec(`INSERT INTO records (uid, task_id, kind, title, position, parent_id, created_at, updated_at) VALUES ('meeting:a:d1', 1, 'decision', 'D', 2, 1, ${now}, ${now})`);
  assert.throws(() => old.exec(`INSERT INTO records (uid, task_id, kind, title, position, created_at, updated_at) VALUES ('x', 1, 'transcript', 'X', 3, ${now}, ${now})`), /CHECK/);
  old.close();

  const db = openDb({ path: file });
  const x = db.addRecord(1, { kind: "transcript", title: "Transcript", body: "hi", parent_id: 1 }, AGENT);
  assert.equal(x.kind, "transcript");
  db.close?.();
  const s = new DatabaseSync(file, { readOnly: true });
  assert.equal(s.prepare("PRAGMA user_version").get().user_version, VERSION);
  assert.equal(s.prepare("SELECT parent_id FROM records WHERE uid = 'meeting:a:d1'").get().parent_id, 1);
  assert.deepEqual(s.prepare("PRAGMA foreign_key_check").all(), []);
});
