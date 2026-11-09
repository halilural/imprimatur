// The meeting record kind (#167): a meeting's note, its decisions and to-dos as child records,
// the migration that lets an existing database hold it, and the task page's Meetings tab.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb, MIGRATIONS, VERSION, KINDS } = req("../vscode/db.js");
const tv = req("../vscode/tasksView.js");

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

  // #169: meetings have a tab of their own, not one on the task page.
  assert.ok(tv.TABS.includes("meetings"));
  const model = tv.meetingsModel(db, root, {});
  assert.equal(model.meetings.length, 1);
  assert.equal(model.meetings[0].task.key, "LATD-1");
  assert.deepEqual(model.meetings[0].decisions.map((/** @type {any} */ k) => k.title), ["Payments move to Kafka"]);
  assert.deepEqual(model.meetings[0].todos.map((/** @type {any} */ k) => k.title), ["Write the retry policy"]);
  const html = tv.paneHtml(db, root, { tab: "meetings" }, { waiting: [] });
  assert.match(html, /<h1>Meetings<\/h1>/);
  assert.match(html, /Payments weekly/);
  assert.match(html, /data-act="open" data-id="\d+"[^>]*>LATD-1<\/a>/);
  assert.match(html, /Write the retry policy <span class="owner me">You<\/span>/);
  const task = tv.paneHtml(db, root, { tab: "tasks", sel: t.id }, { waiting: [] });
  assert.doesNotMatch(task, /label="Meetings"|>Meetings</);
  // A dropped meeting leaves the list.
  db.updateRecord(m.id, { status: "dropped" }, AGENT);
  assert.equal(tv.meetingsModel(db, root, {}).meetings.length, 0);
});

test("an existing database gets the meeting kind; its records, versions and links stay", () => {
  const file = path.join(tmp(), "imprimatur.db");
  // The database as the version before #167 left it: the old kinds in the CHECK.
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys = ON");
  for (const sql of MIGRATIONS.slice(0, VERSION - 1)) old.exec(sql.replaceAll(", 'meeting'", ""));
  old.exec(`PRAGMA user_version = ${VERSION - 1}`);
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
