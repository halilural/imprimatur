// #118: one dispatcher process per hook event does what the per-script hooks did.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { merge } from "../hooks/run.mjs";
import { createRequire as __cr } from "node:module";
const { dataPath } = __cr(import.meta.url)("../vscode/data-dir.js");

const require = createRequire(import.meta.url);
const { stepsFor, activityHookWrites, matcherFor } = require("../vscode/hook-plan.js");
const HOOKS = new URL("../hooks/", import.meta.url).pathname;

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo(settings) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-118-")));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  if (settings) {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify(settings));
  }
  return root;
}
// The hooks use this process's database, so both sides see the same data folder (#126).
const run = (script, root, input, args = []) => {
  require("../vscode/db.js").dbPath();
  return spawnSync(process.execPath, [path.join(HOOKS, script), ...args], { input: JSON.stringify({ cwd: root, session_id: "s118", ...input }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root, IMPRIMATUR_DESCRIBE: "off" } });
};
const activityRows = (root) => {
  const f = dataPath(root, ".claude/imprimatur", "activity", "s118.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).tool) : [];
};
/** Everything under the data folder but the volatile parts: same effects, same tree. */
const tree = (root) => {
  const base = dataPath(root, ".claude/imprimatur");
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(`${r}:${fs.readFileSync(path.join(d, e.name), "utf8").replace(/"t":"[^"]+"/g, "").length}`);
    }
  };
  walk(base, "");
  return out.sort();
};

test("plan: Bash and Edit calls are two processes (Pre, Post); other tools only the async activity hook", () => {
  assert.deepEqual(stepsFor("PreToolUse", "Bash"), ["baseline", "process"]);
  assert.deepEqual(stepsFor("PostToolUse", "Bash"), ["baseline", "process", "activity"]);
  assert.deepEqual(stepsFor("PreToolUse", "Edit"), ["baseline", "process"]);
  assert.deepEqual(stepsFor("PostToolUse", "Edit"), ["process", "activity"]);
  assert.deepEqual(stepsFor("PreToolUse", "Read"), []);
  assert.deepEqual(stepsFor("PostToolUse", "Read"), []);
  assert.deepEqual(stepsFor("PreToolUse", "mcp__plugin_imprimatur_imprimatur__task_get"), ["mcp"]);
  assert.deepEqual(stepsFor("PostToolUse", "mcp__imprimatur__record_add"), ["process", "activity"]);
  assert.deepEqual(stepsFor("Stop"), ["waiting", "process"]);
  // Exactly one activity row per call: the dispatcher's or the async hook's.
  for (const tool of ["Bash", "Edit", "Write", "Read", "Grep", "NotebookEdit", "mcp__imprimatur__task_get", "mcp__imprimatur__record_add", "AskUserQuestion"])
    for (const ev of ["PostToolUse", "PostToolUseFailure"]) assert.notEqual(stepsFor(ev, tool).includes("activity"), activityHookWrites(ev, tool), `${ev} ${tool}`);
  // Claude Code's matcher reaches every tool a step names.
  for (const ev of ["PreToolUse", "PostToolUse"]) {
    const re = new RegExp(`^(?:${matcherFor(ev)})$`);
    for (const tool of ["Bash", "Edit", "Write", "AskUserQuestion", "mcp__imprimatur__record_add"]) if (stepsFor(ev, tool).length) assert.ok(re.test(tool), `${ev} ${tool}`);
  }
});

test("merge: a block wins with its stderr; contexts join; the strongest permission; updatedInput kept", () => {
  assert.deepEqual(merge("PreToolUse", [{ code: 2, stderr: "mainGuard: no" }, { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }) }]), { code: 2, stderr: "mainGuard: no" });
  const m = merge("PreToolUse", [
    { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "records", updatedInput: { a: 1 } } }) },
    { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "one" } }) },
    { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "two", permissionDecision: "ask", permissionDecisionReason: "check" } }) },
    { code: 0 },
  ]);
  assert.deepEqual(JSON.parse(m.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "check", updatedInput: { a: 1 }, additionalContext: "one\n\ntwo" } });
  assert.deepEqual(merge("Stop", [{ stdout: JSON.stringify({ systemMessage: "a" }) }, { stdout: JSON.stringify({ systemMessage: "b" }) }]), { code: 0, stdout: JSON.stringify({ systemMessage: "a\nb" }) });
  assert.deepEqual(merge("Stop", [{ code: 0 }]), { code: 0 });
});

test("run.mjs vs the old per-script hooks: same copies and history for a Write and a Bash edit", () => {
  const a = repo(null);
  const b = repo(null);
  for (const root of [a, b]) fs.writeFileSync(path.join(root, "notes.md"), "one\n");
  const write = (root) => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, "notes.md"), content: "two\n" } });
  run("baseline.mjs", a, write(a), ["md"]);
  run("run.mjs", b, write(b), ["md"]);
  assert.deepEqual(tree(b), tree(a));
  assert.ok(tree(b).some((f) => f.startsWith("baseline/notes.md")));
  // A Bash edit: before, the file changes, after.
  const bash = (root, ev) => ({ hook_event_name: ev, tool_name: "Bash", tool_use_id: "u1", tool_input: { command: `sed -i s/one/three/ ${path.join(root, "notes.md")}` } });
  for (const [root, s] of [[a, "baseline.mjs"], [b, "run.mjs"]]) {
    fs.writeFileSync(path.join(root, "notes.md"), "one\n");
    run(s, root, bash(root, "PreToolUse"), ["md"]);
    fs.writeFileSync(path.join(root, "notes.md"), "three\n");
    run(s, root, bash(root, "PostToolUse"), ["md"]);
  }
  // The old async activity hook wrote every call's row; activity.mjs now leaves Bash to run.mjs.
  require("../vscode/activity.js").record(a, { cwd: a, session_id: "s118", ...bash(a, "PostToolUse") });
  assert.deepEqual(tree(b), tree(a), "the same files, the activity row included");
});

test("run.mjs: a process block still exits 2 with its reason, and the copy is still taken", () => {
  const root = repo({ process: { designFirst: false } });
  fs.mkdirSync(path.join(root, "src"));
  const r = run("run.mjs", root, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(root, "src", "a.md") } }, ["md"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mainGuard/);
  const start = run("run.mjs", root, { hook_event_name: "SessionStart" });
  assert.equal(start.status, 0);
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /No unfinished tasks in Imprimatur/);
});

test("run.mjs: an Imprimatur MCP call is allowed with the session added, as mcp-session.mjs did", () => {
  const root = repo(null);
  const input = { hook_event_name: "PreToolUse", tool_name: "mcp__imprimatur__task_get", tool_input: { key: "#1" } };
  const now = JSON.parse(run("run.mjs", root, input).stdout);
  const old = JSON.parse(run("mcp-session.mjs", root, input).stdout);
  assert.deepEqual(now, old);
  assert.equal(now.hookSpecificOutput.updatedInput._session, "s118");
});

test("run.mjs and activity.mjs: one activity row per call, whichever writes it; bad input exits 0", () => {
  const root = repo(null);
  for (const tool of ["Bash", "Read", "Grep", "Edit"]) {
    const input = { hook_event_name: "PostToolUse", tool_name: tool, tool_input: tool === "Bash" ? { command: "ls" } : { file_path: path.join(root, "x.txt") } };
    run("run.mjs", root, input);
    run("activity.mjs", root, input);
  }
  assert.deepEqual(activityRows(root).sort(), ["Bash", "Edit", "Grep", "Read"]);
  assert.equal(spawnSync(process.execPath, [path.join(HOOKS, "run.mjs")], { input: "nope" }).status, 0);
});
