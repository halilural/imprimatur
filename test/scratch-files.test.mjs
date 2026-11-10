// #192: Pocock's local tracker under .scratch/: spec, map, tickets; edits read back; out of git by default.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { sideFiles } = req("../vscode/docs-export.js");
const agent = { kind: "agent", id: "s1" };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

test(".scratch/: spec and tickets written, a ticket's Status and a spec's text read back, gitignored", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-192-")));
  fs.mkdirSync(path.join(root, ".git"));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#20", { title: "Search" });
  const spec = db.taskDocOf(repo.id, "#20", "spec");
  db.upsertSection(spec.id, "problem", { title: "Finding a record", chapter: "problem", body: "Search misses words." }, agent);
  db.upsertTask(repo.id, "#22", { title: "Rank by bm25", epicId: task.id, blockedBy: ["#21"] });
  db.upsertTask(repo.id, "#21", { title: "Which index?", epicId: task.id, ticketType: "research", status: "active" });
  sideFiles(db, repo, root);
  assert.equal(read(root, ".scratch/.gitignore").split("\n").at(-2), "*");
  const specText = read(root, ".scratch/20/spec.md");
  assert.match(specText, /## Problem Statement[\s\S]*Finding a record[\s\S]*Search misses words\./);
  const t1 = read(root, ".scratch/20/issues/01-which-index.md");
  assert.match(t1, /^Status: claimed\nType: research$/m);
  assert.match(read(root, ".scratch/20/issues/02-rank-by-bm25.md"), /^Status: open\nBlocked by: 01$/m);
  // Edits in the files reach the database.
  fs.writeFileSync(path.join(root, ".scratch/20/issues/01-which-index.md"), t1.replace("Status: claimed", "Status: resolved"));
  fs.writeFileSync(path.join(root, ".scratch/20/spec.md"), specText.replace("Search misses words.", "Search misses Turkish words."));
  sideFiles(db, repo, root);
  assert.equal(db.taskByKey(repo.id, "#21").status, "done");
  assert.equal(db.docSection(spec.id, "problem").body, "Search misses Turkish words.");
  assert.match(read(root, ".scratch/20/issues/01-which-index.md"), /^Status: resolved$/m);
  // A repo that keeps .scratch/ in git loses the ignore file.
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/imprimatur.json"), JSON.stringify({ scratch: { commit: true } }));
  sideFiles(db, repo, root);
  assert.ok(!fs.existsSync(path.join(root, ".scratch/.gitignore")));
});
