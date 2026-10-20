#!/usr/bin/env node
// The one-time backfill of a repo's task analyses from past sessions
// (vscode/analysis-backfill.js), started detached by the SessionStart hook; also by hand:
//
//   node hooks/analysis-backfill.mjs <repo root>
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.argv[2];
try {
  const db = require("../vscode/db.js").openDb();
  const repo = db.repoByRoot(root);
  if (repo) await require("../vscode/analysis-backfill.js").runBackfill(db, repo.id, root);
  db.close();
} catch (e) {
  process.stderr.write(`imprimatur analysis backfill: ${e instanceof Error ? e.message : e}\n`);
}
process.exit(0);
