import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { scopeOf, parseFrontMatter, globMatch, inEffectFor, matcherMatches } = require("../vscode/setup-scope.js");
const { mergeSettings } = require("../vscode/setup-merged.js");

const fm = (o) => `---\n${o}\n---\nbody\n`;
const label = (rel, tool, kind, text, opts) => scopeOf({ rel, tool, kind }, text, opts)?.label;

test("scope: Claude Code rules, CLAUDE.md and skills", () => {
  assert.equal(label(".claude/rules/style.md", "Claude Code", "rules", "# no front matter\n"), "always");
  assert.equal(label(".claude/rules/api.md", "Claude Code", "rules", fm('paths:\n  - "src/api/**/*.ts"\n  - lib/**/*.ts')), "for src/api/**/*.ts, lib/**/*.ts");
  assert.equal(label(".claude/rules/web.md", "Claude Code", "rules", fm("paths: src/**/*.{ts,tsx}, docs/*.md")), "for src/**/*.{ts,tsx}, docs/*.md");
  assert.equal(label(".claude/rules/x.md", "Claude Code", "rules", fm("paths: [a/**, b/**]")), "for a/**, b/**");
  assert.equal(label("CLAUDE.md", "Claude Code", "rules", "# x\n"), "always");
  assert.equal(label(".claude/CLAUDE.md", "Claude Code", "rules", "# x\n"), "always");
  assert.equal(label("docs/CLAUDE.md", "Claude Code", "rules", "# x\n"), "for docs/**");
  assert.equal(label("app/.claude/rules/x.md", "Claude Code", "rules", "x"), "for app/**");
  assert.equal(label(".claude/CLAUDE.md", "Claude Code", "rules", "x", { global: true }), "always");
  assert.equal(label(".claude/skills/a/SKILL.md", "Claude Code", "skill", fm("name: a\ndescription: does a")), "on request");
  assert.equal(label(".claude/skills/a/SKILL.md", "Claude Code", "skill", fm("description: d\npaths: **/*.sql")), "for **/*.sql");
  assert.equal(label(".claude/skills/a/SKILL.md", "Claude Code", "skill", fm("description: d\ndisable-model-invocation: true")), "manual");
  assert.equal(label("pkg/.claude/skills/a/SKILL.md", "Claude Code", "skill", fm("description: d")), "for pkg/**");
});

test("scope: Cursor rules (alwaysApply / globs / description / none)", () => {
  const c = (text) => label(".cursor/rules/r.mdc", "Cursor", "rules", text);
  assert.equal(c(fm("description: Style\nalwaysApply: true\nglobs: *.ts")), "always");
  assert.equal(c(fm("globs: docs/**/*.md, docs/**/*.mdx\nalwaysApply: false")), "for docs/**/*.md, docs/**/*.mdx");
  assert.equal(c(fm("description: When writing SQL\nalwaysApply: false")), "on request");
  assert.equal(c(fm("alwaysApply: false")), "manual");
  assert.equal(label(".cursorrules", "Cursor", "rules", "x"), "always");
});

test("scope: Copilot instructions (applyTo / excludeAgent)", () => {
  const p = (text) => scopeOf({ rel: ".github/instructions/ts.instructions.md", tool: "GitHub Copilot", kind: "rules" }, text);
  assert.equal(label(".github/copilot-instructions.md", "GitHub Copilot", "rules", "x"), "always");
  assert.equal(p(fm('applyTo: "**/*.ts,**/*.tsx"')).label, "for **/*.ts, **/*.tsx");
  assert.equal(p(fm('applyTo: "**"')).label, "always");
  const ex = p(fm('applyTo: "app/models/**/*.rb"\nexcludeAgent: "code-review"'));
  assert.deepEqual([ex.label, ex.note], ["for app/models/**/*.rb", "not for code-review"]);
  assert.equal(p(fm("description: Python style")).label, "on request");
  assert.equal(p("no front matter\n").label, "manual");
});

test("scope: front matter and globs", () => {
  assert.deepEqual(parseFrontMatter(fm("a: 1\nb:\n  - x\n  - 'y'\nc: |\n  one\n  two")), { a: "1", b: ["x", "y"], c: "one two" });
  assert.ok(globMatch("src/api/users.ts", "src/api/**/*.ts"));
  assert.ok(globMatch("src/api/v1/users.ts", "src/api/**/*.ts"));
  assert.ok(globMatch("README.md", "*.md"));
  assert.ok(!globMatch("docs/README.md", "*.md"), "*.md is the root only");
  assert.ok(globMatch("src/a.tsx", "src/**/*.{ts,tsx}"));
  assert.ok(globMatch("a/b/c.ts", "**/*.ts"));
  assert.ok(!globMatch("photos [2024/x", "photos [2024/**"), "an unusable [ matches nothing");
  assert.ok(globMatch("photos [2024/x", "photos \\[2024/**"));
  assert.ok(matcherMatches("Edit|Write", "Write") && !matcherMatches("Edit|Write", "Read"));
  assert.ok(matcherMatches("mcp__.*", "mcp__x__y") && matcherMatches("", "Bash") && matcherMatches("*", "Bash"));
  assert.ok(matcherMatches("Edit.*", "Edit") && !matcherMatches("Bash", "Edit"));
});

test("inEffectFor: rules, instruction files, skills and hooks for one file", () => {
  const it = (rel, tool, kind, text, global) => ({ rel, tool, kind, scope: scopeOf({ rel, tool, kind }, text, { global }) });
  const items = [
    it("CLAUDE.md", "Claude Code", "rules", "x"),
    it("docs/CLAUDE.md", "Claude Code", "rules", "x"),
    it("AGENTS.md", "Codex / AGENTS.md", "rules", "x"),
    it(".claude/rules/api.md", "Claude Code", "rules", fm("paths: src/api/**/*.ts")),
    it(".claude/rules/all.md", "Claude Code", "rules", "x"),
    it(".cursor/rules/sql.mdc", "Cursor", "rules", fm("description: SQL\nalwaysApply: false")),
    it(".cursor/rules/ts.mdc", "Cursor", "rules", fm("globs: src/**/*.ts")),
    it(".github/instructions/rb.instructions.md", "GitHub Copilot", "rules", fm('applyTo: "**/*.rb"')),
    it(".claude/skills/a/SKILL.md", "Claude Code", "skill", fm("description: a")),
    it(".claude/skills/sql/SKILL.md", "Claude Code", "skill", fm("description: s\npaths: **/*.sql")),
    it(".claude/skills/m/SKILL.md", "Claude Code", "skill", fm("description: m\ndisable-model-invocation: true")),
    { rel: ".claude/settings.json", tool: "Claude Code", kind: "settings" },
  ];
  const globalItems = [it(".claude/CLAUDE.md", "Claude Code", "rules", "x", true)];
  const merged = mergeSettings([
    {
      scope: "project",
      settings: {
        hooks: {
          PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "guard.sh" }] }, { matcher: "Bash", hooks: [{ type: "command", command: "bash.sh" }] }],
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt-ts.sh", if: "Edit(*.ts)" }, { type: "command", command: "fmt-py.sh", if: "Edit(*.py)" }] }],
          Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
        },
      },
    },
  ]);
  const r = inEffectFor("/repo/src/api/users.ts", { root: "/repo", items, globalItems, hooks: merged.hooks });
  assert.equal(r.rel, "src/api/users.ts");
  assert.deepEqual(r.rules.map((x) => x.rel), [".claude/rules/api.md", ".claude/rules/all.md", ".cursor/rules/ts.mdc"]);
  assert.deepEqual(r.onRequest.map((x) => x.rel), [".cursor/rules/sql.mdc"]);
  assert.deepEqual(r.instructions.map((x) => [x.rel, x.global]), [["CLAUDE.md", false], ["AGENTS.md", false], [".claude/CLAUDE.md", true]]);
  assert.ok(!r.instructions.find((x) => x.rel === "AGENTS.md").tools.includes("Claude Code"), "Claude reads CLAUDE.md instead of AGENTS.md");
  assert.deepEqual(r.skills.map((x) => [x.rel, x.how]), [[".claude/skills/a/SKILL.md", "description-triggered"]]);
  assert.deepEqual(r.hooks.map((h) => `${h.event} ${h.command}`), ["PreToolUse guard.sh", "PostToolUse fmt-ts.sh"]);

  const d = inEffectFor("docs/q.sql", { root: "/repo", items, hooks: merged.hooks });
  assert.deepEqual(d.instructions.map((x) => x.rel), ["CLAUDE.md", "docs/CLAUDE.md", "AGENTS.md"]);
  assert.deepEqual(d.skills.map((x) => x.rel), [".claude/skills/a/SKILL.md", ".claude/skills/sql/SKILL.md"]);
  assert.deepEqual(d.hooks.map((h) => h.command), ["guard.sh"]);

  // Without a CLAUDE.md, Claude Code reads AGENTS.md.
  const only = inEffectFor("x.rb", { root: "/repo", items: items.filter((i) => !/CLAUDE\.md$/.test(i.rel)) });
  assert.ok(only.instructions.find((x) => x.rel === "AGENTS.md").tools.includes("Claude Code"));
  assert.deepEqual(only.rules.map((x) => x.rel), [".claude/rules/all.md", ".github/instructions/rb.instructions.md"]);
  // A file outside the repo: only global setup.
  assert.deepEqual(inEffectFor("/elsewhere/a.ts", { root: "/repo", items, globalItems }).instructions.map((x) => x.rel), [".claude/CLAUDE.md"]);
});
