import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { groupDrift, driftOf, driftLabel, excluded, driftRepos, DriftScanner } = createRequire(import.meta.url)("../vscode/setup-drift.js");

function repo(dir, files, git = true) {
  if (git) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test("drift: copies of a path are grouped by hash; one repo sees how many differ from its own", () => {
  const groups = groupDrift([
    { name: "a", files: { ".claude/hooks/x.sh": "h1", ".claude/settings.json": "s1", "CLAUDE.md": "c1", "only.md": "o" } },
    { name: "b", files: { ".claude/hooks/x.sh": "h1", ".claude/settings.json": "s1", "CLAUDE.md": "c2" } },
    { name: "c", files: { ".claude/hooks/x.sh": "h2", ".claude/settings.json": "s1" } },
    { name: "d", files: { ".claude/hooks/x.sh": "h1" } },
  ]);
  assert.deepEqual([...groups.keys()], [".claude/hooks/x.sh", ".claude/settings.json"], "CLAUDE.md excluded, single copies dropped");
  const hook = groups.get(".claude/hooks/x.sh");
  assert.deepEqual(hook.variants, [{ hash: "h1", repos: ["a", "b", "d"] }, { hash: "h2", repos: ["c"] }]);
  assert.equal(hook.total, 4);
  assert.deepEqual(driftOf(hook, "h1"), { differs: 1, total: 4, others: [{ hash: "h2", repos: ["c"] }] });
  assert.equal(driftLabel(driftOf(hook, "h2")), "differs in 3 of 4 repos");
  assert.equal(driftOf(groups.get(".claude/settings.json"), "s1"), undefined, "all copies match");
  assert.equal(driftOf(undefined, "x"), undefined);
  // The exclude list is a setting: with none, CLAUDE.md drifts too.
  assert.equal(groupDrift([{ name: "a", files: { "CLAUDE.md": "1" } }, { name: "b", files: { "CLAUDE.md": "2" } }], { exclude: [] }).get("CLAUDE.md").variants.length, 2);
});

test("drift: exclude entries match a file name, a path or a folder", () => {
  assert.equal(excluded("docs/CLAUDE.md", ["CLAUDE.md"]), true);
  assert.equal(excluded(".claude/settings.json", [".claude/settings.json"]), true);
  assert.equal(excluded("x/.claude/settings.json", [".claude/settings.json"]), false);
  assert.equal(excluded(".cursor/rules/a.mdc", [".cursor/rules/"]), true);
  assert.equal(excluded(".claude/hooks/a.sh", ["CLAUDE.md"]), false);
});

test("drift: repos are the roots plus git repos under the drift roots, each once; scan hashes once per size+mtime", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "setup-drift-"));
  const projects = path.join(base, "projects");
  const here = repo(path.join(projects, "here"), { ".claude/hooks/x.sh": "echo 1\n", ".claude/settings.json": "{}", "CLAUDE.md": "mine\n" });
  repo(path.join(projects, "two"), { ".claude/hooks/x.sh": "echo 2\n", ".claude/settings.json": "{}", "CLAUDE.md": "theirs\n", "node_modules/p/.claude/hooks/x.sh": "no\n", ".claude/worktrees/w/.claude/hooks/x.sh": "no\n" });
  repo(path.join(projects, "three"), { ".claude/hooks/x.sh": "echo 1\n" });
  repo(path.join(projects, "notgit"), { ".claude/hooks/x.sh": "echo 3\n" }, false);
  assert.deepEqual(driftRepos([here], [projects]).map((r) => r.name), ["here", "three", "two"]);

  const s = new DriftScanner();
  const groups = await s.scan([here], { driftRoots: [projects] });
  assert.deepEqual([...groups.keys()], [".claude/hooks/x.sh", ".claude/settings.json"]);
  const d = s.driftFor(".claude/hooks/x.sh", path.join(here, ".claude/hooks/x.sh"));
  assert.equal(driftLabel(d), "differs in 1 of 3 repos");
  assert.deepEqual(d.others, [{ hash: d.others[0].hash, repos: ["two"] }]);
  assert.equal(s.pathOf(".claude/hooks/x.sh", d.others[0].hash), path.join(projects, "two", ".claude/hooks/x.sh"));
  assert.equal(s.driftFor(".claude/settings.json", path.join(here, ".claude/settings.json")), undefined);
  assert.equal(s.hashed, 5, "CLAUDE.md not hashed (excluded)");

  // Nothing changed: no file is read again.
  await s.scan([here], { driftRoots: [projects] });
  assert.equal(s.hashed, 5);
  // A window repo's file changes: only it is hashed again, and the drift follows.
  fs.writeFileSync(path.join(here, ".claude/hooks/x.sh"), "echo 2\n");
  await s.scan([here], { driftRoots: [projects] });
  assert.equal(s.hashed, 6);
  assert.equal(driftLabel(s.driftFor(".claude/hooks/x.sh", path.join(here, ".claude/hooks/x.sh"))), "differs in 1 of 3 repos");
  assert.deepEqual(s.groups.get(".claude/hooks/x.sh").variants.map((v) => v.repos), [["here", "two"], ["three"]]);
});
