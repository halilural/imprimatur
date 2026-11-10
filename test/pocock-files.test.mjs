// #193: .out-of-scope/, docs/PROJECT.md, docs/capabilities/ with spec deltas merged, docs/agents/.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { sideFiles } = req("../vscode/docs-export.js");
const { syncDocs } = req("../vscode/docs-sync.js");
const agent = { kind: "agent", id: "s1" };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("Pocock's remaining files: out-of-scope read back, PROJECT.md, a done spec's deltas merged into its capability once", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-193-")));
  fs.mkdirSync(path.join(root, ".git"));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const oos = db.docOf(repo.id, "out-of-scope");
  db.upsertSection(oos.id, "dark-mode", { title: "Dark Mode", body: "This project does not support dark mode.\n\n## Why this is out of scope\n\nOne palette." }, agent);
  db.upsertSection(db.docOf(repo.id, "project").id, "why", { title: "Why", chapter: "mission", body: "Agents remember." }, agent);
  db.upsertTask(repo.id, "#30", { title: "Search" });
  const spec = db.taskDocOf(repo.id, "#30", "spec");
  db.upsertSection(spec.id, "search--ranking", { title: "Results are ranked", body: "By bm25.", delta: "added", chapter: "implementation" }, agent);
  syncDocs(db, root);
  assert.match(read(root, ".out-of-scope/dark-mode.md"), /\n# Dark Mode\n\nThis project does not support dark mode\./);
  assert.match(read(root, "docs/PROJECT.md"), /## Mission[\s\S]*Agents remember\./);
  assert.match(read(root, "docs/agents/issue-tracker.md"), /# Issue tracker: Imprimatur/);
  assert.ok(!fs.existsSync(path.join(root, "docs/capabilities")), "no capability while the spec's task is open");
  // The task is done: its delta lands in the capability, once.
  db.upsertTask(repo.id, "#30", { status: "done" });
  sideFiles(db, repo, root);
  assert.match(read(root, "docs/capabilities/search.md"), /Results are ranked[\s\S]*By bm25\./);
  const cap = db.taskDocFind(repo.id, "search", "capability");
  db.upsertSection(cap.id, "ranking", { body: "By bm25, Turkish folded." }, agent);
  sideFiles(db, repo, root);
  assert.equal(db.docSection(cap.id, "ranking").body, "By bm25, Turkish folded.", "merged once, a later edit stays");
  // An edit of the concept file reaches the database.
  const f = path.join(root, ".out-of-scope/dark-mode.md");
  fs.writeFileSync(f, read(root, ".out-of-scope/dark-mode.md").replace("One palette.", "One palette, set at build time."));
  sideFiles(db, repo, root);
  assert.match(db.docSection(oos.id, "dark-mode").body, /set at build time/);
});
