// Everything the agent does (#55): vscode/activity.js and hooks/activity.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { kindOf, rowOf, record, activityOf, ACTIVITY_DIR } = req("../vscode/activity.js");
const HOOK = new URL("../hooks/activity.mjs", import.meta.url).pathname;

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-55-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

test("kinds: every tool lands in one of the filter groups", () => {
  const got = Object.fromEntries(["Edit", "Write", "Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__imprimatur__search", "mcp__plugin_x_y__z", "Agent", "Task", "Skill", "TodoWrite"].map((t) => [t, kindOf(t)]));
  assert.deepEqual(got, {
    Edit: "edit", Write: "edit", Bash: "bash", Read: "read", Grep: "search", Glob: "search", WebFetch: "web", WebSearch: "web",
    mcp__imprimatur__search: "mcp", mcp__plugin_x_y__z: "mcp", Agent: "agent", Task: "agent", Skill: "skill", TodoWrite: "other",
  });
});

test("rows: what was asked and what came back, short; a subagent's calls carry its id", () => {
  const root = repo();
  const row = (tool_name, tool_input, tool_response, extra = {}) => rowOf(root, { session_id: "S", tool_use_id: "u1", tool_name, tool_input, tool_response, ...extra });
  assert.equal(row("Read", { file_path: path.join(root, "src/a.js"), offset: 40 }, { file: { numLines: 12 } }).what, "src/a.js @40");
  assert.equal(row("Read", { file_path: path.join(root, "src/a.js") }, { file: { numLines: 12 } }).out, "12 lines");
  assert.equal(row("Grep", { pattern: "openDb", path: path.join(root, "vscode"), glob: "*.js" }, { filenames: ["a", "b"], numFiles: 2 }).what, "openDb · vscode · *.js");
  assert.equal(row("WebFetch", { url: "https://code.claude.com/docs/en/hooks", prompt: "x" }, "ok").what, "https://code.claude.com/docs/en/hooks");
  const mcp = row("mcp__imprimatur__task_get", { key: "#55", _session: "S" }, { content: [{ type: "text", text: "#55 Graph [active]" }] });
  assert.deepEqual([mcp.what, mcp.out], ["imprimatur: task_get key=#55", "#55 Graph [active]"]);
  const agent = row("Agent", { description: "Survey hooks", subagent_type: "Explore", prompt: "…" }, { status: "completed", agentId: "a1", totalToolUseCount: 15, totalTokens: 60211, totalDurationMs: 64335 });
  assert.deepEqual([agent.kind, agent.what, agent.out, agent.agentId], ["agent", "Explore: Survey hooks", "completed · 15 calls · 60211 tokens · 64 s", "a1"]);
  const inside = row("Read", { file_path: "/x" }, null, { agent_id: "a1", agent_type: "Explore" });
  assert.deepEqual([inside.agent, inside.agentType], ["a1", "Explore"]);
  const failed = rowOf(root, { hook_event_name: "PostToolUseFailure", session_id: "S", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nfailing" });
  assert.deepEqual([failed.failed, failed.out], [true, "Exit code 1 failing"]);
  assert.ok(row("Bash", { command: "x".repeat(500) }, "y".repeat(500)).what.length <= 160);
});

test("record and read back: one file per session, read again only when it changed", () => {
  const root = repo();
  record(root, { session_id: "S1", tool_use_id: "a", tool_name: "Read", tool_input: { file_path: "a.md" } });
  record(root, { session_id: "S2", tool_use_id: "b", tool_name: "Grep", tool_input: { pattern: "x" } });
  record(root, { session_id: "../evil", tool_name: "Read" });
  assert.deepEqual(fs.readdirSync(path.join(root, ACTIVITY_DIR)).sort(), ["S1.jsonl", "S2.jsonl"]);
  assert.deepEqual(activityOf(root).map((r) => r.id), ["a", "b"]);
  record(root, { session_id: "S1", tool_use_id: "c", tool_name: "WebSearch", tool_input: { query: "q" } });
  assert.deepEqual(activityOf(root).map((r) => r.id).sort(), ["a", "b", "c"]);
});

test("hook process: real input in its repo, nothing outside a repo, bad input exits 0", () => {
  const root = repo();
  const run = (input, env = {}) => spawnSync(process.execPath, [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
  const sub = path.join(root, "src");
  fs.mkdirSync(sub);
  assert.equal(run({ hook_event_name: "PostToolUse", cwd: sub, session_id: "S", tool_use_id: "t", tool_name: "Glob", tool_input: { pattern: "**/*.md" }, tool_response: { filenames: [] } }).status, 0);
  assert.equal(activityOf(root).at(-1).what, "**/*.md");
  assert.equal(run({ hook_event_name: "PostToolUse", cwd: os.tmpdir(), session_id: "S", tool_name: "Read" }).status, 0);
  assert.equal(run("nope").status, 0);
  run({ hook_event_name: "PostToolUse", cwd: root, session_id: "S", tool_name: "Read", tool_input: {} }, { IMPRIMATUR_CHILD: "1" });
  assert.equal(activityOf(root).length, 1, "Imprimatur's own model calls are not recorded");
});
