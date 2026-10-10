// #27 wider agent setup scan and #30 setup health checks.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { scanSetup, flatItems, importsOf, gitRootOf, projectSlug, autoMemoryDir, managedDir, changesSince, snapshotOf, summarize } = require("../vscode/agent-setup.js");
const { checkHealth, checkHookScripts, checkImports, checkCursorRuleExt, checkJson, checkSecrets, missingScripts, words } = require("../vscode/setup-health.js");

function tree(files, base) {
  const root = base ?? fs.mkdtempSync(path.join(os.tmpdir(), "setup-health-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const kinds = (items) => flatItems(items).map((i) => [i.rel, i.tool, i.kind]);

test("scan: Cursor hooks and commands, Copilot custom agents and .vscode/mcp.json, Codex AGENTS.override.md", () => {
  const home = tree({});
  const root = tree({
    ".cursor/hooks.json": JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: ".cursor/hooks/format.sh" }] } }),
    ".cursor/commands/review.md": "Review the diff\n",
    ".github/agents/planner.agent.md": "---\nname: planner\ndescription: Plans work\n---\n",
    ".vscode/mcp.json": '{\n  // comment\n  "servers": { "github": {}, },\n}\n',
    ".vscode/settings.json": "{}",
    "AGENTS.override.md": "# Override\n",
    "svc/AGENTS.override.md": "# Svc override\n",
  });
  const items = scanSetup(root, { home });
  assert.deepEqual(kinds(items), [
    [".cursor/commands/review.md", "Cursor", "command"],
    [".cursor/hooks.json", "Cursor", "hooks"],
    [".github/agents/planner.agent.md", "GitHub Copilot", "agent"],
    [".vscode/mcp.json", "GitHub Copilot", "MCP servers"],
    ["AGENTS.override.md", "Codex / AGENTS.md", "rules"],
    ["svc/AGENTS.override.md", "Codex / AGENTS.md", "rules"],
  ]);
  const by = Object.fromEntries(items.map((i) => [i.rel, i]));
  assert.equal(by[".cursor/hooks.json"].summary, "1 hooks");
  assert.deepEqual(by[".cursor/hooks.json"].details, ["afterFileEdit → format.sh"]);
  assert.equal(by[".github/agents/planner.agent.md"].label, "planner");
  assert.equal(by[".github/agents/planner.agent.md"].summary, "Plans work");
  assert.equal(by[".vscode/mcp.json"].summary, "1 servers: github");
});

test("scan: global ~/.claude/rules, Cursor and Codex home files, managed policy files", () => {
  const home = tree({
    ".claude/rules/style.md": "# Style\n",
    ".claude/rules/lang/go.md": "# Go\n",
    ".claude/rules/notes.txt": "not a rule\n",
    ".cursor/hooks.json": JSON.stringify({ version: 1, hooks: {} }),
    ".cursor/commands/ship.md": "Ship it\n",
    ".codex/AGENTS.override.md": "# Temporary\n",
  });
  const managed = tree({
    "CLAUDE.md": "# Company rules\n",
    "managed-settings.json": JSON.stringify({ permissions: { deny: ["Bash(curl *)"] } }),
    "managed-mcp.json": JSON.stringify({ mcpServers: { corp: {} } }),
    "managed-settings.d/10-team.json": JSON.stringify({ model: "opus" }),
  });
  const items = scanSetup(home, { global: true, home, managedDir: managed });
  assert.deepEqual(kinds(items), [
    [".claude/rules/lang/go.md", "Claude Code", "rules"],
    [".claude/rules/style.md", "Claude Code", "rules"],
    [".codex/AGENTS.override.md", "Codex / AGENTS.md", "rules"],
    [".cursor/commands/ship.md", "Cursor", "command"],
    [".cursor/hooks.json", "Cursor", "hooks"],
    [path.join(managed, "CLAUDE.md"), "Claude Code", "managed policy"],
    [path.join(managed, "managed-settings.json"), "Claude Code", "managed policy"],
    [path.join(managed, "managed-mcp.json"), "Claude Code", "managed policy"],
    [path.join(managed, "managed-settings.d/10-team.json"), "Claude Code", "managed policy"],
  ]);
  const by = Object.fromEntries(items.map((i) => [i.rel, i]));
  assert.equal(by[path.join(managed, "managed-settings.json")].summary, "0 allow / 1 deny");
  assert.equal(by[path.join(managed, "managed-mcp.json")].summary, "1 servers: corp");
  assert.equal(by[path.join(managed, "CLAUDE.md")].label, "managed CLAUDE.md");
  assert.deepEqual(scanSetup(home, { global: true, home, managedDir: null }).filter((i) => i.kind === "managed policy"), []);
});

test("scan: managed policy folder per OS (Claude Code docs)", () => {
  assert.equal(managedDir("darwin"), "/Library/Application Support/ClaudeCode");
  assert.equal(managedDir("linux"), "/etc/claude-code");
  assert.equal(managedDir("win32"), "C:\\Program Files\\ClaudeCode");
});

test("scan: auto memory of the repo, keyed like Claude Code (git root, worktrees share the main repo's)", () => {
  const home = tree({});
  const root = tree({ ".git/HEAD": "ref: refs/heads/main\n", "CLAUDE.md": "# x\n" });
  const wt = tree({ ".git": `gitdir: ${path.join(root, ".git/worktrees/feature")}\n` }, path.join(root, ".claude/worktrees/feature"));
  fs.mkdirSync(path.join(root, "sub"));
  assert.equal(gitRootOf(path.join(root, "sub")), root);
  assert.equal(gitRootOf(wt), root);
  assert.equal(projectSlug("/home/me/projects/imprimatur"), "-home-me-projects-imprimatur");
  assert.equal(projectSlug("C:\\Users\\me\\my.repo"), "C--Users-me-my-repo");
  const mem = path.join(home, ".claude/projects", projectSlug(root), "memory");
  tree({ "MEMORY.md": "- [Pnpm](pnpm.md)\n", "pnpm.md": "---\ntype: feedback\n---\nUse pnpm\n", "notes.json": "{}" }, mem);
  for (const dir of [root, wt]) {
    const items = scanSetup(dir, { home }).filter((i) => i.kind === "memory");
    assert.deepEqual(items.map((i) => [i.rel, i.tool, i.label]), [
      [`~/.claude/projects/${projectSlug(root)}/memory/MEMORY.md`, "Claude Code", "MEMORY"],
      [`~/.claude/projects/${projectSlug(root)}/memory/pnpm.md`, "Claude Code", "pnpm"],
    ]);
  }
  // autoMemoryDirectory in settings moves it
  tree({ ".claude/settings.json": JSON.stringify({ autoMemoryDirectory: "~/mem" }) }, root);
  assert.equal(autoMemoryDir(root, home), path.join(home, "mem"));
});

test("scan: CLAUDE.md @imports are child rows, resolved from the importing file, ~ expanded, four hops deep", () => {
  const home = tree({ ".claude/shared.md": "# Shared\n" });
  const root = tree({
    "CLAUDE.md": "# Rules\n@AGENTS.md\nSee @docs/a.md and @~/.claude/shared.md.\n`@docs/ignored.md` and a@b.com\n```\n@docs/fenced.md\n```\n@missing.md\n",
    "AGENTS.md": "# Agents\n",
    "docs/a.md": "# A\n@b.md\n",
    "docs/b.md": "# B\n@c.md\n",
    "docs/c.md": "# C\n@d.md\n",
    "docs/d.md": "# D\n@e.md\n",
    "docs/e.md": "# E (fifth hop)\n",
    "docs/ignored.md": "x\n",
    "docs/fenced.md": "x\n",
  });
  const items = scanSetup(root, { home });
  const claude = items.find((i) => i.rel === "CLAUDE.md");
  assert.deepEqual(claude.children.map((c) => [c.rel, c.kind, c.label, c.parent]), [
    ["AGENTS.md", "import", "@AGENTS.md", "CLAUDE.md"],
    ["docs/a.md", "import", "@docs/a.md", "CLAUDE.md"],
    ["~/.claude/shared.md", "import", "@~/.claude/shared.md", "CLAUDE.md"],
  ]);
  const chain = [];
  for (let n = claude.children[1]; n; n = n.children?.[0]) chain.push(n.rel);
  assert.deepEqual(chain, ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"]);
  assert.deepEqual(importsOf(path.join(root, "CLAUDE.md"), home).map((i) => [i.written, i.exists, i.line]), [
    ["AGENTS.md", true, 2], ["docs/a.md", true, 3], ["~/.claude/shared.md", true, 3], ["missing.md", false, 8],
  ]);
  assert.deepEqual(importsOf("/x/CLAUDE.md", home, "@Design\\ Docs/spec.md\n").map((i) => i.abs), ["/x/Design Docs/spec.md"]);
  // a changed import counts as a change
  const seen = snapshotOf(items);
  fs.writeFileSync(path.join(root, "docs/a.md"), "# A changed\n@b.md\n");
  assert.equal(changesSince(scanSetup(root, { home }), seen).state["docs/a.md"], "changed");
});

test("health: hook scripts that do not exist; project dir, home and quotes resolved, plugin vars skipped", () => {
  const root = tree({ ".claude/hooks/ok.sh": "#!/bin/sh\n" });
  const home = tree({ ".claude/hooks/home.mjs": "" });
  assert.deepEqual(words(`"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh --flag 'a b'; echo hi`), ["$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh", "--flag", "a b", "echo", "hi"]);
  const ctx = { projectDir: root, cwd: root, home };
  assert.deepEqual(missingScripts(`"$CLAUDE_PROJECT_DIR"/.claude/hooks/ok.sh`, ctx), []);
  assert.deepEqual(missingScripts("bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/gone.sh", ctx), ["${CLAUDE_PROJECT_DIR}/.claude/hooks/gone.sh"]);
  assert.deepEqual(missingScripts("node ~/.claude/hooks/home.mjs && node ~/.claude/hooks/nope.mjs", ctx), ["~/.claude/hooks/nope.mjs"]);
  assert.deepEqual(missingScripts("bash .claude/hooks/rel.sh 2>/dev/null", ctx), [".claude/hooks/rel.sh"]);
  assert.deepEqual(missingScripts("node ${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs; ${CLAUDE_PLUGIN_DATA}/y.sh", ctx), []);
  assert.deepEqual(missingScripts("npx prettier --write . && echo 'done: a/b.sh'", ctx), []);
  assert.deepEqual(missingScripts("bash .claude/hooks/rel.sh", { home }), [], "relative path without a known cwd is skipped");

  const settings = tree({
    ".claude/settings.json": JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "bash .claude/hooks/missing.sh" }, { type: "prompt", prompt: "x.sh" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/exec.sh", args: ["--x"] }] }],
      },
    }),
    ".cursor/hooks.json": JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: ".cursor/hooks/fmt.sh" }] } }),
  }, root);
  const items = scanSetup(settings, { home });
  const probs = items.flatMap((it) => checkHookScripts(it, { root, global: false, home }));
  assert.deepEqual(probs.map((p) => [path.basename(path.dirname(path.dirname(p.file))) === path.basename(root) ? path.relative(root, p.file) : p.file, p.level, p.message]), [
    [".claude/settings.json", "error", "Stop hook runs .claude/hooks/missing.sh, which does not exist"],
    [".claude/settings.json", "error", "PreToolUse hook runs ${CLAUDE_PROJECT_DIR}/.claude/hooks/exec.sh, which does not exist"],
    [".cursor/hooks.json", "error", "afterFileEdit hook runs .cursor/hooks/fmt.sh, which does not exist"],
  ]);
  // global: $CLAUDE_PROJECT_DIR and relative paths are unknown, ~ is checked; Cursor user hooks run from ~/.cursor
  const g = tree({
    ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "bash $CLAUDE_PROJECT_DIR/x.sh; bash rel.sh; node ~/.claude/hooks/gone.mjs" }] }] } }),
    ".cursor/hooks.json": JSON.stringify({ version: 1, hooks: { stop: [{ command: "./hooks/there.sh" }, { command: "./hooks/not.sh" }] } }),
    ".cursor/hooks/there.sh": "",
  });
  const gp = scanSetup(g, { global: true, home: g, managedDir: null }).flatMap((it) => checkHookScripts(it, { root: g, global: true, home: g }));
  assert.deepEqual(gp.map((p) => p.message), ["Stop hook runs ~/.claude/hooks/gone.mjs, which does not exist", "stop hook runs ./hooks/not.sh, which does not exist"]);
});

test("health: broken @imports warn with their line; mentions that are not paths do not", () => {
  const root = tree({ "CLAUDE.md": "# R\n@AGENTS.md\n@docs/gone.md\nUse @types/node and ask @alice\n@~/nope.md\n", "AGENTS.md": "x\n" });
  const home = tree({});
  const [claude] = scanSetup(root, { home }).filter((i) => i.rel === "CLAUDE.md");
  assert.deepEqual(checkImports(claude, { home }).map((p) => [p.level, p.line, p.message]), [
    ["warn", 3, "@docs/gone.md on line 3 imports a file that does not exist"],
    ["warn", 5, "@~/nope.md on line 5 imports a file that does not exist"],
  ]);
});

test("health: a .md under .cursor/rules is skipped by Cursor", () => {
  const root = tree({ ".cursor/rules/old.md": "x\n", ".cursor/rules/new.mdc": "---\nalwaysApply: true\n---\n" });
  const probs = scanSetup(root, { home: root }).flatMap(checkCursorRuleExt);
  assert.equal(probs.length, 1);
  assert.equal(path.basename(probs[0].file), "old.md");
  assert.equal(probs[0].level, "warn");
});

test("health: invalid JSON; comments allowed only where the tool allows them", () => {
  const root = tree({
    ".claude/settings.json": '{\n  // no comments here\n  "model": "opus"\n}\n',
    ".mcp.json": '{"mcpServers": {"a": {}},}',
    ".vscode/mcp.json": '{\n  // fine in VS Code\n  "servers": {"a": {},},\n}\n',
    ".cursor/hooks.json": "{ not json",
    ".gemini/settings.json": '{ /* ok */ "theme": "x", }',
    ".claude/settings.local.json": '{"ok": true}',
  });
  const items = scanSetup(root, { home: root });
  const probs = Object.fromEntries(items.map((it) => [it.rel, checkJson(it)]));
  assert.equal(probs[".claude/settings.json"].length, 1);
  assert.equal(probs[".claude/settings.json"][0].level, "error");
  assert.match(probs[".claude/settings.json"][0].message, /^Not valid JSON near line 2 \(comments and trailing commas are not allowed here\)/);
  assert.equal(probs[".mcp.json"].length, 1);
  assert.equal(probs[".cursor/hooks.json"].length, 1);
  assert.deepEqual([probs[".vscode/mcp.json"], probs[".gemini/settings.json"], probs[".claude/settings.local.json"]], [[], [], []]);
  assert.equal(items.find((i) => i.rel === ".vscode/mcp.json").summary, "1 servers: a");
});

test("health: secrets in rule and memory files report the line, never the value", () => {
  const home = tree({});
  const fake = {
    aws: "AKIA" + "ABCDEFGHIJKLMNOP",
    ghp: "ghp_" + "a".repeat(36),
    pat: "github_pat_" + "B".repeat(30),
    ant: "sk-ant-" + "api03-" + "x".repeat(30),
    oai: "sk-proj-" + "y".repeat(30),
    pw: "Tr0ub4dor" + "AndHorse99",
  };
  const root = tree({
    "CLAUDE.md": [
      "# Rules", `aws ${fake.aws}`, `token ${fake.ghp}`, `pat ${fake.pat}`, `key ${fake.ant}`, `openai ${fake.oai}`,
      `password=${fake.pw}`, "token: ${GITHUB_TOKEN}", "api_key: <your-api-key-goes-here>", "password: short", "the token is rotated daily",
    ].join("\n"),
    ".claude/hooks/run.sh": `export TOKEN=${fake.ghp}\n`,
  });
  const items = scanSetup(root, { home });
  const probs = items.flatMap(checkSecrets);
  assert.deepEqual(probs.map((p) => [p.line, p.level]), [[2, "error"], [3, "error"], [4, "error"], [5, "error"], [6, "error"], [7, "warn"]]);
  assert.match(probs[0].message, /^Line 2 looks like an AWS access key/);
  assert.match(probs[4].message, /OpenAI/);
  assert.match(probs[3].message, /Anthropic/);
  for (const p of probs) for (const v of Object.values(fake)) assert.ok(!p.message.includes(v), "secret echoed");
  // memory files are checked too
  const mem = path.join(home, ".claude/projects", projectSlug(gitRootOf(root)), "memory");
  tree({ "note.md": `deploy key ${fake.ant}\n` }, mem);
  const memProbs = scanSetup(root, { home }).filter((i) => i.kind === "memory").flatMap(checkSecrets);
  assert.deepEqual(memProbs.map((p) => [path.basename(p.file), p.line]), [["note.md", 1]]);
});

test("health: checkHealth runs every check over a scope, import rows included, each file once", () => {
  const home = tree({});
  const root = tree({
    "CLAUDE.md": "@docs/a.md\n@AGENTS.md\n",
    "AGENTS.md": "x\n",
    "docs/a.md": `@gone.md\nkey sk-ant-${"z".repeat(30)}\n`,
    ".cursor/rules/x.md": "x\n",
    ".mcp.json": "{",
  });
  const probs = checkHealth(scanSetup(root, { home }), { root, global: false, home });
  assert.deepEqual(probs.map((p) => [path.relative(root, p.file), p.level]).sort(), [
    [".cursor/rules/x.md", "warn"], [".mcp.json", "error"], ["docs/a.md", "error"], ["docs/a.md", "warn"],
  ]);
  assert.equal(summarize(path.join(root, ".mcp.json"), { kind: "MCP servers" }).summary, "not valid JSON");
});
