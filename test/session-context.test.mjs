import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { sessionItems } = require("../vscode/session-context.js");

const att = (a) => JSON.stringify({ type: "attachment", attachment: a });

test("session context (#139): what the last session saw, from its transcript; appended lines are read on the next call", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-ctx-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s1.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "user", message: "hi" }),
    att({ type: "instructions", files: [{ path: path.join(home, ".claude", "CLAUDE.md"), type: "User", content: "x".repeat(12) }] }),
    att({ type: "hook_success", hookEvent: "SessionStart", command: 'node "/opt/hooks/run.mjs" md', durationMs: 300, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "Where we left off\nmore" } }) }),
    att({ type: "hook_success", hookEvent: "SessionStart", command: "Loading tidy mode...", durationMs: 100, stdout: "", content: "TIDY ON" }),
    att({ type: "mcp_instructions_delta", addedNames: ["imprimatur"], addedBlocks: ["## imprimatur\nCall where_we_left_off"] }),
    att({ type: "deferred_tools_delta", addedNames: ["mcp__imprimatur__search", "mcp__imprimatur__task_get", "Monitor"], failedMcpServers: [{ name: "dd", errorCode: "ENOTFOUND" }], needsAuthMcpServers: ["linear"] }),
    att({ type: "skill_listing", isInitial: true, names: ["a", "b"], content: "- a\n- b" }),
    att({ type: "skill_listing", isInitial: false, names: ["c"], content: "- c" }),
    att({ type: "model", identity: { marketingName: "Opus 5.5" } }),
    "",
  ].join("\n"));
  const rows = () => Object.fromEntries(sessionItems(dir, home).map((r) => [`${r.kind}|${r.label}`, r.summary]));
  assert.deepEqual(rows(), {
    "loaded instructions|~/.claude/CLAUDE.md": "User · ~3 tokens",
    "hook output|SessionStart: run.mjs": "300 ms in all · 1 runs · 300 ms each · adds ~6 tokens",
    "hook output|SessionStart: Loading tidy mode": "100 ms in all · 1 runs · 100 ms each · adds ~2 tokens",
    "MCP instructions|imprimatur": "~9 tokens",
    "tools|imprimatur": "2 tools",
    "tools|Claude Code": "1 tools",
    "tools|dd": "failed to connect: ENOTFOUND",
    "tools|linear": "needs sign-in",
    "listings|skills": "3 skills · ~3 tokens",
    "model and mode|model": "Opus 5.5",
  });
  // The session goes on: only the new line is read, and runs add up.
  fs.appendFileSync(file, att({ type: "hook_success", hookEvent: "SessionStart", command: 'node "/opt/hooks/run.mjs" md', durationMs: 100, stdout: "" }) + "\n");
  assert.equal(rows()["hook output|SessionStart: run.mjs"], "400 ms in all · 2 runs · 200 ms each · adds ~6 tokens");
});

test("session context (#139): memory servers are listed once as data sources, under the connector's name", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-mem-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "s.jsonl"), [
    att({ type: "mcp_instructions_delta", addedNames: ["claude.ai Nook", "imprimatur"], addedBlocks: ["Nook memory", "x"] }),
    att({ type: "deferred_tools_delta", addedNames: ["mcp__claude_ai_Nook__add_memory", "mcp__imprimatur__search"] }),
    "",
  ].join("\n"));
  const src = sessionItems(dir, home).filter((r) => r.kind === "data sources").map((r) => r.label);
  assert.deepEqual(src, ["claude.ai Nook"]);
});

test("session context (#145): hooks slowest first with total time; two copies of one plugin show as two rows that say so", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-hooks-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const cmd = (scope) => `node "${home}/.claude/plugins/cache/mk/tidy/${scope}/hooks/pre.mjs"`;
  const run = (c, ms) => att({ type: "hook_success", hookEvent: "PreToolUse", command: c, durationMs: ms, stdout: "" });
  fs.writeFileSync(path.join(dir, "s.jsonl"), [run(cmd("1.0.0"), 40), run(cmd("1.0.0"), 60), run(cmd("2.0.0"), 50), run(cmd("2.0.0"), 50), run('node "/opt/fast.mjs"', 1200), ""].join("\n"));
  const rows = sessionItems(dir, home).filter((r) => r.kind === "hook output");
  assert.deepEqual(rows.map((r) => r.label), ["PreToolUse: fast.mjs", "PreToolUse: tidy: pre.mjs (copy)", "PreToolUse: tidy: pre.mjs (copy)"]);
  assert.match(rows[0].summary, /^1\.2 s in all · 1 runs · 1200 ms each/);
  assert.match(rows[1].summary, /100 ms in all · 2 runs · 50 ms each · runs 2 times: 2 copies installed$/);
  assert.ok(rows[1].details[0].startsWith("from ~/.claude/plugins/cache/mk/tidy/"));
});

test("session context (#145): a hook logged as \"command hook\" is named from the configured hooks whose matcher fits its tool", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-named-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const run = (event, tool, ms) => att({ type: "hook_success", hookEvent: event, hookName: `${event}:${tool}`, command: "command hook", durationMs: ms, stdout: "" });
  fs.writeFileSync(path.join(dir, "s.jsonl"), [run("PreToolUse", "Edit", 50), run("PostToolUse", "Bash", 20), ""].join("\n"));
  const configured = [
    { event: "PreToolUse", matcher: "Edit|Write", script: "guard.mjs" }, { event: "PreToolUse", matcher: "Bash", script: "bash.mjs" },
    { event: "PostToolUse", matcher: "", script: "a.mjs" }, { event: "PostToolUse", matcher: "*", script: "b.mjs" },
  ];
  const labels = sessionItems(dir, home, configured).filter((r) => r.kind === "hook output").map((r) => r.label);
  assert.deepEqual(labels, ["PreToolUse: guard.mjs", "PostToolUse: one of a.mjs, b.mjs"]);
  assert.deepEqual(sessionItems(dir, home).filter((r) => r.kind === "hook output").map((r) => r.label), ["PreToolUse: command hook", "PostToolUse: command hook"], "unchanged without config");
});

test("session context (#145): matchers are never compiled as regex; a pathological one only widens the candidates", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-redos-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "s.jsonl"), att({ type: "hook_success", hookEvent: "PreToolUse", hookName: `PreToolUse:${"a".repeat(40)}!`, command: "command hook", durationMs: 5, stdout: "" }) + "\n");
  const started = Date.now();
  const labels = sessionItems(dir, home, [
    { event: "PreToolUse", matcher: "(a+)+$", script: "evil.mjs" }, { event: "PreToolUse", matcher: "mcp__imprimatur__.*", script: "mcp.mjs" },
    { event: "PreToolUse", matcher: "Edit|Write", script: "edit.mjs" },
  ]).filter((r) => r.kind === "hook output").map((r) => r.label);
  assert.ok(Date.now() - started < 500, "no catastrophic backtracking");
  assert.deepEqual(labels, ["PreToolUse: evil.mjs"], "a pattern it cannot read may fit; a prefix or exact name that does not fit is left out");
});

test("context budget (#29): every loaded item with estimated tokens, biggest first; hook text summed per run; unused MCP flagged; tool definitions not guessed", () => {
  const { sessionBudget, tokensOf } = require("../vscode/session-context.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  const dir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(dir, { recursive: true });
  const ctx = (text) => JSON.stringify({ hookSpecificOutput: { additionalContext: text } });
  fs.writeFileSync(path.join(dir, "s.jsonl"), [
    att({ type: "instructions", files: [{ path: path.join(home, "CLAUDE.md"), type: "Project", content: "x".repeat(40000) }] }),
    att({ type: "hook_success", hookEvent: "PreToolUse", command: 'node "/opt/pre.mjs"', durationMs: 10, stdout: ctx("y".repeat(800)) }),
    att({ type: "hook_success", hookEvent: "PreToolUse", command: 'node "/opt/pre.mjs"', durationMs: 10, stdout: "" }),
    att({ type: "hook_success", hookEvent: "PreToolUse", command: 'node "/opt/pre.mjs"', durationMs: 10, stdout: ctx("y".repeat(800)) }),
    att({ type: "mcp_instructions_delta", addedNames: ["used", "idle"], addedBlocks: ["u".repeat(400), "i".repeat(2000)] }),
    att({ type: "deferred_tools_delta", addedNames: ["mcp__used__a", "mcp__idle__b", "Monitor"] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__used__a", input: {} }] } }),
    "",
  ].join("\n"));
  const b = sessionBudget(dir, home);
  assert.equal(tokensOf(40000), 10000, "4 characters a token");
  assert.deepEqual(b.rows.map((r) => [r.kind, r.tokens]), [["instructions", 10000], ["MCP instructions", 500], ["hook output", 400], ["MCP instructions", 100]]);
  assert.equal(b.total, 11000);
  assert.match(b.rows[0].suggestion, /halving it saves ~5,000 tokens/);
  assert.equal(b.rows[2].detail, "~200 tokens on 2 of 3 runs · 30 ms in all", "text summed over the runs that added it");
  assert.match(b.rows[1].suggestion, /Not called in the last session/);
  assert.equal(b.rows[3].suggestion, "", "a called server has no removal suggestion");
  assert.deepEqual(b.uncounted, ["3 tool definitions (their schemas are not in the transcript; /context counts them)"]);
});
