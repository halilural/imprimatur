import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { classify, scanSetup, changesSince, snapshotOf } = createRequire(import.meta.url)("../vscode/agent-setup.js");

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-setup-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test("setup: every tool's agent files are found, other files and skipped folders are not", () => {
  const root = repo({
    "CLAUDE.md": "# Rules\n\nBe brief.\n",
    "docs/CLAUDE.md": "# Docs rules\n",
    ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash .claude/hooks/todos-committed.sh" }] }] }, permissions: { allow: ["Bash(ls)"] } }),
    ".claude/hooks/todos-committed.sh": "#!/bin/bash\n# Stop: blocks the turn end while todos/ has uncommitted changes\n",
    ".claude/skills/task-tracking/SKILL.md": "---\nname: task-tracking\ndescription: Issue and TODO.md rules\n---\n# x\n",
    ".claude/skills/humanizer/SKILL.md": "---\nname: humanizer\ndescription: |\n  Rewrite AI-sounding text\n  so it reads like the writer.\nlicense: MIT\n---\n# x\n",
    ".cursor/rules/style.mdc": "---\ndescription: Style rules\nalwaysApply: true\n---\nUse tabs.\n",
    ".cursorrules": "Old cursor rules\n",
    "app/.cursorignore": "# Cursor ignore\ndist/\n",
    "docs/CONVENTIONS.md": "not an agent file\n",
    ".terraform/modules/x/AGENTS.md": "vendored\n",
    ".github/copilot-instructions.md": "Copilot rules\n",
    "AGENTS.md": "# Agents\n",
    ".husky/pre-commit": "npm test\n",
    ".husky/_/husky.sh": "internal\n",
    "commitlint.config.mjs": "export default {}\n",
    ".mcp.json": JSON.stringify({ mcpServers: { github: {}, linear: {} } }),
    "node_modules/x/CLAUDE.md": "no\n",
    "README.md": "no\n",
  });
  const items = scanSetup(root);
  assert.deepEqual(
    items.map((i) => [i.rel, i.tool, i.kind]),
    [
      [".claude/hooks/todos-committed.sh", "Claude Code", "hook script"],
      [".claude/settings.json", "Claude Code", "settings"],
      [".claude/skills/humanizer/SKILL.md", "Claude Code", "skill"],
      [".claude/skills/task-tracking/SKILL.md", "Claude Code", "skill"],
      [".cursor/rules/style.mdc", "Cursor", "rules"],
      [".cursorrules", "Cursor", "rules"],
      [".github/copilot-instructions.md", "GitHub Copilot", "rules"],
      [".husky/pre-commit", "Git hooks", "git hook"],
      [".mcp.json", "Claude Code", "MCP servers"],
      ["AGENTS.md", "Codex / AGENTS.md", "rules"],
      ["CLAUDE.md", "Claude Code", "rules"],
      ["app/.cursorignore", "Cursor", "ignore"],
      ["commitlint.config.mjs", "Git hooks", "commit rules"],
      ["docs/CLAUDE.md", "Claude Code", "rules"],
    ],
  );
  const by = Object.fromEntries(items.map((i) => [i.rel, i]));
  assert.equal(by[".claude/settings.json"].summary, "1 hooks · 1 allow / 0 deny");
  assert.deepEqual(by[".claude/settings.json"].details, ["Stop → todos-committed.sh"]);
  assert.equal(by[".claude/hooks/todos-committed.sh"].summary, "3 lines · Stop: blocks the turn end while todos/ has uncommitted changes");
  assert.equal(by[".claude/skills/task-tracking/SKILL.md"].summary, "Issue and TODO.md rules");
  assert.equal(by[".claude/skills/humanizer/SKILL.md"].summary, "Rewrite AI-sounding text so it reads like the writer.");
  assert.deepEqual([by[".claude/skills/humanizer/SKILL.md"].label, by[".claude/hooks/todos-committed.sh"].label, by["CLAUDE.md"].label, by[".cursor/rules/style.mdc"].label], ["humanizer", "todos-committed.sh", "CLAUDE.md", "style"]);
  assert.equal(by[".cursor/rules/style.mdc"].summary, "always · Style rules");
  assert.equal(by[".mcp.json"].summary, "2 servers: github, linear");
  assert.equal(classify("src/index.ts"), undefined);
});

test("setup: new, changed and removed since the last look; the first look marks nothing", () => {
  const root = repo({ "CLAUDE.md": "a\n", "AGENTS.md": "b\n" });
  const first = scanSetup(root);
  assert.deepEqual(changesSince(first, undefined), { state: {}, removed: [] });
  const seen = snapshotOf(first);
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "a, changed\n");
  fs.rmSync(path.join(root, "AGENTS.md"));
  fs.mkdirSync(path.join(root, ".cursor/rules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cursor/rules/new.mdc"), "x\n");
  assert.deepEqual(changesSince(scanSetup(root), seen), { state: { "CLAUDE.md": "changed", ".cursor/rules/new.mdc": "new" }, removed: ["AGENTS.md"] });
});
