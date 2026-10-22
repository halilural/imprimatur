// Anlama borcu (#92): when the user last read each section, what is unread since, by task,
// and where the panel shows it.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb, MIGRATIONS } = req("../vscode/db.js");
const tv = req("../vscode/tasksView.js");
const docs = req("../vscode/docsView.js");
const { DatabaseSync } = req("node:sqlite");

const agent = { kind: "agent", id: "claude-code:S1" };
const user = { kind: "user", id: "u" };
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-92-")), "imprimatur.db");

function seeded() {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/a/proj");
  const task = db.upsertTask(repo.id, "#92", { title: "Reads" }, agent);
  const other = db.upsertTask(repo.id, "#7", { title: "Other" }, agent);
  const adr = db.addRecord(task.id, { kind: "adr", title: "Reads are device-local" }, agent);
  const doc = db.docOf(repo.id, "architecture");
  return { db, repo, task, other, adr, doc };
}

test("migration 7: sections already there count as read", () => {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 6)) raw.exec(m);
  raw.exec("PRAGMA user_version = 6");
  raw.exec(`INSERT INTO repos (id, uid, root, created_at) VALUES (1, 'r', '/a/p', 1);
    INSERT INTO documents (id, uid, repo_id, kind, title, updated_at) VALUES (1, 'd', 1, 'architecture', 'Mimari', 1);
    INSERT INTO doc_sections (id, uid, doc_id, key, title, body, position, updated_at) VALUES (1, 's', 1, 'storage', 'Storage', 'x', 1, 1);
    INSERT INTO doc_versions (section_id, at, actor_kind, after) VALUES (1, 1, 'agent', '{"body":"x"}');`);
  raw.close();
  const db = openDb({ path: file });
  assert.deepEqual(db.unreadSections(1), []);
  assert.deepEqual({ ...db.sqlite.prepare("SELECT version_id FROM section_reads WHERE section_id = 1").get() }, { version_id: 1 });
  db.close();
});

test("migration 8: a database with migration 7's draft table (no version_id) gets the real one", () => {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 6)) raw.exec(m);
  raw.exec(`CREATE TABLE section_reads (section_id INTEGER PRIMARY KEY REFERENCES doc_sections(id), at INTEGER NOT NULL);
    INSERT INTO repos (id, uid, root, created_at) VALUES (1, 'r', '/a/p', 1);
    INSERT INTO documents (id, uid, repo_id, kind, title, updated_at) VALUES (1, 'd', 1, 'architecture', 'Mimari', 1);
    INSERT INTO doc_sections (id, uid, doc_id, key, title, body, position, updated_at) VALUES (1, 's', 1, 'storage', 'Storage', 'x', 1, 1);
    INSERT INTO doc_versions (section_id, at, actor_kind, after) VALUES (1, 1, 'agent', '{"body":"x"}');
    INSERT INTO section_reads (section_id, at) VALUES (1, 5);
    PRAGMA user_version = 7;`);
  raw.close();
  const db = openDb({ path: file });
  assert.deepEqual(db.unreadSections(1), []);
  db.upsertSection(1, "storage", { body: "y" }, agent);
  assert.equal(db.unreadSections(1).length, 1);
  db.close();
});

test("an agent's change is unread until the user reads it; the user's own is read", () => {
  const { db, repo, adr, doc } = seeded();
  db.upsertSection(doc.id, "reads", { title: "Reads", body: "one", records: [adr.id] }, agent, { at: 1000 });
  const [u] = db.unreadSections(repo.id);
  assert.deepEqual([u.key, u.kind, u.tasks], ["reads", "architecture", ["#92"]]);
  db.markSectionsRead([u.id], 2000);
  assert.deepEqual(db.unreadSections(repo.id), []);
  // Only links or position changed: nothing to read.
  db.upsertSection(doc.id, "reads", { position: 5 }, agent, { at: 3000 });
  assert.deepEqual(db.unreadSections(repo.id), []);
  db.upsertSection(doc.id, "reads", { body: "two" }, agent, { at: 4000 });
  assert.equal(db.unreadSections(repo.id).length, 1);
  db.upsertSection(doc.id, "reads", { body: "three" }, user, { at: 5000 });
  assert.deepEqual(db.unreadSections(repo.id), []);
  // Replayed with a time before the read (an analysis re-read): still unread.
  db.upsertSection(doc.id, "reads", { body: "four" }, agent, { at: 10 });
  assert.equal(db.unreadSections(repo.id).length, 1);
  db.markSectionsRead([db.docSection(doc.id, "reads").id]);
  // Synced from another device: reads are this device's, not counted.
  db.upsertSection(doc.id, "reads", { body: "five" }, { kind: "import", id: "sync" });
  assert.deepEqual(db.unreadSections(repo.id), []);
  assert.throws(() => db.markSectionsRead([999]), /no section 999/);
  db.close();
});

test("a task's analysis is unread on that task; a superseded section is not", () => {
  const { db, repo, doc } = seeded();
  const ana = db.taskDocOf(repo.id, "#7");
  db.upsertSection(ana.id, "plan", { title: "Plan", body: "p" }, agent);
  assert.deepEqual(db.unreadSections(repo.id).find((s) => s.key === "plan").tasks, ["#7"]);
  db.upsertSection(doc.id, "old", { title: "Old", body: "o" }, agent);
  db.upsertSection(doc.id, "old", { status: "superseded" }, user);
  assert.ok(!db.unreadSections(repo.id).some((s) => s.key === "old"));
  db.close();
});

test("the panel: unread by task on the list, the task page and Ana sayfa; Okudum marks it read", () => {
  const { db, repo, task, adr, doc } = seeded();
  db.upsertSection(doc.id, "reads", { title: "Reads", body: "one", records: [adr.id] }, agent);
  const openEdits = new Map([["#92", 2], ["", 1]]);
  const page = tv.tasksPage(db, "/a/proj", { sel: task.id, filter: "open" }, { openEdits });
  assert.equal(page.groups[0].tasks.find((t) => t.key === "#92").unread, 3);
  assert.equal(page.groups[0].tasks.find((t) => t.key === "#7")?.unread ?? 0, 0);
  assert.equal(page.cur.unread.edits, 2);
  assert.deepEqual(page.cur.unread.sections.map((s) => [s.tab, s.key, s.label]), [["architecture", "reads", "Mimari"]]);
  const html = tv.tasksHtml(page);
  assert.match(html, /3 okunmadı/);
  assert.match(html, /Okumadıkların · 3/);
  assert.match(html, /2 düzenleme kabul edilmedi/);
  const home = tv.homeModel(db, "/a/proj", { openEdits });
  assert.deepEqual([home.unread.edits, home.unread.sections.length], [3, 1]);
  assert.match(tv.homeHtml(home), /Okumadıkların · 4/);
  const m = docs.docModel(db, "/a/proj", "architecture");
  assert.ok(m.current.find((s) => s.key === "reads").unread);
  assert.match(docs.docHtml(m), /Okunmadı/);
  tv.applyMessage(db, { type: "read", ids: [m.unread[0]] }, user, "/a/proj");
  assert.deepEqual(db.unreadSections(repo.id), []);
  assert.doesNotMatch(tv.tasksHtml(tv.tasksPage(db, "/a/proj", { sel: task.id }, {})), /Okumadıkların/);
  assert.throws(() => tv.applyMessage(db, { type: "read", ids: [] }, user, "/a/proj"), /bad section ids/);
  db.close();
});

test("the status line's edit count: fresh from the extension, else none", () => {
  const { writeUnread, readUnread, UNREAD_FILE } = req("../vscode/review-state.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-92-root-"));
  assert.equal(readUnread(root), 0);
  writeUnread(root, 4);
  assert.equal(readUnread(root), 4);
  assert.equal(readUnread(root, Date.now() + 16 * 60 * 1000), 0);
  assert.ok(fs.existsSync(path.join(root, UNREAD_FILE)));
});

test("a placeholder's section merged into the repo's takes its read with it", () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/b/proj");
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "here" }, user);
  // The same section synced before this repo had its origin: a placeholder repo holds it.
  const r = db.applyRemote([{ entity: "section", key: "github.com/u/proj\tarchitecture\tstorage", field: "title", value: '"Storage"', at: Date.now(), device: "d" }]);
  assert.equal(r.applied, 1);
  const ph = db.repos().find((x) => x.root.startsWith("origin:"));
  db.markSectionsRead([db.docSection(db.docFind(ph.id, "architecture").id, "storage").id]);
  db.repoOf("/b/proj", { origin: "git@github.com:u/proj.git" });
  assert.equal(db.repos().filter((x) => x.root.startsWith("origin:")).length, 0);
  assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});
