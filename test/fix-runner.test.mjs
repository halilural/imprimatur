import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { claudeArgs, outside } = createRequire(import.meta.url)("../vscode/fix-runner.js");

test("fix runner (#156): claude -p may only read and edit; a skill update adds gh api; folders outside the repo are added", () => {
  const a = claudeArgs("Fix it", { addDirs: ["/h/.claude", "/h/.claude"] });
  assert.deepEqual(a.slice(0, 4), ["-p", "Fix it", "--permission-mode", "acceptEdits"]);
  assert.equal(a[a.indexOf("--allowedTools") + 1], "Read,Edit,Write,Glob,Grep,mcp__imprimatur__setup_audit");
  assert.equal(a[a.indexOf("--disallowedTools") + 1], "Bash,WebFetch,WebSearch", "no commands for a plain fix");
  assert.deepEqual(a.filter((x, i) => a[i - 1] === "--add-dir"), ["/h/.claude"]);
  const s = claudeArgs("Update", { gh: true });
  assert.match(s[s.indexOf("--allowedTools") + 1], /Bash\(gh api:\*\)$/);
  assert.doesNotMatch(s[s.indexOf("--disallowedTools") + 1], /^Bash,/);
  assert.deepEqual(outside("/r", ["/r/skills/a/SKILL.md", "/h/.claude/settings.json", "/h/.claude/CLAUDE.md", "/rr/x"]), ["/h/.claude", "/rr"]);
});
