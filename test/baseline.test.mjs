import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const hook = path.resolve(import.meta.dirname, "../hooks/baseline.mjs");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return { dir, git };
}

function run(dir, file, ...exts) {
  const input = JSON.stringify({ tool_name: "Edit", cwd: dir, tool_input: { file_path: path.join(dir, file) } });
  const r = spawnSync("node", [hook, ...exts], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return r.status;
}

const copy = (dir, file) => path.join(dir, ".claude/review-baseline", file);
const read = (p) => fs.readFileSync(p, "utf8");

test("first touch copies the file", () => {
  const { dir, git } = repo();
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  git("add", "a.md");
  git("commit", "-qm", "x");
  assert.equal(run(dir, "a.md"), 0);
  assert.equal(read(copy(dir, "a.md")), "one\n");
});

test("new file gets an empty copy", () => {
  const { dir } = repo();
  assert.equal(run(dir, "docs/new.md"), 0);
  assert.equal(read(copy(dir, "docs/new.md")), "");
});

test("copy is kept while unstaged changes remain", () => {
  const { dir, git } = repo();
  const f = path.join(dir, "a.md");
  fs.writeFileSync(f, "one\n");
  git("add", "a.md");
  git("commit", "-qm", "x");
  run(dir, "a.md");
  fs.writeFileSync(f, "two\n"); // the agent's edit
  run(dir, "a.md"); // second touch
  assert.equal(read(copy(dir, "a.md")), "one\n");
});

test("copy is overwritten once the file is staged", () => {
  const { dir, git } = repo();
  const f = path.join(dir, "a.md");
  fs.writeFileSync(f, "one\n");
  git("add", "a.md");
  git("commit", "-qm", "x");
  run(dir, "a.md");
  fs.writeFileSync(f, "two\n");
  git("add", "a.md"); // user reviewed and staged
  run(dir, "a.md");
  assert.equal(read(copy(dir, "a.md")), "two\n");
});

test("other extensions and outside files are ignored, exit 0", () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, "a.ts"), "x");
  assert.equal(run(dir, "a.ts"), 0);
  assert.equal(fs.existsSync(copy(dir, "a.ts")), false);
  assert.equal(run(dir, "../outside.md"), 0);
  assert.equal(fs.existsSync(path.join(dir, ".claude")), false);
  assert.equal(run(dir, "a.ts", "ts"), 0); // extension list from argv
  assert.equal(read(copy(dir, "a.ts")), "x");
});

test("bad input never blocks the tool", () => {
  const r = spawnSync("node", [hook], { input: "not json" });
  assert.equal(r.status, 0);
});
