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
    "loaded instructions|~/.claude/CLAUDE.md": "User · 12 chars",
    "hook output|SessionStart: run.mjs": "1 runs · 300 ms each · adds 22 chars",
    "hook output|SessionStart: Loading tidy mode": "1 runs · 100 ms each · adds 7 chars",
    "MCP instructions|imprimatur": "36 chars",
    "tools|imprimatur": "2 tools",
    "tools|Claude Code": "1 tools",
    "tools|dd": "failed to connect: ENOTFOUND",
    "tools|linear": "needs sign-in",
    "listings|skills": "3 skills · 10 chars",
    "model and mode|model": "Opus 5.5",
  });
  // The session goes on: only the new line is read, and runs add up.
  fs.appendFileSync(file, att({ type: "hook_success", hookEvent: "SessionStart", command: 'node "/opt/hooks/run.mjs" md', durationMs: 100, stdout: "" }) + "\n");
  assert.equal(rows()["hook output|SessionStart: run.mjs"], "2 runs · 200 ms each · adds 22 chars");
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
