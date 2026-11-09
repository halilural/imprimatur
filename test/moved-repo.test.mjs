// A checkout opened from another folder (#169): it joins the row of its origin when that row's
// folder is gone, instead of becoming a second, empty repo of the same name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { openDb } = createRequire(import.meta.url)("../vscode/db.js");
const ORIGIN = "https://gitlab.com/halil.ural/halil-workspace.git";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-moved-"));
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const old = path.join(dir, "bsci", "halil-workspace");
  fs.mkdirSync(old, { recursive: true });
  const full = db.repoOf(old, { origin: ORIGIN });
  db.upsertTask(full.id, "MEETINGS", { title: "Meetings" });
  const here = path.join(dir, "halil-workspace");
  fs.mkdirSync(here);
  return { dir, db, old, full, here };
}

test("a moved checkout takes over its origin's row", () => {
  const { db, old, full, here } = setup();
  fs.rmSync(old, { recursive: true });
  const r = db.repoOf(here, { origin: ORIGIN });
  assert.equal(r.id, full.id);
  assert.equal(r.root, here);
  assert.equal(db.repos().length, 1);
});

test("a folder seen before its origin: the empty row gives way once the origin is known", () => {
  const { db, old, full, here } = setup();
  fs.rmSync(old, { recursive: true });
  const early = db.repoOf(here);
  assert.notEqual(early.id, full.id);
  const r = db.repoOf(here, { origin: ORIGIN });
  assert.equal(r.id, full.id);
  assert.equal(r.root, here);
  assert.deepEqual(db.repos().map((/** @type {any} */ x) => x.id), [full.id]);
});

test("a second clone or worktree still on disk stays its own repo", () => {
  const { db, old, full, here } = setup();
  const r = db.repoOf(here, { origin: ORIGIN });
  assert.notEqual(r.id, full.id);
  assert.equal(db.repoByRoot(old).id, full.id);
  assert.equal(db.repos().length, 2);
});
