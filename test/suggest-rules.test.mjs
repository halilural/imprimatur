import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { globRe, safeRe, matchOf, firedBy, ruleMatches, declaredBy, recentCommands, repoFiles } = createRequire(import.meta.url)("../vscode/suggest-rules.js");

const repo = (files, manifests = [], commands = []) => ({ root: "/r/app", files, manifests, commands: new Map(commands) });

test("suggestion rules (#143): globs, marketplace regexes kept safe, each signal names what fired it", () => {
  assert.ok(globRe("**/*.tf").test("infra/main.tf"));
  assert.ok(globRe("**/*.tf").test("main.tf"));
  assert.ok(globRe("**/.claude-plugin/plugin.json").test(".claude-plugin/plugin.json"));
  assert.ok(!globRe("*.tf").test("infra/main.tf"));
  assert.ok(globRe("SRC/?.js").test("src/a.js"), "case-insensitive, as Claude Code matches");
  assert.equal(safeRe("x".repeat(300)), undefined);
  assert.ok(safeRe('"react"\\s*:'));
  const r = repo([".claude-plugin/plugin.json", "infra/main.tf"], [{ file: "web/package.json", text: '{"dependencies":{"react": "^19"}}' }], [["wrangler", 3]]);
  assert.equal(firedBy({ filesRead: ["**/*.tf"] }, r), "found infra/main.tf");
  assert.equal(firedBy({ manifestDeps: [{ file: "package\\.json$", pattern: '"react"\\s*:' }] }, r), "web/package.json lists react");
  assert.equal(firedBy({ cli: ["wrangler"] }, r), "recent Claude sessions here ran wrangler 3 times");
  assert.equal(firedBy({ cwd: ["/r/**"] }, r), "this folder matches /r/**");
  assert.equal(firedBy({ cli: ["terraform"], filesRead: ["**/*.go"] }, r), "");
  const t0 = Date.now();
  assert.equal(matchOf(/(a|aa)+$/, `${"a".repeat(40)}b`), undefined, "a pattern that backtracks without end is stopped");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(firedBy({ manifestDeps: [{ file: "package\\.json$", pattern: "(a|aa)+$" }] }, repo([], [{ file: "package.json", text: `${"a".repeat(40)}b` }])), "", "and does not match");
  assert.equal(matchOf(/re(act)/, "react"), "react");
  assert.equal(firedBy({ filesRead: ["**/**/**/*.tf"] }, r), "found infra/main.tf", "a run of ** counts once");
  assert.equal(firedBy({ filesRead: ["**a/**b/**c/**d/**e"] }, repo(["a/b/c/d/e"])), "", "more than four ** is refused");
});

test("suggestion rules (#143): the marketplace's own rule first, then the built-in table, by plugin name, each once", () => {
  const available = [
    { pluginId: "plugin-dev@claude-plugins-official", name: "plugin-dev", installCount: 70000 },
    { pluginId: "plugin-dev@other", name: "plugin-dev", installCount: 90000 },
    { pluginId: "tf@corp", name: "tf" },
    { pluginId: "vercel@claude-plugins-official", name: "vercel" },
  ];
  const r = repo([".claude-plugin/plugin.json", "infra/main.tf"]);
  const got = ruleMatches(available, r, { "tf@corp": { topic: "Terraform", signals: { filesRead: ["**/*.tf"] } } });
  assert.deepEqual(got.map((m) => [m.id, m.rule]), [["tf@corp", "marketplace"], ["plugin-dev@claude-plugins-official", "built-in"]], "the official one of a name, no vercel without vercel.json");
  assert.equal(got[1].why, "found .claude-plugin/plugin.json");
});

test("suggestion rules (#143): git lists the files only in a trusted folder; an untrusted one is walked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-files-"));
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "x", "a.js"), "");
  fs.writeFileSync(path.join(dir, "main.tf"), "");
  assert.deepEqual(repoFiles(dir, false), ["main.tf"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("suggestion rules (#143): the repo's own enabledPlugins, and the commands of recent sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-rules-"));
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "a@m": true, "b@m": false, "c@m": true, "bad id": true } }));
  assert.deepEqual(declaredBy(dir, ["c@m"]), ["a@m"]);
  const t = path.join(dir, "s.jsonl");
  fs.writeFileSync(t, [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "FOO=1 sudo wrangler deploy" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "/usr/bin/gh issue list" } }] } }].map((x) => JSON.stringify(x)).join("\n"));
  assert.deepEqual([...recentCommands(dir)], [["wrangler", 1], ["gh", 1]]);
  fs.rmSync(dir, { recursive: true, force: true });
});
