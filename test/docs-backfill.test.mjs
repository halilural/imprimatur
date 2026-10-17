// The one-time design-document backfill (docs-backfill.js): due only for a repo never
// backfilled, with enough records and something to write; claimed once; the run's outcome kept.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { check } = req("../vscode/process.js");
const bf = req("../vscode/docs-backfill.js");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-bf-")));

function setup(n = bf.MIN_RECORDS, kind = "adr") {
  const root = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const db = openDb({ path: path.join(tmpDir(), "imprimatur.db") });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#1");
  const recs = [];
  for (let i = 0; i < n; i++) recs.push(db.addRecord(task.id, { kind: i === 0 ? kind : "note", title: `r${i}`, body: `body ${i}` }, agent));
  return { root, db, repo, task, recs };
}

test("due: enough records and an empty document, never backfilled; not under MIN_RECORDS, not the home folder", () => {
  const { root, db, repo } = setup();
  assert.equal(bf.due(db, repo.id, root, "/nowhere"), true);
  assert.deepEqual(bf.targets(db, repo.id), ["architecture", "product", "glossary"]);
  assert.equal(bf.due(db, repo.id, root, root), false);
  const few = setup(bf.MIN_RECORDS - 1);
  assert.equal(bf.due(few.db, few.repo.id, few.root, "/nowhere"), false);
});

test("targets: a document with sections and every ADR linked is left out", () => {
  const { db, repo, recs } = setup();
  for (const kind of ["architecture", "product", "glossary"]) {
    db.upsertSection(db.docOf(repo.id, kind).id, "a", { title: "A", body: "x", addRecords: kind === "architecture" ? [recs[0].id] : [] }, agent);
  }
  assert.deepEqual(bf.targets(db, repo.id), []);
  const pdr = db.addRecord(db.upsertTask(repo.id, "#2").id, { kind: "pdr", title: "P" }, agent);
  assert.deepEqual(bf.targets(db, repo.id), ["product"]);
  assert.deepEqual(db.unlinkedRecords(repo.id, "pdr").map((r) => r.id), [pdr.id]);
});

test("maybeStart: claims once; a second session start does nothing", () => {
  const { root, db, repo } = setup();
  const started = [];
  const o = { start: (r) => started.push(r), home: "/nowhere" };
  assert.equal(bf.maybeStart(db, repo.id, root, o), true);
  assert.equal(bf.maybeStart(db, repo.id, root, o), false);
  assert.deepEqual(started, [root]);
  assert.equal(JSON.parse(db.meta(bf.metaKey(repo.id))).status, "running");
});

test("SessionStart starts it for a repo without .claude/imprimatur.json", () => {
  const { root, db, repo } = setup();
  const started = [];
  const records = { dbOf: () => db, repoId: () => repo.id, recordsOf: () => [] };
  check("SessionStart", { cwd: root, session_id: "S1" }, { records, backfill: { start: (r) => started.push(r), home: "/nowhere" } });
  assert.deepEqual(started, [root]);
});

test("promptFor lists the unlinked ADRs with their ids; runBackfill keeps the outcome", async () => {
  const { root, db, repo, recs } = setup();
  const prompt = bf.promptFor(db, repo.id, root, ["architecture", "glossary"], "Turkish");
  assert.match(prompt, new RegExp(`\\[${recs[0].id}\\] ADR \\(#1\\) r0`));
  assert.match(prompt, /in Turkish/);
  assert.ok(!prompt.includes("## product"));
  db.claimMeta(bf.metaKey(repo.id), JSON.stringify({ status: "running", started: 1 }));
  let call;
  const exec = async (cmd, args, opts) => {
    call = { cmd, args, opts };
    db.upsertSection(db.docOf(repo.id, "glossary").id, "term", { title: "Term", body: "x" }, agent);
    return { code: 0, stdout: JSON.stringify({ result: "glossary: 1", total_cost_usd: 0.5 }), stderr: "" };
  };
  await bf.runBackfill(db, repo.id, root, { exec, lang: "Turkish" });
  assert.equal(call.cmd, "claude");
  assert.ok(call.args.includes("mcp__imprimatur__doc_section_upsert"));
  assert.ok(!call.args.includes("Edit") && !call.args.includes("Bash"));
  const m = JSON.parse(db.meta(bf.metaKey(repo.id)));
  assert.equal(m.status, "done");
  assert.equal(m.started, 1);
  assert.equal(m.cost, 0.5);
  assert.equal(m.sections.glossary, 1);
});
