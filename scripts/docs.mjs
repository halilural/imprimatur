#!/usr/bin/env node
// Syncs a repo's design documents with their Markdown files (#73); safe to run again.
//
//   npm run docs -- sync [repo ...] [--dry-run] [--take file|db] [--rev <git-rev>]
//
// --take settles conflicts (a section changed in the file and in Imprimatur); --rev
// adopts the files as they were at a git revision (a repo whose files went away after
// the #59 import), importing that revision's design and product records first.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { repoRoot } = require("../vscode/review-state.js");
const { syncDocs, describe } = require("../vscode/docs-sync.js");

const argv = process.argv.slice(2);
const value = (/** @type {string} */ flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const take = value("--take");
const rev = value("--rev");
const dryRun = argv.includes("--dry-run");
const [cmd, ...rest] = argv.filter((a) => !a.startsWith("--"));
if (cmd !== "sync" || (take !== undefined && take !== "file" && take !== "db")) {
  console.error("usage: npm run docs -- sync [repo ...] [--dry-run] [--take file|db] [--rev <git-rev>]");
  process.exit(2);
}
const db = require("../vscode/db.js").openDb();
let failed = false;
try {
  for (const arg of rest.length ? rest : [process.cwd()]) {
    const root = repoRoot(path.resolve(arg));
    if (!root) {
      console.error(`${arg}: not inside a git repo`);
      failed = true;
      continue;
    }
    // Asked for by hand: a hand-written file is adopted (its original kept in .claude/imprimatur/docs-backup/).
    const reports = syncDocs(db, root, { dryRun, take: /** @type {any} */ (take), rev, adopt: true });
    console.log(`${root}${dryRun ? " (dry run: nothing written)" : ""}`);
    for (const line of describe(reports, root)) console.log(`  ${line}`);
    if (reports.some((r) => r.conflicts.length)) failed = true;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  failed = true;
} finally {
  db.close();
}
process.exit(failed ? 1 : 0);
