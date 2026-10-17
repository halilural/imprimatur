#!/usr/bin/env node
// The one-time design-document backfill of a repo (vscode/docs-backfill.js), started
// detached by the SessionStart hook; also by hand:
//
//   node hooks/backfill.mjs <repo root>
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.argv[2];
try {
  const db = require("../vscode/db.js").openDb();
  const repo = db.repoByRoot(root);
  if (repo) await require("../vscode/docs-backfill.js").runBackfill(db, repo.id, root);
} catch (e) {
  process.stderr.write(`imprimatur backfill: ${e instanceof Error ? e.message : e}\n`);
}
process.exit(0);
