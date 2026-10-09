// Integration tests in a real VS Code extension host (#68): @vscode/test-cli
// downloads VS Code into .vscode-test/, opens a temp git repo with the extension
// from vscode/ loaded, and runs test/integration/*.test.cjs with Mocha inside it.
// The database is a temp file (IMPRIMATUR_DB) seeded here: a repo row for the
// workspace, a task and an open record that waits on the user (owner K).
// Run: npm run test:integration (builds first; on Linux it wraps in xvfb-run).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@vscode/test-cli";

const require = createRequire(import.meta.url);
const ext = path.join(import.meta.dirname, "vscode");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-it-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const workspace = path.join(tmp, "repo");
fs.mkdirSync(workspace);
execFileSync("git", ["init", "-q"], { cwd: workspace });
fs.writeFileSync(path.join(workspace, "README.md"), "# Integration test repo\n");
// The root as git spells it: the extension keys its repo row the same way.
const root = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8" }).trim());

const dbFile = path.join(tmp, "imprimatur.db");
const { openDb } = require(path.join(ext, "db.js"));
const db = openDb({ path: dbFile });
try {
  const repo = db.repoOf(root, { name: "it-repo" });
  const task = db.upsertTask(repo.id, "IT-1", { title: "Integration task", status: "active" });
  db.addRecord(task.id, { kind: "question", owner: "K", title: "Integration ask for the user" }, { kind: "agent", id: "it" });
} finally {
  db.close();
}

export default defineConfig({
  label: "integration",
  files: "test/integration/**/*.test.cjs",
  // A pinned stable build, so a new VS Code release does not change a run by itself.
  version: "1.140.0",
  extensionDevelopmentPath: ext,
  workspaceFolder: workspace,
  launchArgs: ["--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"],
  env: {
    IMPRIMATUR_DB: dbFile,
    IMPRIMATUR_DESCRIBE: "off",
    IMPRIMATUR_IT_ROOT: root,
  },
  mocha: { ui: "tdd", timeout: 30_000 },
});
