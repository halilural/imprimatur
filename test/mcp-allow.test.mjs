// #113: the allow rule for Imprimatur's MCP server, so auto mode skips the permission check.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { ALLOW, mergeAllow, mcpDecision, allowDiagnostic } = require("../vscode/mcp-allow.js");

test("mcp-allow: mergeAllow adds the rule once and keeps the other rules", () => {
  const before = { permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"] }, model: "x" };
  const { settings, change } = mergeAllow(before, ALLOW.settings);
  assert.deepEqual(settings.permissions.allow, ["Bash(git status)", "mcp__imprimatur"]);
  assert.deepEqual(settings.permissions.deny, ["Read(.env)"]);
  assert.match(change, /added {3}permissions.allow "mcp__imprimatur"/);
  assert.deepEqual(before.permissions.allow, ["Bash(git status)"], "pure: the input is not changed");
  assert.equal(mergeAllow(settings, ALLOW.settings).change, undefined);
  assert.equal(mergeAllow({ permissions: { allow: ["mcp__imprimatur__*"] } }, ALLOW.settings).change, undefined);
  assert.deepEqual(mergeAllow(undefined, ALLOW.plugin).settings, { permissions: { allow: ["mcp__plugin_imprimatur_imprimatur"] } });
});

test("mcp-allow: the decision reads user, project and local settings; a deny or ask rule is the user's choice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-allow-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-allow-home-"));
  const managedDir = path.join(home, "managed");
  const where = { root, home, managedDir };
  const write = (file, settings) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings));
  };
  assert.equal(mcpDecision(where).allowed, false);
  assert.match(allowDiagnostic(where).message, /No allow rule/);
  assert.equal(allowDiagnostic(where).file, path.join(home, ".claude", "settings.json"));
  write(path.join(root, ".claude", "settings.json"), { permissions: { allow: ["mcp__imprimatur"] } });
  assert.deepEqual(mcpDecision(where), { allowed: true, effect: "allow", rule: "mcp__imprimatur", scope: "project" });
  assert.equal(allowDiagnostic(where), undefined);
  write(path.join(root, ".claude", "settings.local.json"), { permissions: { ask: ["mcp__imprimatur"] } });
  assert.equal(mcpDecision(where).effect, "ask");
  assert.equal(allowDiagnostic(where), undefined, "asked on purpose: not flagged");
});
