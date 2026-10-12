#!/usr/bin/env node
// Audits the agent setup with agnix (#77): every finding becomes a record of the
// root's AUDIT task; findings gone are marked applied, dismissed ones stay dismissed.
//
//   npm run audit -- [repo ...] [--global] [--dry-run]
//
// With no repo, the current one. --global also audits the home's agent folders
// (~/.claude, ~/.cursor, ~/.codex, ...), plugins included.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { repoRoot } = require("../vscode/review-state.js");
const { locateAgnix, auditRoot, describeSummary } = require("../vscode/setup-audit.js");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const global = argv.includes("--global");
const unknown = argv.filter((a) => a.startsWith("--") && a !== "--dry-run" && a !== "--global");
if (unknown.length) {
  console.error("usage: npm run audit -- [repo ...] [--global] [--dry-run]");
  process.exit(2);
}
const bin = locateAgnix();
const db = require("../vscode/db.js").openDb();
const rules = new Map();
let failed = false;
try {
  const repos = argv.filter((a) => !a.startsWith("--"));
  /** @type {Array<{root: string, global?: boolean}>} */
  const scopes = [];
  for (const arg of repos.length || !global ? (repos.length ? repos : [process.cwd()]) : []) {
    const root = repoRoot(path.resolve(arg));
    if (!root) {
      console.error(`${arg}: not inside a git repo`);
      failed = true;
      continue;
    }
    scopes.push({ root });
  }
  if (global) scopes.push({ root: (await import("node:os")).homedir(), global: true });
  for (const scope of scopes) {
    const s = auditRoot(db, scope, { bin, dryRun, rules });
    console.log(`${describeSummary(s)}${dryRun ? " (dry run: nothing written)" : ""}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  failed = true;
} finally {
  db.close();
}
process.exit(failed ? 1 : 0);
