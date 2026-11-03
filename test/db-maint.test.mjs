// #117: the WAL is bounded, free pages are given back, the one VACUUM runs in a worker.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { openDb, WAL_LIMIT } = require("../vscode/db.js");
const { maintainDb } = require("../vscode/db-maint.js");

const DAY = 24 * 60 * 60 * 1000;
const fresh = () => openDb({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-maint-")), "imprimatur.db") });
const pragma = (db, p) => Object.values(db.sqlite.prepare(`PRAGMA ${p}`).get())[0];
/** 8 MB written, then deleted: free pages, and a WAL that grew past its limit. */
const churn = (db) => {
  db.sqlite.exec("CREATE TABLE IF NOT EXISTS junk (b BLOB)");
  const ins = db.sqlite.prepare("INSERT INTO junk (b) VALUES (randomblob(4000))");
  db.sqlite.exec("BEGIN");
  for (let i = 0; i < 2000; i++) ins.run();
  db.sqlite.exec("COMMIT");
  db.sqlite.exec("DELETE FROM junk");
};

test("db upkeep: every connection bounds its WAL to 4 MB", () => {
  const db = fresh();
  assert.equal(pragma(db, "journal_size_limit"), WAL_LIMIT);
  db.close?.();
});

test("db upkeep: once a day; checkpoint truncates the WAL; a VACUUM in a worker when free pages pass 5%, none when they do not", async () => {
  const db = fresh();
  churn(db);
  const t0 = 1_800_000_000_000;
  const lines = [];
  const r = await maintainDb(db, (l) => lines.push(l), { now: t0 });
  assert.ok(r.vacuum, "a file with many free pages asks for the VACUUM");
  assert.ok(r.vacuumed && r.vacuumed.after < r.vacuumed.before, JSON.stringify(r.vacuumed));
  assert.ok(fs.statSync(`${db.file}-wal`).size <= WAL_LIMIT, "the WAL is back under its limit");
  assert.ok(pragma(db, "freelist_count") / pragma(db, "page_count") < 0.05, "under 5% free after it");
  assert.ok(lines.some((l) => /VACUUM, [\d.]+ MB → [\d.]+ MB/.test(l)), lines.join("\n"));
  // The same day, from this or another process: nothing.
  assert.equal(await maintainDb(db, () => {}, { now: t0 + 60_000 }), undefined);
  // A day later, little churn: under 5% free, no VACUUM.
  db.sqlite.exec("INSERT INTO junk (b) VALUES (randomblob(4000))");
  db.sqlite.exec("DELETE FROM junk");
  const next = await maintainDb(db, () => {}, { now: t0 + DAY + 1, vacuum: () => assert.fail("no VACUUM under 5%") });
  assert.equal(next.vacuum, false);
  // Much churn again: the next day's run vacuums again.
  churn(db);
  const third = await maintainDb(db, () => {}, { now: t0 + 2 * DAY + 2 });
  assert.ok(third.vacuum && third.vacuumed, JSON.stringify(third));
});

test("db upkeep: a failed VACUUM is logged and the upkeep goes on", async () => {
  const db = fresh();
  churn(db);
  const lines = [];
  const r = await maintainDb(db, (l) => lines.push(l), { now: 1_800_000_000_000, vacuum: async () => { throw new Error("database is locked"); } });
  assert.ok(r.vacuum && !r.vacuumed);
  assert.ok(lines.some((l) => /VACUUM failed .*locked/.test(l)));
});
