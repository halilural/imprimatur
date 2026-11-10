// What stays of #92 after the unread tracking was removed (#111): the agent's edits not accepted
// (Home, the task list and page, the status line), and old databases that still hold section_reads.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire as __cr } from "node:module";
const { dataPath } = __cr(import.meta.url)("../vscode/data-dir.js");

const req = createRequire(import.meta.url);
const { openDb, MIGRATIONS } = req("../vscode/db.js");
const { DatabaseSync } = req("node:sqlite");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-111-")), "imprimatur.db");

test("an old database with section_reads opens, migrates, and a section change does not touch the table", () => {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 6)) raw.exec(m);
  raw.exec(`CREATE TABLE section_reads (section_id INTEGER PRIMARY KEY REFERENCES doc_sections(id), at INTEGER NOT NULL);
    INSERT INTO repos (id, uid, root, created_at) VALUES (1, 'r', '/a/p', 1);
    INSERT INTO documents (id, uid, repo_id, kind, title, updated_at) VALUES (1, 'd', 1, 'architecture', 'Architecture', 1);
    INSERT INTO doc_sections (id, uid, doc_id, key, title, body, position, updated_at) VALUES (1, 's', 1, 'storage', 'Storage', 'x', 1, 1);
    INSERT INTO doc_versions (section_id, at, actor_kind, after) VALUES (1, 1, 'agent', '{"body":"x"}');
    INSERT INTO section_reads (section_id, at) VALUES (1, 5);
    PRAGMA user_version = 7;`);
  raw.close();
  const db = openDb({ path: file });
  assert.deepEqual({ ...db.sqlite.prepare("SELECT version_id FROM section_reads WHERE section_id = 1").get() }, { version_id: 1 });
  db.upsertSection(1, "storage", { body: "y" }, agent);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM section_reads").get().n, 1, "left as it was");
  assert.equal(typeof db.unreadSections, "undefined");
  assert.equal(typeof db.markSectionsRead, "undefined");
  db.close();
});

test("the status line's edit count: fresh from the extension, else none", () => {
  const { writeOpenEdits, readOpenEdits, OPEN_EDITS_FILE } = req("../vscode/review-state.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-111-root-"));
  assert.equal(readOpenEdits(root), 0);
  writeOpenEdits(root, 4);
  assert.equal(readOpenEdits(root), 4);
  assert.equal(readOpenEdits(root, Date.now() + 16 * 60 * 1000), 0);
  assert.ok(fs.existsSync(dataPath(root, OPEN_EDITS_FILE)));
});
