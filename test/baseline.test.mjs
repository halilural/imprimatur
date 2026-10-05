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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-"));
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

const copy = (dir, file) => path.join(dir, ".claude/imprimatur/baseline", file);
const log = (dir, file) => path.join(dir, ".claude/imprimatur/history", `${file}.jsonl`);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-nogit-"));
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

test("history reads like a commit log: newest first, each edit's before and after", () => {
  const { historyEdits } = req("../vscode/review-state.js");
  const { dir } = repo();
  const f = path.join(dir, "a.md");
  fs.writeFileSync(f, "a\n");
  for (const c of ["C1", "C2"]) {
    run(dir, "a.md");
    fs.appendFileSync(f, `${c}\n`);
    fs.utimesSync(log(dir, "a.md"), new Date(0), new Date(0)); // outside the double-hook window
  }
  const edits = historyEdits(log(dir, "a.md"), read(f));
  assert.deepEqual(
    edits.map((e) => [e.n, e.before, e.after, e.added, e.removed, e.tool]),
    [
      [2, "a\nC1\n", "a\nC1\nC2\n", 1, 0, "Edit"],
      [1, "a\n", "a\nC1\n", 1, 0, "Edit"],
    ],
  );
  assert.deepEqual(historyEdits(log(dir, "none.md"), ""), []);
});

test("history: a duplicate row from a parallel second hook counts once", () => {
  const { historyEdits } = req("../vscode/review-state.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-dup-"));
  const l = path.join(dir, "a.md.jsonl");
  const row = (t, before) => JSON.stringify({ t, tool: "Edit", before }) + "\n";
  fs.writeFileSync(l, row("2026-10-02T10:00:00.000Z", "a\n") + row("2026-10-02T10:00:00.300Z", "a\n") + row("2026-10-02T10:05:00.000Z", "a\nb\n"));
  assert.deepEqual(historyEdits(l, "a\nb\nc\n").map((e) => [e.n, e.added]), [[2, 1], [1, 1]]);
});

test("history row carries the user's latest request from the transcript", () => {
  const { dir } = repo();
  const tr = path.join(dir, "t.jsonl");
  fs.writeFileSync(
    tr,
    [
      { type: "user", message: { content: "old" } },
      { type: "last-prompt", lastPrompt: "first ask", sessionId: "s1" },
      { type: "assistant" },
      { type: "last-prompt", lastPrompt: "change cumartesi to pazartesi\nsecond line", sessionId: "s1" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  fs.writeFileSync(path.join(dir, "a.md"), "x\n");
  const input = JSON.stringify({ session_id: "s1", tool_name: "Edit", transcript_path: tr, tool_input: { file_path: path.join(dir, "a.md") } });
  spawnSync("node", [hook], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(history(dir, "a.md")[0].prompt, "change cumartesi to pazartesi");
});

test("history row carries the session title and where to find the agent's words", () => {
  const { dir } = repo();
  const tr = path.join(dir, "t.jsonl");
  fs.writeFileSync(tr, [{ type: "ai-title", aiTitle: "Old" }, { type: "ai-title", aiTitle: "Tim'den gelen mail" }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "a.md"), "x\n");
  const input = JSON.stringify({ session_id: "s1", tool_name: "Edit", tool_use_id: "toolu_1", transcript_path: tr, tool_input: { file_path: path.join(dir, "a.md") } });
  spawnSync("node", [hook], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  const row = history(dir, "a.md")[0];
  assert.deepEqual([row.title, row.transcript, row.toolUseId, row.intent], ["Tim'den gelen mail", tr, "toolu_1", undefined]);
});

function bash(dir, id, command, event) {
  const input = JSON.stringify({ hook_event_name: event, session_id: "s1", tool_name: "Bash", tool_use_id: id, cwd: dir, tool_input: { command } });
  return spawnSync("node", [hook], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } }).status;
}

test("bash edit (python heredoc) is recorded like an Edit; a read-only command leaves no trace", () => {
  const { dir } = repo();
  const f = path.join(dir, "docs/a.md");
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, "one\n");
  const cmd = "python3 - <<'EOF'\np='docs/a.md'; s=open(p).read(); open(p,'w').write(s.replace('one','two'))\nEOF";
  assert.equal(bash(dir, "t1", cmd, "PreToolUse"), 0);
  fs.writeFileSync(f, "two\n"); // the command runs
  assert.equal(bash(dir, "t1", cmd, "PostToolUse"), 0);
  assert.equal(read(copy(dir, "docs/a.md")), "one\n");
  const [h] = history(dir, "docs/a.md");
  assert.equal(h.before, "one\n");
  assert.equal(h.tool, "Bash");
  bash(dir, "t2", "cat docs/a.md", "PreToolUse");
  bash(dir, "t2", "cat docs/a.md", "PostToolUse");
  assert.equal(history(dir, "docs/a.md").length, 1);
  assert.equal(fs.readdirSync(path.join(dir, ".claude/imprimatur/pending")).length, 0);
});

test("paths named in a command", async () => {
  const { pathsInCommand } = await import(hook);
  assert.deepEqual(pathsInCommand("sed -i s/a/b/ README.md docs/x.MDX notes.txt && cat ./a/b.md", ["md", "mdx"]), ["README.md", "docs/x.MDX", "./a/b.md"]);
});

test("bash edit: relative paths follow the command's own cd", () => {
  const { dir } = repo();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  const cmd = `cd ${dir} && sed -i s/one/two/ a.md`;
  const input = (event) => JSON.stringify({ hook_event_name: event, tool_name: "Bash", tool_use_id: "t9", cwd: path.join(dir, "sub"), tool_input: { command: cmd } });
  spawnSync("node", [hook], { input: input("PreToolUse"), env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  fs.writeFileSync(path.join(dir, "a.md"), "two\n");
  spawnSync("node", [hook], { input: input("PostToolUse"), env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(history(dir, "a.md")[0].before, "one\n");
});
