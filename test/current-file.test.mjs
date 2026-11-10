// #200: the Current File view's items: decisions first, then records, the file's edits, the sections read from it.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { currentFileModel } = req("../vscode/currentFile.js");
const agent = { kind: "agent", id: "s" };

test("current file: records naming the file (ADRs first), its edits newest first, nothing about other files", () => {
  const db = openDb({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-200-")), "x.db") });
  const repo = db.repoOf("/r");
  const t = db.upsertTask(repo.id, "#1", { title: "T" });
  db.addRecord(t.id, { kind: "note", title: "Touched the store", links: { files: ["src/store.js"] } }, agent);
  db.addRecord(t.id, { kind: "adr", title: "SQLite is the source of truth", links: { files: ["src/store.js"] } }, agent);
  db.addRecord(t.id, { kind: "adr", title: "Other file", links: { files: ["src/store.js.bak"] } }, agent);
  const rows = [{ file: "src/store.js", t: "2026-11-10T10:00:00Z", summary: "first" }, { file: "src/store.js", t: "2026-11-10T11:00:00Z", summary: "second", accepted: true }, { file: "x.js", t: "2026-11-10T12:00:00Z" }];
  const m = currentFileModel(db, repo.id, "src/store.js", rows);
  assert.deepEqual(m.records.map((r) => r.title), ["SQLite is the source of truth", "Touched the store"]);
  assert.deepEqual(m.edits.map((e) => [e.what, e.accepted]), [["second", true], ["first", false]]);
});
