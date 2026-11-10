// #185: the migration's dry run asks the model for one target per item and reads its JSON back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptFor, parseAnswer, TARGETS } from "../scripts/migrate-pocock.mjs";

test("migrate dry run: the prompt names every target and the items; a JSON answer is read, a bad target left out", () => {
  const p = promptFor("imprimatur", "sections", [{ key: "architecture/storage", title: "Storage", body: "SQLite, one file per device." }]);
  for (const t of ["project:mission", "capability", "spec", "adr", "glossary", "out-of-scope", "drop"]) assert.ok(p.includes(t), t);
  assert.match(promptFor("r", "PDRs", [{ key: "pdr/1", title: "T", body: "", issue: "#7 open" }]), /"issue":"#7 open"/);
  assert.match(p, /"key":"architecture\/storage"/);
  const a = parseAnswer('Here: [{"key":"a","target":"adr","reason":"hard to reverse"},{"key":"b","target":"maybe","reason":"x"}]');
  assert.deepEqual(a.map((x) => x.key), ["a"]);
  assert.equal(parseAnswer("no json"), undefined);
  assert.equal(TARGETS.length, 10);
});

test("migrate apply: each item lands at its target, its source is marked, a second apply skips the repo", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { openDb } = require("../vscode/db.js");
  const { applyRepo } = await import("../scripts/migrate-pocock.mjs");
  const db = openDb();
  const repo = db.repoOf("/tmp/r185");
  const A = { kind: "user" };
  const arch = db.docOf(repo.id, "architecture");
  db.upsertSection(arch.id, "storage", { title: "Storage", body: "SQLite, chosen over Postgres." }, A);
  db.upsertSection(arch.id, "sync", { title: "Sync (#7)", body: "How sync works today." }, A);
  db.upsertSection(arch.id, "old", { title: "Old", body: "Gone." }, A);
  db.upsertSection(arch.id, "auth", { title: "Auth", body: "Tokens over sessions." }, A);
  const task = db.upsertTask(repo.id, "#7", { title: "Sync" }, A);
  const pdr = db.addRecord(task.id, { kind: "pdr", title: "Target: offline sync", body: "Later." }, A);
  const pdr2 = db.addRecord(task.id, { kind: "pdr", title: "Device time wins", body: "Trade-off." }, A);
  const an = db.taskDocOf(repo.id, "#7");
  db.upsertSection(an.id, "notes", { title: "Notes", body: "x" }, A);
  const got = applyRepo(db, repo, [
    { key: "architecture/storage", target: "project:stack" },
    { key: "architecture/sync", target: "capability", name: "sync", task: "#7" },
    { key: "architecture/old", target: "drop" },
    { key: "architecture/auth", target: "adr" },
    { key: `pdr/${pdr.id}`, target: "spec", task: "#7" },
    { key: `pdr/${pdr2.id}`, target: "adr", task: "#7" },
  ]);
  assert.deepEqual(got, { "project:stack": 1, capability: 1, drop: 1, spec: 1, adr: 2, "analysis superseded": 1 });
  const stack = db.docSections(db.docOf(repo.id, "project").id);
  assert.equal(stack[0].chapter, "stack");
  assert.equal(db.docSections(db.taskDocFind(repo.id, "sync", "capability").id)[0].body, "How sync works today.");
  assert.equal(db.docSections(db.taskDocFind(repo.id, "#7", "spec").id)[0].chapter, "notes");
  assert.equal(db.record(pdr2.id).kind, "adr");
  const home = db.taskByKey(repo.id, "pocock-migration");
  assert.equal(home.status, "done");
  assert.deepEqual(db.q("SELECT title FROM records WHERE task_id = ? AND kind = 'adr'").all(home.id).map((r) => r.title), ["Auth"]);
  assert.equal(db.record(pdr.id).status, "dropped");
  assert.ok(db.docSections(arch.id).every((s) => s.status === "superseded"));
  assert.equal(db.docSections(an.id)[0].status, "superseded");
  assert.deepEqual(applyRepo(db, repo, []), { skipped: true });
});

test("migrate refine: the prompts carry the items and ask for one answer per key", async () => {
  const { adrPrompt, namesPrompt } = await import("../scripts/migrate-pocock.mjs");
  const items = Array.from({ length: 60 }, (_, i) => ({ key: `architecture/s${i}`, title: `S${i}`, body: "b", name: `n${i}` }));
  assert.match(adrPrompt("r", items.slice(0, 2)), /"adr": true\|false[\s\S]*"key":"architecture\/s0"/);
  const np = namesPrompt("r", items);
  assert.match(np, /10 or fewer/);
  assert.match(np, /"draft":"n59"/);
});
