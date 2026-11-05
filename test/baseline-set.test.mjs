import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

test("baseline (#141): each item ok, to install, to turn on, or out for this repo; opting out is per repo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imp-base-"));
  process.env.IMPRIMATUR_DB = path.join(tmp, "db", "imprimatur.db");
  const { baselineOf, setOptOut } = require("../vscode/baseline.js");
  const home = path.join(tmp, "home"), root = path.join(tmp, "repo");
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: {
    "security-guidance@claude-plugins-official": [{ scope: "user" }],
    "context-mode@context-mode": [{ scope: "user" }],
    "ponytail@ponytail": [{ scope: "project", projectPath: path.join(tmp, "other") }],
  } }));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "context-mode@context-mode": false } }));
  fs.mkdirSync(path.join(home, ".claude", "skills", "humanizer"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "humanizer", "SKILL.md"), "x");
  const state = () => Object.fromEntries(baselineOf(root, { home, lsps: ["pyright-lsp@claude-plugins-official"] }).map((r) => [r.label, r.state]));
  assert.deepEqual(state(), { "pyright-lsp": "install", "security-guidance": "ok", ponytail: "install", "context-mode": "enable", humanizer: "ok" },
    "a plugin installed for another repo is not here; one the user turned off is to turn on");
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "ponytail@ponytail": false } }));
  setOptOut(root, "context-mode", true);
  assert.deepEqual(state(), { "pyright-lsp": "install", "security-guidance": "ok", ponytail: "out", "context-mode": "out", humanizer: "ok" }, "turned off by the repo, or opted out here");
  setOptOut(root, "context-mode", false);
  assert.equal(state()["context-mode"], "enable");
  const { checklistOf } = require("../vscode/setup-checklist.js");
  const node = checklistOf([], 0, [], { root, items: baselineOf(root, { home, lsps: [] }) }).node;
  const labels = node.children.map((c) => c.label);
  assert.deepEqual(labels, ["Baseline: turn on context-mode", "Baseline: 1 off in this repo"]);
  assert.match(node.children[0].tooltip, /⚠ it keeps its own session store/);
  delete process.env.IMPRIMATUR_DB;
  fs.rmSync(tmp, { recursive: true, force: true });
});
