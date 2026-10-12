// docUpdate follows stale sections and decisions; where_we_left_off tells how the design
// documents stand (#74).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, digest } from "../mcp/server.mjs";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { check } = req("../vscode/process.js");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-74-")));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function setup(proc = {}) {
  const root = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify({
    process: { status: false, whereWeLeftOff: false, branchFinish: false, mainGuard: false, designFirst: false, docSync: false, ...proc },
  }));
  const db = openDb({ path: path.join(tmpDir(), "imprimatur.db") });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#74");
  const records = { dbOf: () => db, repoId: () => repo.id, recordsOf: () => [] };
  const run = (event, extra = {}, session = "S1") => check(event, { cwd: root, session_id: session, ...extra }, { records });
  return { root, db, repo, task, run };
}

test("docUpdate: a linked ADR changed after its section is told (stale); the section updated, nothing", () => {
  const { db, repo, task, run } = setup();
  const adr = db.addRecord(task.id, { kind: "adr", title: "SQLite" }, agent);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "SQLite.", addRecords: [adr.id] }, agent);
  sleep(5);
  db.updateRecord(adr.id, { body: "SQLite in WAL mode" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_update", tool_input: { id: adr.id, body: "SQLite in WAL mode" } });
  run("Stop");
  const told = run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(told.context, [`Imprimatur (docUpdate): ADR #${adr.id} güncellendi ama bağlı olduğu bölüm (architecture/storage) ondan sonra değişmedi: doc_section_upsert ile bölümün metnini kayda göre güncelle.`]);
  // Updated after the record: nothing.
  db.updateRecord(adr.id, { body: "SQLite, one file" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_update", tool_input: { id: adr.id, body: "SQLite, one file" } });
  sleep(5);
  db.upsertSection(doc.id, "storage", { body: "SQLite, one file per device." }, agent);
  run("Stop");
  assert.deepEqual(run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), {});
});

test("docUpdate: a decision is followed once a section links it; an unlinked one is not a design record", () => {
  const { db, repo, task, run } = setup({ docUpdate: "block" });
  const free = db.addRecord(task.id, { kind: "decision", title: "Sprints start on Saturday" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_add", tool_input: { task: "#74", kind: "decision", title: free.title }, tool_response: `Added [${free.id}] decision/open` });
  assert.deepEqual(run("Stop"), {});
  const dec = db.addRecord(task.id, { kind: "decision", title: "Debounce 2 s" }, agent);
  db.upsertSection(db.docOf(repo.id, "architecture").id, "export", { title: "Export", body: "2 s.", addRecords: [dec.id] }, agent);
  sleep(5);
  db.updateRecord(dec.id, { title: "Debounce 3 s" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_update", tool_input: { id: dec.id, title: "Debounce 3 s" } });
  assert.match(run("Stop").block, new RegExp(`Karar #${dec.id} güncellendi ama bağlı olduğu bölüm \\(architecture/export\\)`));
});

test("where_we_left_off and session start tell how the design documents stand", () => {
  const { root, db, repo, task, run } = setup({ whereWeLeftOff: true });
  db.addRecord(task.id, { kind: "adr", title: "One" }, agent);
  db.addRecord(task.id, { kind: "adr", title: "Two" }, agent);
  const pdr = db.addRecord(task.id, { kind: "pdr", title: "Tabs" }, agent);
  db.upsertSection(db.docOf(repo.id, "product").id, "tabs", { title: "Tabs", addRecords: [pdr.id] }, agent);
  const out = callTool(db, "where_we_left_off", { repo: root });
  assert.deepEqual(out.docs, { architecture: { sections: 0, unlinked: 2, conflicts: [] }, product: { sections: 1, unlinked: 0, conflicts: [] } });
  assert.match(out.docs_problem, /^Design documents: architecture: 0 sections, 2 ADRs no section links\./);
  assert.match(digest("where_we_left_off", out), /\nDesign documents: architecture: 0 sections, 2 ADRs/);
  assert.match(run("SessionStart").context.join("\n"), /Design documents: architecture: 0 sections, 2 ADRs no section links/);
  // All linked: no line.
  const doc = db.docOf(repo.id, "architecture");
  const ids = db.recordsByKind(repo.id, ["adr"], { limit: 10 }).map((r) => r.id);
  db.upsertSection(doc.id, "all", { title: "All", addRecords: ids }, agent);
  const ok = callTool(db, "where_we_left_off", { repo: root });
  assert.equal(ok.docs_problem, undefined);
  assert.doesNotMatch(digest("where_we_left_off", ok), /Design documents/);
});

test("where_we_left_off leaves out the importer's record containers (ADR, PDR, TEST) unless one has a 👉 (#75)", () => {
  const { root, db, repo, task } = setup();
  for (const key of ["ADR", "PDR", "TEST"]) db.addRecord(db.upsertTask(repo.id, key, {}).id, { kind: "note", title: `in ${key}`, status: "done" }, agent);
  db.addRecord(task.id, { kind: "todo", title: "real work" }, agent);
  assert.deepEqual(callTool(db, "where_we_left_off", { repo: root }).tasks.map((t) => t.key), ["#74"]);
  const t = db.addRecord(db.taskByKey(repo.id, "TEST").id, { kind: "test", title: "MT-1 · run" }, agent);
  db.setPointer(t.id, agent);
  assert.deepEqual(callTool(db, "where_we_left_off", { repo: root }).tasks.map((x) => x.key).sort(), ["#74", "TEST"]);
});

test("panel home: the record containers go last in the task table and are not counted as open (#75)", () => {
  const { root, db, repo } = setup();
  const { homeModel } = req("../vscode/tasksView.js");
  db.upsertTask(repo.id, "#80", { title: "Work" });
  for (const key of ["ADR", "PDR"]) db.addRecord(db.upsertTask(repo.id, key, {}).id, { kind: "adr", title: `x ${key}` }, agent);
  const m = homeModel(db, root);
  assert.deepEqual(m.rows.slice(-2).map((r) => r.key).sort(), ["ADR", "PDR"]);
  assert.equal(m.open, 2, "#74 and #80, not the containers");
});
