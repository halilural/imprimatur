import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { mergeSettings, decide, readSources, managedDir, ruleCovers } = createRequire(import.meta.url)("../vscode/setup-merged.js");
const src = (scope, settings) => ({ scope, file: `${scope}.json`, settings });

test("merged: user allows, project denies → deny blocks it (and the reverse)", () => {
  // https://code.claude.com/docs/en/permissions#settings-precedence
  const m = mergeSettings([src("user", { permissions: { allow: ["Bash(npm run *)"] } }), src("project", { permissions: { deny: ["Bash(npm run *)"] } })]);
  assert.deepEqual(decide(m, "Bash(npm run build)"), { effect: "deny", rule: "Bash(npm run *)", scope: "project" });
  const allow = m.permissions.allow[0];
  assert.deepEqual([allow.effective, allow.overriddenBy], [false, { effect: "deny", rule: "Bash(npm run *)", scope: "project" }]);
  const rev = mergeSettings([src("user", { permissions: { deny: ["WebFetch"] } }), src("project", { permissions: { allow: ["WebFetch"] } })]);
  assert.equal(decide(rev, "WebFetch").effect, "deny");
});

test("merged: a broad deny beats a narrower allow; ask beats allow; specificity doesn't matter", () => {
  // https://code.claude.com/docs/en/permissions — Bash(aws *) vs Bash(aws s3 ls)
  const m = mergeSettings([src("local", { permissions: { allow: ["Bash(aws s3 ls)", "Bash(git push)", "Read"] } }), src("managed", { permissions: { deny: ["Bash(aws *)"] } }), src("project", { permissions: { ask: ["Bash(git push *)", "Bash(git push)"] } })]);
  assert.deepEqual(decide(m, "Bash(aws s3 ls)"), { effect: "deny", rule: "Bash(aws *)", scope: "managed" });
  assert.equal(decide(m, "Bash(git push)").effect, "ask");
  assert.deepEqual(decide(m, "Read(src/a.ts)"), { effect: "allow", rule: "Read", scope: "local" });
  assert.equal(decide(m, "Edit(a)").effect, "default");
  const byRule = Object.fromEntries(m.permissions.allow.map((r) => [r.rule, r]));
  assert.equal(byRule["Bash(aws s3 ls)"].overriddenBy.scope, "managed");
  assert.equal(byRule["Bash(git push)"].overriddenBy.effect, "ask");
  assert.equal(byRule.Read.effective, true);
  assert.ok(ruleCovers("Bash(npm:*)", "Bash(npm test)") && ruleCovers("mcp__github", "mcp__github__get_issue") && !ruleCovers("Bash(git *)", "Bash"));
});

test("merged: lists merge across scopes; one row per rule with the highest scope", () => {
  const m = mergeSettings([src("user", { permissions: { allow: ["Bash(ls)", "Bash(pwd)"] } }), src("project", { permissions: { allow: ["Bash(ls)"] } })]);
  assert.deepEqual(m.permissions.allow.map((r) => [r.rule, r.scope, r.alsoIn]), [["Bash(ls)", "project", ["user"]], ["Bash(pwd)", "user", []]]);
});

test("merged: allowManagedPermissionRulesOnly ignores every other scope's rules", () => {
  const m = mergeSettings([src("managed", { allowManagedPermissionRulesOnly: true, permissions: { ask: ["Bash"] } }), src("user", { permissions: { allow: ["Bash(ls)"], deny: ["Read"] } })]);
  assert.equal(decide(m, "Bash(ls)").effect, "ask");
  assert.equal(decide(m, "Read(x)").effect, "default");
  assert.ok(m.permissions.allow[0].ignored);
});

test("merged: hooks from every scope run (in parallel), identical handlers once, in event order", () => {
  const same = { type: "command", command: "bash .claude/hooks/guard.sh" };
  const m = mergeSettings([
    src("user", { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify.sh", async: true }] }], PreToolUse: [{ matcher: "Bash", hooks: [same] }] } }),
    src("project", { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [same, { type: "command", command: "git.sh", if: "Bash(git *)" }] }], SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "s.sh" }] }] } }),
    src("managed", { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "audit.sh" }] }] } }),
    src("local", { hooks: { Stop: [{ matcher: "ignored", hooks: [{ type: "command", command: "local-stop.sh" }] }] } }),
  ]);
  assert.deepEqual(m.hooks.map((e) => e.event), ["SessionStart", "PreToolUse", "Stop"]);
  const pre = m.hooks.find((e) => e.event === "PreToolUse").handlers;
  assert.deepEqual(pre.map((h) => [h.scope, h.matcher, h.command, h.if, h.alsoIn]), [
    ["managed", "Edit|Write", "audit.sh", undefined, []],
    ["project", "Bash", "bash .claude/hooks/guard.sh", undefined, ["user"]],
    ["project", "Bash", "git.sh", "Bash(git *)", []],
  ]);
  const stop = m.hooks.find((e) => e.event === "Stop").handlers;
  assert.deepEqual(stop.map((h) => [h.scope, h.command, h.async, h.matcherIgnored]), [["local", "local-stop.sh", false, true], ["user", "notify.sh", true, false]]);
  assert.ok(m.hooks.every((e) => e.parallel));
});

test("merged: disableAllHooks follows precedence and can't turn off managed hooks from below", () => {
  // https://code.claude.com/docs/en/hooks#disable-or-remove-hooks
  const hooks = (c) => ({ hooks: { Stop: [{ hooks: [{ type: "command", command: c }] }] } });
  const m = mergeSettings([src("managed", hooks("m.sh")), src("user", { disableAllHooks: true, ...hooks("u.sh") }), src("project", hooks("p.sh"))]);
  assert.deepEqual(m.hooks[0].handlers.map((h) => [h.command, h.active]), [["m.sh", true], ["p.sh", false], ["u.sh", false]]);
  // A project false overrides a user true.
  const p = mergeSettings([src("user", { disableAllHooks: true, ...hooks("u.sh") }), src("project", { disableAllHooks: false })]);
  assert.equal(p.hooks[0].handlers[0].active, true);
  // allowManagedHooksOnly blocks user, project and local hooks.
  const o = mergeSettings([src("managed", { allowManagedHooksOnly: true, ...hooks("m.sh") }), src("local", hooks("l.sh"))]);
  assert.deepEqual(o.hooks[0].handlers.map((h) => h.active), [true, false]);
  // `if` on a non-tool event never runs.
  const f = mergeSettings([src("user", { hooks: { Stop: [{ hooks: [{ type: "command", command: "x", if: "Bash(*)" }] }] } })]);
  assert.equal(f.hooks[0].handlers[0].active, false);
});

test("merged: the Effective settings tree has one child per event and a Permissions child", () => {
  const { mergedTree } = createRequire(import.meta.url)("../vscode/setup-merged.js");
  const m = mergeSettings([src("project", { hooks: { Stop: [{ hooks: [{ type: "command", command: "bash .claude/hooks/stop.sh" }] }] }, permissions: { allow: ["Bash(ls)"], deny: ["Bash"] } })]);
  const t = mergedTree(m);
  assert.deepEqual(t.children.map((c) => c.label), ["Stop", "Permissions"]);
  assert.equal(t.children[0].children[0].label, "stop.sh");
  assert.deepEqual(t.children[1].children.map((c) => [c.label, c.description]), [["deny Bash", "project"], ["allow Bash(ls)", "project · loses to deny Bash (project)"]]);
});

test("merged: reads user, project, local and managed files (managed-settings.d alphabetical)", () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "merged-"));
  const w = (rel, o) => {
    fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true });
    fs.writeFileSync(path.join(t, rel), JSON.stringify(o));
  };
  w("home/.claude/settings.json", { disableAllHooks: true });
  w("repo/.claude/settings.json", { permissions: { allow: ["Bash(ls)"] } });
  w("repo/.claude/settings.local.json", { permissions: { deny: ["Bash(ls)"] } });
  w("etc/managed-settings.json", { disableAllHooks: false });
  w("etc/managed-settings.d/20-b.json", { disableAllHooks: true });
  w("etc/managed-settings.d/10-a.json", { permissions: { defaultMode: "plan" } });
  fs.writeFileSync(path.join(t, "etc/managed-settings.d/.hidden.json"), "{}");
  const s = readSources({ root: path.join(t, "repo"), home: path.join(t, "home"), managedDir: path.join(t, "etc") });
  assert.deepEqual(s.map((x) => [x.scope, path.relative(t, x.file)]), [
    ["managed", "etc/managed-settings.json"], ["managed", "etc/managed-settings.d/10-a.json"], ["managed", "etc/managed-settings.d/20-b.json"],
    ["local", "repo/.claude/settings.local.json"], ["project", "repo/.claude/settings.json"], ["user", "home/.claude/settings.json"],
  ]);
  const m = mergeSettings(s);
  assert.deepEqual(m.disableAllHooks, { value: true, scope: "managed" });
  assert.equal(decide(m, "Bash(ls)").scope, "local");
  assert.deepEqual([managedDir("darwin"), managedDir("linux"), managedDir("win32")], ["/Library/Application Support/ClaudeCode", "/etc/claude-code", "C:\\Program Files\\ClaudeCode"]);
});
