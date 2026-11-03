// #119: tool profiles keep the MCP tool list small where a client loads it all up front.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, toolProfile, profileSetting, TOOL_GROUPS } from "../mcp/server.mjs";

const list = (spec) => handle(null, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { client: "t", profile: spec === undefined ? undefined : toolProfile(spec) }).result.tools;

test("profiles: core is the 7 core tools under 12 KB, standard adds docs and the task list, all is every tool", () => {
  const core = list("core");
  assert.deepEqual(core.map((t) => t.name).sort(), [...TOOL_GROUPS.core].sort());
  assert.ok(JSON.stringify({ tools: core }).length < 12 * 1024, `core ${JSON.stringify({ tools: core }).length} bytes`);
  assert.ok(core.every((t) => !("outputSchema" in t) && t.inputSchema && t.description), "lean: no output schema");
  assert.deepEqual(list("standard").map((t) => t.name).sort(), [...TOOL_GROUPS.core, ...TOOL_GROUPS.list, ...TOOL_GROUPS.docs].sort());
  const all = list("all");
  assert.equal(all.length, 15);
  assert.ok(all.every((t) => t.outputSchema), "all keeps the whole contract");
  assert.equal(list(undefined).length, 15, "no profile: every tool, as before");
});

test("profiles: groups and tool names combine; unknown words are named and ignored", () => {
  const p = toolProfile("core, exercise ,doc_get,nonsense");
  assert.ok(p.names.has("exercise_save") && p.names.has("doc_get") && p.names.has("pointer_set") && !p.names.has("setup_audit"));
  assert.deepEqual(p.unknown, ["nonsense"]);
  assert.equal(p.lean, true);
  assert.equal(toolProfile("all,core").lean, false);
  assert.equal(toolProfile("nonsense").names.size, 15, "nothing known: every tool");
});

test("profiles: a tool outside the profile cannot be called", () => {
  const r = handle(null, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "exercise_get", arguments: {} } }, { client: "t", profile: toolProfile("core") });
  assert.equal(r.error?.code, -32602);
  assert.match(r.error.message, /unknown tool exercise_get/);
});

test("profiles: IMPRIMATUR_TOOLS, then the repo's .claude/imprimatur.json, then config.json, then all", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-119-"));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-119-db-"));
  const env = { IMPRIMATUR_DB: path.join(dbDir, "imprimatur.db") };
  assert.equal(profileSetting({ env, cwd: repo }), "all");
  fs.writeFileSync(path.join(dbDir, "config.json"), JSON.stringify({ mcp: { tools: "standard" } }));
  assert.equal(profileSetting({ env, cwd: repo }), "standard");
  fs.mkdirSync(path.join(repo, ".claude"));
  fs.writeFileSync(path.join(repo, ".claude", "imprimatur.json"), JSON.stringify({ mcp: { tools: "core,docs" } }));
  assert.equal(profileSetting({ env, cwd: repo }), "core,docs");
  assert.equal(profileSetting({ env: { ...env, IMPRIMATUR_TOOLS: "core" }, cwd: repo }), "core");
});
