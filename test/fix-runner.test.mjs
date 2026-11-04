import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { claudeArgs, outside } = createRequire(import.meta.url)("../vscode/fix-runner.js");

test("fix runner (#156): user settings only, no MCP, no commands; edits only the target files or the skill folder", () => {
  const a = claudeArgs("Fix it", { edit: ["/h/.claude/settings.json", "/h/.claude/settings.json"], addDirs: ["/h/.claude"] });
  assert.deepEqual(a.slice(0, 2), ["-p", "Fix it"]);
  assert.ok(!a.includes("--permission-mode"), "no acceptEdits: what is not allowed is denied");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "user", "a repo's hooks and permissions do not load");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(a[a.indexOf("--allowedTools") + 1], "Read,Glob,Grep,Edit(//h/.claude/settings.json)");
  assert.equal(a[a.indexOf("--disallowedTools") + 1], "Bash,WebFetch,WebSearch,Task,NotebookEdit");
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "--add-dir"), ["/h/.claude"]);
  const s = claudeArgs("Update", { editDirs: ["/h/.claude/skills/etf"] });
  assert.equal(s[s.indexOf("--allowedTools") + 1], "Read,Glob,Grep,Edit(//h/.claude/skills/etf/**),Write(//h/.claude/skills/etf/**)");
  assert.ok(!s.join(" ").includes("gh api"), "no shell for a skill update");
  assert.deepEqual(outside("/r", ["/r/skills/a/SKILL.md", "/h/.claude/settings.json", "/h/.claude/CLAUDE.md", "/rr/x"]), ["/h/.claude", "/rr"]);
});
