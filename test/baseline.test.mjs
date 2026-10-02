import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { latestBefore } = req("../vscode/review-state.js");
const { review } = req("../vscode/diff.js");
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
  const input = JSON.stringify({ session_id: "s1", tool_name: "Edit", cwd: dir, tool_input: { file_path: path.join(dir, file) } });
  const r = spawnSync("node", [hook, ...exts], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return r.status;
}

const copy = (dir, file) => path.join(dir, ".claude/agent-review/baseline", file);
const log = (dir, file) => path.join(dir, ".claude/agent-review/history", `${file}.jsonl`);
const read = (p) => fs.readFileSync(p, "utf8");
const history = (dir, file) => read(log(dir, file)).trimEnd().split("\n").map((l) => JSON.parse(l));

test("first touch copies the file and logs the edit", () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  assert.equal(run(dir, "a.md"), 0);
  assert.equal(read(copy(dir, "a.md")), "one\n");
  const [h] = history(dir, "a.md");
  assert.equal(h.before, "one\n");
  assert.equal(h.session, "s1");
  assert.equal(h.tool, "Edit");
});

test("new file gets an empty copy", () => {
  const { dir } = repo();
  assert.equal(run(dir, "docs/new.md"), 0);
  assert.equal(read(copy(dir, "docs/new.md")), "");
});

test("copy survives staging and commit; every edit adds a history line", () => {
  const { dir, git } = repo();
  const f = path.join(dir, "a.md");
  fs.writeFileSync(f, "one\n");
  git("add", "a.md");
  git("commit", "-qm", "x");
  run(dir, "a.md");
  fs.writeFileSync(f, "two\n");
  git("add", "a.md");
  git("commit", "-qm", "y"); // git does not end the review
  run(dir, "a.md");
  fs.writeFileSync(f, "three\n");
  assert.equal(read(copy(dir, "a.md")), "one\n");
  assert.deepEqual(history(dir, "a.md").map((h) => h.before), ["one\n", "two\n"]);
  assert.equal(latestBefore(log(dir, "a.md")), "two\n");
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

test("no git repo: copies go to the project dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-review-nogit-"));
  fs.writeFileSync(path.join(dir, "a.md"), "x\n");
  assert.equal(run(dir, "a.md"), 0);
  assert.equal(read(copy(dir, "a.md")), "x\n");
});

test("path with a space still runs the hook", () => {
  const { dir } = repo();
  const spaced = path.join(dir, "my project");
  fs.mkdirSync(path.join(spaced, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(spaced, "vscode"));
  fs.copyFileSync(hook, path.join(spaced, "hooks/baseline.mjs"));
  fs.copyFileSync(path.resolve(import.meta.dirname, "../vscode/review-state.js"), path.join(spaced, "vscode/review-state.js"));
  const input = JSON.stringify({ tool_input: { file_path: path.join(dir, "b.md") } });
  spawnSync("node", [path.join(spaced, "hooks/baseline.mjs")], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(read(copy(dir, "b.md")), "");
});

test("C1, C2, C3 by the agent, committed in between: all three show, only C3 bright", () => {
  const { dir, git } = repo();
  const f = path.join(dir, "a.md");
  fs.writeFileSync(f, "a\n");
  git("add", "a.md");
  git("commit", "-qm", "x");
  for (const c of ["C1", "C2", "C3"]) {
    run(dir, "a.md"); // agent touches the file
    fs.appendFileSync(f, `${c}\n`);
    git("add", "a.md");
    git("commit", "-qm", c);
  }
  const marks = review(read(copy(dir, "a.md")), latestBefore(log(dir, "a.md")), read(f)).flatMap((h) =>
    h.marks.map((m) => [m.line, m.fresh]),
  );
  assert.deepEqual(marks, [[1, false], [2, false], [3, true]]);
});

test("hook installed twice (project + user settings): one history line per edit", () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  run(dir, "a.md");
  run(dir, "a.md"); // the second copy of the hook, same edit
  assert.equal(history(dir, "a.md").length, 1);
});
