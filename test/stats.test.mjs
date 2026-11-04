import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { openDb } = require("../vscode/db.js");

test("stats: the scoreboard counts this period against the one before", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "stats-"));
  const root = path.join(base, "proj");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const env = { ...process.env, IMPRIMATUR_DB: path.join(base, "imprimatur.db"), HOME: base };
  delete env.NODE_TEST_CONTEXT;
  const db = openDb({ path: env.IMPRIMATUR_DB });
  const repo = db.repoOf(root);
  const agent = { kind: "agent", id: "t" };
  const t = db.upsertTask(repo.id, "#1", { title: "One", status: "done" }, agent);
  db.addRecord(t.id, { kind: "adr", title: "Use SQLite" }, agent);
  db.upsertTask(repo.id, "#2", { title: "Two" }, agent);
  // One task finished in the period before this one.
  const old = Date.now() - 9 * 86_400_000;
  db.sqlite.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE key = '#2'").run(old, old);
  db.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE key = '#2'").run();
  db.sqlite.close?.();
  const out = execFileSync(process.execPath, [new URL("../skills/imprimatur-stats/stats.mjs", import.meta.url).pathname, root], { env, encoding: "utf8" });
  const line = (label) => out.split("\n").find((l) => l.includes(label)).replace(/[█·]/g, "").replace(/\s+/g, " ").trim();
  assert.match(out, /imprimatur stats\s+proj · last 7 days vs the 7 before/);
  assert.equal(line("Tasks finished"), "Tasks finished 1 1");
  assert.equal(line("Tasks opened"), "Tasks opened 1 1");
  assert.equal(line("Decisions"), "Decisions (ADR/PDR/decision) 1 0 new");
});
