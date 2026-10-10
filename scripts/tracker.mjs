#!/usr/bin/env node
// Syncs task status with the issue tracker (#70): GitHub Issues through gh, Jira through its API.
//
//   npm run tracker                  push queued status changes, pull this repo's issues
//   npm run tracker -- --all         ...pull every repo in the database
//   npm run tracker -- --dry-run     say what would change; write nothing (gh/Jira are only read)
//   npm run tracker -- --no-create   make no task from an open issue without one
//
// Jira: <database folder>/config.json {tracker: {jira: {baseUrl, email}}} and the token in
// IMPRIMATUR_JIRA_TOKEN (or tracker.jira.token, with the file at mode 0600).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDb, PLACEHOLDER } = require("../vscode/db.js");
const { trackerOnce, describe } = require("../vscode/tracker.js");
const { originOf } = require("../vscode/import.js");

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => !["--all", "--dry-run", "--no-create"].includes(a));
if (unknown.length) {
  console.error(`Imprimatur: unknown option ${unknown[0]} (use --all, --dry-run, --no-create)`);
  process.exit(2);
}
const dryRun = argv.includes("--dry-run");
const db = openDb();
let code = 0;
try {
  let repos;
  if (argv.includes("--all")) {
    repos = db.repos().filter((r) => !r.root.startsWith(PLACEHOLDER));
  } else {
    let root;
    try {
      root = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {}
    const repo = root && db.repoByRoot(root);
    if (!repo) console.log(`note: ${root ?? process.cwd()} has no tasks in Imprimatur; pushing only (--all pulls every repo)`);
    repos = repo ? [repo] : [];
  }
  const r = await trackerOnce(db, { repos, originOf, dryRun, createTasks: !argv.includes("--no-create"), log: (line) => console.log(line) });
  console.log(`${describe(r)}${dryRun ? " (dry run: nothing written)" : ""}`);
  if (r.errors.length) code = 1;
} catch (e) {
  console.error(`Imprimatur: ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  db.close();
}
process.exit(code);
