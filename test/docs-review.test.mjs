// Design documents (#72), review fixes: the export never overwrites a hand-written file or
// writes outside the repo; section bodies capped so they sync; received sections checked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool } from "../mcp/server.mjs";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { exportDocs, HEADER } = req("../vscode/docs-export.js");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-72r-")));
const tmpDb = () => path.join(tmpDir(), "imprimatur.db");
function seeded(root = "/a/proj", origin) {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf(root, origin ? { origin } : {});
  const task = db.upsertTask(repo.id, "#72", { title: "Docs" });
  const adr = db.addRecord(task.id, { kind: "adr", title: "SQLite is the source of truth" }, agent);
  const pdr = db.addRecord(task.id, { kind: "pdr", title: "Two tabs" }, agent);
  return { db, repo, task, adr, pdr };
}

test("export: a hand-written docs file is never overwritten; ours is rewritten", () => {
  const root = tmpDir();
  const { db, repo } = seeded(root);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "x" }, agent);
  fs.mkdirSync(path.join(root, "docs"));
  const file = path.join(root, "docs", "ARCHITECTURE.md");
  fs.writeFileSync(file, "# Our architecture\n\nWritten by hand.\n");
  assert.deepEqual(exportDocs(db, root).map((r) => [r.kind, r.written, r.skipped]), [["architecture", false, "manual"]]);
  assert.equal(fs.readFileSync(file, "utf8"), "# Our architecture\n\nWritten by hand.\n");
  // Ours (the header first): rewritten, and no note.
  fs.writeFileSync(file, `${HEADER}\n\nold\n`);
  assert.equal(exportDocs(db, root)[0].written, true);
});

test("export: a docs/ symlinked out of the repo, or a symlinked file, is refused", () => {
  const root = tmpDir();
  const away = tmpDir();
  const { db, repo } = seeded(root);
  db.upsertSection(db.docOf(repo.id, "architecture").id, "s", { title: "S" }, agent);
  fs.symlinkSync(away, path.join(root, "docs"));
  assert.deepEqual(exportDocs(db, root).map((r) => r.skipped), ["outside"]);
  assert.deepEqual(fs.readdirSync(away), []);
  fs.unlinkSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "docs"));
  const target = path.join(away, "x.md");
  fs.writeFileSync(target, `${HEADER}\n`);
  fs.symlinkSync(target, path.join(root, "docs", "ARCHITECTURE.md"));
  assert.deepEqual(exportDocs(db, root).map((r) => r.skipped), ["outside"]);
  assert.equal(fs.readFileSync(target, "utf8"), `${HEADER}\n`);
});

test("#185: a document with every section superseded loses its generated file; a hand-written one, or none in the database yet, stays", () => {
  const root = tmpDir();
  const { db, repo } = seeded(root);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "x" }, agent);
  exportDocs(db, root);
  const file = path.join(root, "docs", "ARCHITECTURE.md");
  assert.ok(fs.existsSync(file));
  db.upsertSection(doc.id, "storage", { status: "superseded" }, agent);
  const r = exportDocs(db, root).find((x) => x.kind === "architecture");
  assert.equal(r?.removed, true);
  assert.ok(!fs.existsSync(file), "the generated file goes");
  // Hand-written: never removed.
  fs.writeFileSync(file, "# Ours\n\nBy hand.\n");
  exportDocs(db, root);
  assert.ok(fs.existsSync(file));
  // A product document never written on this machine: its file is left alone.
  const pf = path.join(root, "docs", "PRODUCT.md");
  fs.writeFileSync(pf, `${HEADER}\n\nold\n`);
  exportDocs(db, root);
  assert.ok(fs.existsSync(pf), "no product document in the database: kept");
});

test("#203: once Architecture and Product are all superseded, the generated MADR files go; a hand-written one stays", () => {
  const root = tmpDir();
  const { db, repo } = seeded(root);
  const task = db.upsertTask(repo.id, "#1");
  db.addRecord(task.id, { kind: "adr", title: "Use SQLite", body: "Alternative: Postgres." }, agent);
  const arch = db.docOf(repo.id, "architecture");
  const prod = db.docOf(repo.id, "product");
  db.upsertSection(arch.id, "storage", { title: "Storage", body: "x" }, agent);
  db.upsertSection(prod.id, "tabs", { title: "Tabs", body: "y" }, agent);
  exportDocs(db, root);
  const dir = path.join(root, "docs", "decisions");
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("0001-")), "MADR files while the documents live");
  db.upsertSection(arch.id, "storage", { status: "superseded" }, agent);
  exportDocs(db, root);
  assert.ok(fs.existsSync(dir), "product still has a section: kept");
  fs.writeFileSync(path.join(dir, "notes.md"), "# Ours\n");
  db.upsertSection(prod.id, "tabs", { status: "superseded" }, agent);
  exportDocs(db, root);
  assert.deepEqual(fs.readdirSync(dir), ["notes.md"], "generated ones gone, the hand-written one kept");
});
