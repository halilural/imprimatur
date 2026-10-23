// #77 agent setup audit: agnix's findings become AUDIT records, tracked across runs.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { groupOf, findingsOf, reconcile, auditRoot, titleOf, bodyOf, describeSummary, globalPaths, TASK } = require("../vscode/setup-audit.js");
const { openDb } = require("../vscode/db.js");

const home = "/home/u";
const d = (rule, file, message, extra = {}) => ({ level: "warning", rule, file, line: 1, column: 1, message, category: "claude-hooks", ...extra });

test("audit: a file's group — plugin (named), worktree, user, project", () => {
  assert.deepEqual(groupOf("/home/u/.claude/plugins/cache/claude-plugins-official/datadog/0.7.17/hooks/hooks.json", { home }), { group: "plugin", owner: "datadog" });
  assert.deepEqual(groupOf("/home/u/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/hooks/hooks.json", { home }), { group: "plugin", owner: "hookify" });
  assert.deepEqual(groupOf("/home/u/.claude/plugins/marketplaces/ponytail/.github/plugin/plugin.json", { home }), { group: "plugin", owner: "ponytail" });
  assert.deepEqual(groupOf("/home/u/.claude/plugins/cache/temp_git_1791239705819_3nmj20/x/mcp.json", { home }), { group: "plugin", owner: "temp" });
  assert.deepEqual(groupOf("/home/u/p/repo/.claude/worktrees/agent-a1/CLAUDE.md", { home }), { group: "worktree", owner: "agent-a1" });
  assert.deepEqual(groupOf("/home/u/.claude/settings.json", { home }), { group: "user" });
  assert.deepEqual(groupOf("/home/u/p/repo/hooks/hooks.json", { home }), { group: "project" });
});

test("audit: every diagnostic is a finding; the fingerprint ignores the line, counts repeats", () => {
  const report = {
    diagnostics: [
      d("XP-003", "docs/a.md", "Hard-coded path '.claude/'", { line: 3 }),
      d("XP-003", "docs/a.md", "Hard-coded path '.claude/'", { line: 9 }),
      { level: "info", rule: "VER-001", file: "", message: "No tool or spec versions pinned." },
    ],
  };
  const fs1 = findingsOf(report, { root: "/r", home });
  assert.equal(fs1.length, 3);
  assert.notEqual(fs1[0].fp, fs1[1].fp);
  assert.equal(fs1[0].file, "/r/docs/a.md");
  assert.equal(fs1[0].rel, "docs/a.md");
  assert.equal(fs1[2].rel, "");
  // The same finding a few lines lower is the same finding.
  const moved = findingsOf({ diagnostics: [d("XP-003", "docs/a.md", "Hard-coded path '.claude/'", { line: 30 })] }, { root: "/r", home });
  assert.equal(moved[0].fp, fs1[0].fp);
  // Under the global root a file is the user's, unless it is a plugin's.
  const g = findingsOf({ diagnostics: [d("CC-HK-010", "/home/u/.claude/settings.json", "no timeout"), d("CC-HK-010", "/home/u/.claude/plugins/cache/m/p/1/hooks/hooks.json", "no timeout")] }, { root: home, home, global: true });
  assert.deepEqual(g.map((f) => f.group), ["user", "plugin"]);
});

test("audit: reconcile — new, moved, back, gone, dismissed", () => {
  const [a, b, c, e] = findingsOf({ diagnostics: [d("A-1", "x", "a"), d("B-1", "x", "b"), d("C-1", "x", "c"), d("E-1", "x", "e")] }, { root: "/r", home });
  const rec = (id, f, status, extra = {}) => ({ id, status, title: titleOf(f), links: { audit: { fp: f.fp, line: f.line } }, ...extra });
  const gone = findingsOf({ diagnostics: [d("G-1", "x", "g")] }, { root: "/r", home })[0];
  const plan = reconcile([a, b, c, { ...e, line: 7 }], [rec(1, b, "done"), rec(2, c, "dropped"), rec(3, gone, "open"), rec(4, e, "open")]);
  assert.deepEqual(plan.add.map((f) => f.rule), ["A-1"]);
  assert.deepEqual(plan.reopen.map((x) => x.id), [1]);
  assert.deepEqual(plan.update.map((x) => x.id), [4]);
  assert.deepEqual(plan.resolve, [3]);
  assert.equal(plan.dismissed, 1);
  assert.equal(plan.open, 3);
});

test("audit: the body says where, how bad, what to do and the rule's sources", () => {
  const [f] = findingsOf({ diagnostics: [d("CC-HK-010", "hooks/hooks.json", "no timeout", { suggestion: "Add a timeout", rule_severity: "MEDIUM", applies_to_tool: "claude-code" })] }, { root: "/r", home });
  const body = bodyOf(f, { name: "Timeout Policy", evidence: { source_urls: ["https://code.claude.com/docs/en/hooks"], verified_on: "2026-10-04", normative_level: "SHOULD", source_type: "vendor_docs" } });
  assert.match(body, /`hooks\/hooks.json`:1/);
  assert.match(body, /warning · MEDIUM · claude-hooks · claude-code/);
  assert.match(body, /Add a timeout/);
  assert.match(body, /CC-HK-010 \(Timeout Policy\); SHOULD, vendor_docs, verified 2026-10-04/);
  assert.match(body, /- https:\/\/code.claude.com\/docs\/en\/hooks/);
});

test("audit: runs write the AUDIT task — applied when gone, back when found again, dismissed stays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-db-"));
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-repo-"));
  // explain answers from a fake agnix: no process is started.
  const spawn = /** @type {any} */ ((_bin, args) => ({ status: 0, stdout: JSON.stringify({ id: args[1], name: "Rule", evidence: { source_urls: ["https://example.com/doc"] } }) }));
  const run = (diagnostics) => auditRoot(db, { root }, { bin: "agnix", spawn, report: { files_checked: 2, diagnostics } });
  try {
    const one = d("CC-HK-010", "hooks/hooks.json", "no timeout");
    const two = d("CC-MEM-006", "CLAUDE.md", "Negative instruction");
    let s = run([one, two]);
    assert.equal(s.added, 2);
    const repo = db.repoByRoot(root);
    const task = db.taskByKey(repo.id, TASK);
    const recs = () => db.recordsOf(task.id, { dropped: true });
    assert.deepEqual(recs().map((r) => [r.kind, r.status]), [["fixme", "open"], ["fixme", "open"]]);
    assert.match(recs()[0].body, /https:\/\/example.com\/doc/);
    // A container: not in where we left off.
    assert.deepEqual(db.whereWeLeftOff(repo.id).map((t) => t.key), []);
    // Fixed: gone from the report, so applied.
    s = run([two]);
    assert.equal(s.resolved, 1);
    assert.equal(recs()[0].status, "done");
    assert.match(recs()[0].body, /Applied: gone in the audit of/);
    // Back again: open.
    s = run([one, two]);
    assert.equal(s.reopened, 1);
    assert.equal(recs()[0].status, "open");
    // Dismissed by the user: never reopened, never resolved.
    db.updateRecord(recs()[1].id, { status: "dropped" }, { kind: "user" });
    s = run([one, two]);
    assert.equal(s.dismissed, 1);
    assert.equal(recs()[1].status, "dropped");
    s = run([one]);
    assert.equal(recs()[1].status, "dropped");
    assert.equal(db.taskByKey(repo.id, TASK).summary, "Agent setup: 1 open (1 warning) · 1 dismissed");
    // A dry run writes nothing.
    const before = JSON.stringify(recs());
    auditRoot(db, { root }, { bin: "agnix", spawn, dryRun: true, report: { diagnostics: [] } });
    assert.equal(JSON.stringify(recs()), before);
    assert.match(describeSummary(s), /2 files, 1 findings \(1 warning; project 1\)/);
  } finally {
    db.close();
  }
});

test("audit: the global root is the home's agent folders that exist, not the whole home", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "audit-home-"));
  fs.mkdirSync(path.join(h, ".claude"));
  fs.mkdirSync(path.join(h, ".cursor"));
  fs.mkdirSync(path.join(h, "projects"));
  assert.deepEqual(globalPaths(h), [path.join(h, ".claude"), path.join(h, ".cursor")]);
});

test("audit: the MCP tool audits the repo with the agnix it finds (AGNIX_BIN)", async () => {
  const { callTool, digest } = await import("../mcp/server.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-mcp-"));
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-mcp-repo-"));
  require("node:child_process").execFileSync("git", ["init", "-q", root]);
  // A fake agnix: one finding for any path, a rule for explain.
  const bin = path.join(dir, "agnix");
  fs.writeFileSync(bin, `#!/bin/sh\nif [ "$1" = explain ]; then echo '{"id":"CC-HK-010","name":"Timeout Policy"}'; else echo '{"files_checked":1,"diagnostics":[{"level":"warning","rule":"CC-HK-010","file":"hooks/hooks.json","line":1,"message":"no timeout"}]}'; exit 1; fi\n`, { mode: 0o755 });
  const prev = process.env.AGNIX_BIN;
  process.env.AGNIX_BIN = bin;
  try {
    const out = callTool(db, "setup_audit", { repo: root });
    assert.equal(out.audits.length, 1);
    assert.equal(out.audits[0].added, 1);
    assert.match(digest("setup_audit", out, {}), /1 files, 1 findings \(1 warning; project 1\); 1 open, 0 not loaded; 1 new/);
    const got = callTool(db, "task_get", { repo: root, key: TASK });
    assert.equal(got.records[0].kind, "fixme");
  } finally {
    if (prev === undefined) delete process.env.AGNIX_BIN;
    else process.env.AGNIX_BIN = prev;
    db.close();
  }
});

test("audit tree: Recommendations — status → (reason) → source → agnix category → rule → finding", () => {
  const { recommendationsRow, auditGroups } = require("../vscode/setup-audit-tree.js");
  assert.equal(recommendationsRow([{ label: "repo", root: "/r", records: [] }]).command, "imprimatur.setup.audit");
  const rec = (id, status, level, group, category, extra = {}) => ({
    id, status, title: `R-${id}: message ${id}`, body: `**Rule:** R-${id} (Rule ${id})`, links: { audit: { fp: `f${id}`, rule: `R-${id}`, level, category, group, file: `/r/f${id}.md`, line: id, ...extra } },
  });
  const records = [
    rec(1, "open", "warning", "project", "claude-hooks", { rule: "CC-HK-010" }), rec(2, "open", "error", "project", "claude-hooks", { rule: "CC-HK-010" }),
    rec(3, "open", "info", "project", "claude-memory"),
    rec(4, "open", "error", "plugin", "agent-skills", { owner: "datadog" }), rec(5, "done", "warning", "project", "claude-memory"),
    rec(6, "dropped", "error", "project", "claude-hooks", { reason: "false" }), rec(7, "dropped", "warning", "plugin", "xml", { owner: "hookify" }),
    rec(8, "dropped", "warning", "user", "agent-skills", { file: "/h/.claude/skills/synced/x/SKILL.md" }),
  ];
  const row = recommendationsRow([{ label: "repo", root: "/r", records }, { label: "other", root: "/o", records: [] }]);
  assert.equal(row.label, "Recommendations (4)");
  assert.equal(row.description, "2 errors · 1 warning · 1 info");
  assert.equal(row.children.length, 1, "a root never audited is left out");
  const [open, applied, dismissed] = row.children[0].children;
  assert.deepEqual([open.label, applied.label, dismissed.label], ["Open", "Applied", "Dismissed"]);
  assert.equal(open.expanded, true);
  const [project, plugins] = open.children;
  assert.deepEqual([project.label, plugins.label], ["Project", "Plugins"]);
  assert.deepEqual(project.children.map((c) => c.label), ["Claude hooks", "Claude memory"], "agnix's categories, biggest first");
  const [timeout] = project.children[0].children;
  assert.equal(timeout.label, "CC-HK-010 Rule 1");
  assert.deepEqual(timeout.children.map((c) => c.label), ["message 2", "message 1"], "errors first");
  assert.equal(timeout.children[0].context, "auditFinding-open");
  assert.equal(timeout.children[0].description, "f2.md:2");
  assert.equal(plugins.children[0].label, "datadog");
  assert.equal(plugins.children[0].children[0].label, "Agent skills");
  // Dismissed: by why first — a given reason, else a plugin's or a synced skill's.
  assert.deepEqual(dismissed.children.map((c) => c.label), ["Third-party plugin", "Synced skill (claude.ai)", "False alarm"]);
  assert.equal(dismissed.children[2].children[0].label, "Project");
  // The same grouping in Turkish, for the task page.
  const tr = auditGroups(records, { lang: "tr" });
  assert.deepEqual(tr.map((g) => [g.label, g.count]), [["Open", 4], ["Applied", 1], ["Dismissed", 3]]);
  assert.equal(tr[2].children[0].label, "Third-party plugin");
});

test("audit: a plugin update keeps its findings (no version in the fingerprint); a repo at the home is not walked", () => {
  const { fpPath, pathsOf } = require("../vscode/setup-audit.js");
  const at = (v) => findingsOf({ diagnostics: [d("CC-HK-010", `/home/u/.claude/plugins/cache/official/datadog/${v}/hooks/hooks.json`, "no timeout")] }, { root: home, home, global: true })[0];
  assert.equal(at("0.7.17").fp, at("0.7.18").fp);
  assert.equal(fpPath("/home/u/.claude/plugins/cache/official/datadog/0.7.17/hooks/hooks.json", "x"), "plugin:official/datadog/hooks/hooks.json");
  assert.equal(fpPath("/home/u/.claude/plugins/cache/temp_git_1_ab/mcp.json", "x"), "plugin-temp:mcp.json");
  assert.equal(fpPath("/r/hooks/hooks.json", "hooks/hooks.json"), "hooks/hooks.json");
  assert.deepEqual(pathsOf({ root: home, home }), []);
  assert.deepEqual(pathsOf({ root: "/home/u/p/repo", home }), ["/home/u/p/repo"]);
  // A project in a hidden folder of the home is still a project.
  assert.deepEqual(groupOf("/home/u/.local/src/x/CLAUDE.md", { home }), { group: "project" });
});

test("audit: the npx locate script runs from a private folder, removed after", () => {
  const { locateAgnix } = require("../vscode/setup-audit.js");
  let seen;
  const spawn = (cmd, args) => {
    seen = args.at(-1).replace(/"/g, "");
    assert.equal(fs.statSync(seen).mode & 0o077, 0, "owner only");
    assert.notEqual(path.dirname(seen), os.tmpdir());
    return { status: 0, stdout: "/x/agnix-binary" };
  };
  assert.equal(locateAgnix({ env: {}, spawn }), "/x/agnix-binary");
  assert.equal(fs.existsSync(path.dirname(seen)), false);
});

test("audit: this repo's task list shows the global audit too, in a Global (~) group", () => {
  const { tasksPage, tasksHtml } = require("../vscode/tasksView.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-tasks-"));
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-tasks-repo-"));
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "audit-tasks-home-"));
  try {
    const spawn = /** @type {any} */ (() => ({ status: 0, stdout: "{}" }));
    auditRoot(db, { root }, { bin: "agnix", spawn, report: { diagnostics: [d("A-1", "x.md", "a")] } });
    auditRoot(db, { root: h, home: h, global: true }, { bin: "agnix", spawn, report: { diagnostics: [d("B-1", path.join(h, ".claude/CLAUDE.md"), "b")] } });
    db.upsertTask(db.repoByRoot(h).id, "#9", { title: "Not shown", status: "active" });
    const m = tasksPage(db, root, { filter: "active" }, { home: h });
    assert.deepEqual(m.groups.map((g) => [g.tasks.map((t) => t.key), Boolean(g.global)]), [[["RECS"], false], [["RECS"], true]]);
    assert.match(tasksHtml(m), /Global \(~\)/);
    // Every repo: the home is one of them, no copy.
    const all = tasksPage(db, root, { filter: "active", all: true }, { home: h });
    assert.equal(all.groups.flatMap((g) => g.tasks).filter((t) => t.key === "RECS").length, 2);
  } finally {
    db.close();
  }
});

test("audit: synced skills are their own source; the AUDIT task page shows the findings grouped", () => {
  assert.deepEqual(groupOf("/home/u/.claude/skills/synced/abc/docx/SKILL.md", { home }), { group: "synced" });
  const { tasksPage, tasksHtml } = require("../vscode/tasksView.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-page-"));
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-page-repo-"));
  try {
    const spawn = /** @type {any} */ (() => ({ status: 0, stdout: JSON.stringify({ name: "Timeout Policy" }) }));
    auditRoot(db, { root }, { bin: "agnix", spawn, report: { diagnostics: [d("CC-HK-010", "hooks/hooks.json", "no timeout")] } });
    const task = db.taskByKey(db.repoByRoot(root).id, TASK);
    assert.equal(db.recordsOf(task.id)[0].links.audit.ruleName, "Timeout Policy");
    const m = tasksPage(db, root, { sel: task.id, filter: "active" }, { home: dir });
    assert.equal(m.cur.audit[0].label, "Open");
    const html = tasksHtml(m);
    assert.match(html, /Agent setup/);
    assert.match(html, /CC-HK-010 Timeout Policy/);
    assert.doesNotMatch(html, /data-k="todos"/, "no flat todo list for the audit");
  } finally {
    db.close();
  }
});

test("audit: what Claude Code loads — installed, on, a plugin part; the rest not loaded, with why", () => {
  const { effectOf, pluginsOf, summaryLine } = require("../vscode/setup-audit.js");
  const { auditGroups } = require("../vscode/setup-audit-tree.js");
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "audit-effect-"));
  const c = path.join(h, ".claude", "plugins", "cache");
  fs.mkdirSync(path.join(h, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {
    "dd@off": [{ scope: "user", installPath: path.join(c, "off", "dd", "1.0") }],
    "lin@off": [{ scope: "user", installPath: path.join(c, "off", "lin", "abc") }],
    "cm@x": [{ scope: "project", projectPath: "/p", installPath: path.join(c, "x", "cm", "2.0") }],
  } }));
  fs.writeFileSync(path.join(h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "lin@off": false, "cm@x": false } }));
  const plugins = pluginsOf(h);
  const eff = (p, group = "plugin") => effectOf(path.join(h, p), { group }, plugins);
  assert.deepEqual(eff(".claude/plugins/cache/off/dd/1.0/hooks/hooks.json"), { effect: "active" });
  assert.deepEqual(eff(".claude/plugins/cache/off/dd/1.0/skills/x/SKILL.md"), { effect: "active" });
  assert.deepEqual(eff(".claude/plugins/cache/off/dd/1.0/.cursor-plugin/plugin.json"), { effect: "inactive", why: "other-tool" });
  assert.deepEqual(eff(".claude/plugins/cache/off/dd/0.9/hooks/hooks.json"), { effect: "inactive", why: "not-installed" });
  assert.deepEqual(eff(".claude/plugins/cache/off/lin/abc/hooks/hooks.json"), { effect: "inactive", why: "disabled" });
  assert.deepEqual(eff(".claude/plugins/cache/x/cm/2.0/hooks/hooks.json"), { effect: "active" }, "a project-scope install is on in its project");
  assert.deepEqual(eff(".claude/plugins/marketplaces/off/plugins/dd/hooks/hooks.json"), { effect: "inactive", why: "catalog" });
  assert.deepEqual(eff(".claude/plugins/cache/temp_git_1_ab/mcp.json"), { effect: "inactive", why: "temp" });
  assert.deepEqual(eff(".claude/settings.json", "user"), { effect: "active" });
  assert.deepEqual(eff("p/.claude/worktrees/a/CLAUDE.md", "worktree"), { effect: "inactive", why: "worktree" });
  // Grouped: open = loaded; not loaded by why. The summary counts them apart.
  const rec = (id, effect, why) => ({ id, status: "open", title: `R: m${id}`, links: { audit: { fp: `${id}`, rule: "R", level: "warning", category: "c", group: "plugin", owner: "dd", file: "/f", effect, ...(why ? { why } : {}) } } });
  const recs = [rec(1, "active"), rec(2, "inactive", "catalog"), rec(3, "inactive", "catalog"), rec(4, "inactive", "temp")];
  assert.deepEqual(auditGroups(recs).map((g) => [g.key, g.count]), [["st:open", 1], ["st:idle", 3]]);
  assert.deepEqual(auditGroups(recs)[1].children.map((g) => g.label), ["Marketplace catalog", "Leftover temp clone"]);
  assert.equal(summaryLine(recs), "1 open (1 warning) · 3 not loaded");
});
