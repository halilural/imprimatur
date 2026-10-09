#!/usr/bin/env node
// Imports a repo's Markdown records into Imprimatur's database (#59); safe to run again.
//
//   npm run import -- [repo ...] [--dry-run]     (default: the current repo)
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { repoRoot } = require("../vscode/review-state.js");
const { importRepo, summary } = require("../vscode/import.js");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const verbose = argv.includes("--verbose");
const repos = argv.filter((a) => !a.startsWith("--"));
const db = dryRun ? null : require("../vscode/db.js").openDb();
let failed = false;
try {
  for (const arg of repos.length ? repos : [process.cwd()]) {
    const root = repoRoot(path.resolve(arg));
    if (!root) {
      console.error(`${arg}: not inside a git repo`);
      failed = true;
      continue;
    }
    const r = importRepo(db, root, { dryRun });
    console.log(`${root}: ${summary(r)}${dryRun ? " (dry run: nothing written)" : ""}`);
    for (const f of r.files) {
      if (verbose || f.unparsed.length || f.expected !== f.prefixed) {
        console.log(`  ${f.file}: ${f.records} records, ${f.added} new, ${f.updated} updated${f.expected !== f.prefixed ? `, count ${f.prefixed}/${f.expected}` : ""}`);
        for (const u of f.unparsed) console.log(`    kept as note: ${u.slice(0, 140)}`);
      }
      if (f.expected !== f.prefixed) failed = true;
    }
  }
} finally {
  db?.close();
}
process.exit(failed ? 1 : 0);
