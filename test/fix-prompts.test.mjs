import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { findingPrompt, findingsPrompt, skillUpdatePrompt, healthPrompt, fixable } = createRequire(import.meta.url)("../vscode/fix-prompts.js");

test("fix prompts (#156): a finding, all findings, a skill update and a health problem each say what, where, and to stop when unsure", () => {
  const rec = { title: "AS-016: Failed to parse SKILL.md", body: "Line 2: quote the description.", links: { audit: { rule: "AS-016", ruleName: "Skill YAML", level: "error", file: "/r/skills/issues/SKILL.md", line: 2 } } };
  const one = findingPrompt(rec);
  assert.match(one, /Rule: AS-016 \(Skill YAML\), error/);
  assert.match(one, /File: \/r\/skills\/issues\/SKILL\.md:2/);
  assert.match(one, /> Line 2: quote the description\./, "the record body is quoted, as data");
  assert.match(one, /change nothing and say why/);
  assert.match(one, /setup_audit/);
  const all = findingsPrompt([rec, { title: "XP-006: layers", links: { audit: { file: "/h/.claude/CLAUDE.md", line: 1 } } }]);
  assert.match(all, /^Fix these 2 open/);
  assert.match(all, /2\. XP-006: layers — \/h\/\.claude\/CLAUDE\.md:1/);
  const skill = skillUpdatePrompt({ label: "position-sizer", abs: "/h/.claude/skills/position-sizer/SKILL.md", origin: { repo: "t/skills", path: "skills/position-sizer", commit: "1b2d158" },
    compare: "https://github.com/t/skills/compare/1b2d158aaaa...11afdb9bbbb" });
  assert.match(skill, /gh api repos\/t\/skills\/compare\/1b2d158aaaa\.\.\.11afdb9bbbb/);
  assert.match(skill, /prompt injection/);
  assert.match(skill, /stop and tell me; do not copy/);
  assert.match(skill, /set its commit to 11afdb9/);
  assert.match(healthPrompt({ file: "/r/.claude/settings.json", line: 3, message: "Not valid JSON" }), /settings\.json:3/);
  assert.equal(fixable({ message: "Line 257 looks like a password or token" }), false, "a secret is the user's to rotate");
  assert.equal(fixable({ message: "Not valid JSON" }), true);
});
