#!/usr/bin/env node
// Takes a repo's task analyses from its past Claude sessions and its files into Imprimatur's
// database (vscode/analysis-backfill.js); safe to run again: only newer states are added.
//
//   npm run analysis -- [repo ...] [--dry-run] [--no-model]
//     --dry-run   what would be taken, nothing written, no model calls
//     --no-model  only files the path or headings call analyses (no Haiku)
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { repoRoot } = require("../vscode/review-state.js");
const { originOf } = require("../vscode/import.js");
const { backfill, summary } = require("../vscode/analysis-backfill.js");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const model = !argv.includes("--no-model");
const repos = argv.filter((x) => !x.startsWith("--"));
const db = require("../vscode/db.js").openDb();
let failed = false;
try {
  for (const arg of repos.length ? repos : [process.cwd()]) {
    const root = repoRoot(path.resolve(arg));
    if (!root) {
      console.error(`${arg}: not inside a git repo`);
      failed = true;
      continue;
    }
    const repo = dryRun ? db.repoByRoot(root) ?? { id: -1 } : db.repoOf(root, { origin: originOf(root) });
    const r = await backfill(db, repo.id, root, { dryRun, model });
    console.log(`${root}: ${summary(r)}${dryRun ? " (dry run: nothing written)" : ""}`);
    if (r.tasks.length) console.log(`  tasks: ${r.tasks.join(", ")}`);
  }
} finally {
  db.close();
}
process.exit(failed ? 1 : 0);
