// #189: BM25 over records and sections, Turkish folding, prefix on the last word, snippets.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { rankedSearch, fold, askPrompt } = req("../vscode/search-index.js");
const agent = { kind: "agent", id: "s1" };

test("ranked search: every word must match, the last as a prefix; Turkish letters fold; title beats body; sections too", () => {
  assert.equal(fold("İstanbul Çiğdem ığ"), "istanbul cigdem ig");
  const db = openDb({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-189-")), "x.db") });
  const repo = db.repoOf("/r");
  const t = db.upsertTask(repo.id, "#1", { title: "T" });
  db.addRecord(t.id, { kind: "note", title: "Senkronizasyon hatası", body: "WAL büyüdü." }, agent);
  db.addRecord(t.id, { kind: "decision", title: "Something else", body: "We talked about senkronizasyon once." }, agent);
  db.addRecord(t.id, { kind: "note", title: "Unrelated", body: "nothing" }, agent);
  db.upsertSection(db.docOf(repo.id, "glossary").id, "wal", { title: "WAL", body: "Write-ahead log of SQLite." }, agent);
  const hits = rankedSearch(db, "senkronizasyon", { repoId: repo.id });
  assert.deepEqual(hits.map((h) => h.title), ["Senkronizasyon hatası", "Something else"], "title first");
  assert.equal(rankedSearch(db, "hatasi", { repoId: repo.id })[0]?.title, "Senkronizasyon hatası", "ı folds to i");
  assert.equal(rankedSearch(db, "senkronizasyon wa", { repoId: repo.id }).length, 1, "the last word as a prefix; every word must match");
  const sec = rankedSearch(db, "write-ahead", { repoId: repo.id });
  assert.equal(sec[0].type, "section");
  assert.match(sec[0].snippet, /Write-ahead log/);
  assert.match(askPrompt("why?", sec), /\[1\] glossary: WAL/);
});
