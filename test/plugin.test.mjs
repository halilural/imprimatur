// The Claude Code plugin (#67): generated files match their source, setup's
// plugin helpers, and how hooks without args find language and extensions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginFiles } from "../scripts/plugin.mjs";
import { wanted, mergeHooks, removeOurHooks, pluginEnabled, pluginMatcher, pluginHooks, PLUGIN_ID } from "../scripts/setup.mjs";

const require = createRequire(import.meta.url);
const { hookLang, hookExts, mergeConfig, readConfig, configPath, imprimaturTool } = require("../vscode/config.js");
const repo = path.resolve(import.meta.dirname, "..");

test("plugin: committed hooks.json and plugin.json are the generated ones (npm run plugin)", () => {
  for (const [rel, text] of Object.entries(pluginFiles())) {
    assert.equal(fs.readFileSync(path.join(repo, rel), "utf8"), text, `${rel} is stale: run npm run plugin`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(repo, "vscode/package.json"), "utf8")).version);
  assert.deepEqual(manifest.mcpServers.imprimatur, { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"] });
  // No root .mcp.json: Claude Code would read it as this repo's project config too.
  assert.equal(fs.existsSync(path.join(repo, ".mcp.json")), false);
});

test("plugin: the marketplace lists this repo's root as the plugin, under the manifest's name", () => {
  const market = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin/marketplace.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".claude-plugin/plugin.json"), "utf8"));
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[manifest.name, "./"]]);
  assert.equal(`${manifest.name}@${market.name}`, PLUGIN_ID);
});

test("plugin: hooks.json has every settings hook, no args, scripts that exist, both MCP tool names", () => {
  const { hooks } = pluginHooks();
  const flat = Object.entries(hooks).flatMap(([event, groups]) => groups.map((g) => [event, g.matcher, g.hooks[0].command]));
  assert.equal(flat.length, wanted([]).length);
  for (const [, , command] of flat) {
    const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([\w-]+\.mjs)"$/.exec(command);
    assert.ok(m, command);
    assert.ok(fs.existsSync(path.join(repo, "hooks", m[1])));
  }
  assert.ok(flat.some(([e, m]) => e === "PreToolUse" && m === "mcp__imprimatur__.*|mcp__plugin_imprimatur_imprimatur__.*"));
  assert.ok(flat.some(([e, m]) => e === "PostToolUse" && m === "Edit|Write|MultiEdit|Bash|mcp__imprimatur__task_upsert|mcp__plugin_imprimatur_imprimatur__task_upsert"));
  const regex = new RegExp(hooks.PreToolUse.find((g) => g.matcher.includes("mcp__")).matcher);
  assert.ok(regex.test("mcp__plugin_imprimatur_imprimatur__record_add") && regex.test("mcp__imprimatur__task_get") && !regex.test("mcp__other__x"));
});

test("plugin: matchers get the plugin's tool names, others stay", () => {
  assert.equal(pluginMatcher(undefined), undefined);
  assert.equal(pluginMatcher("*"), "*");
  assert.equal(pluginMatcher("Edit|Write|Bash"), "Edit|Write|Bash");
  assert.equal(pluginMatcher("Bash|mcp__imprimatur__task_upsert"), "Bash|mcp__imprimatur__task_upsert|mcp__plugin_imprimatur_imprimatur__task_upsert");
});

test("setup --plugin: removeOurHooks takes ours out, keeps the rest, drops what it empties", () => {
  const root = "/home/u/projects/imprimatur";
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "node /x/guard.mjs" }] };
  const mine = { hooks: [{ type: "command", command: "node /x/process.mjs" }] }; // not under an imprimatur folder
  const before = { model: "x", statusLine: { type: "command", command: "s" }, hooks: { PreToolUse: [other], SessionStart: [mine] } };
  const added = mergeHooks(before, { root, lang: "Turkish" }).settings;
  // A group shared with someone else's handler keeps that handler.
  added.hooks.Stop[0].hooks.push({ type: "command", command: "say done" });
  const { settings, changes } = removeOurHooks(added);
  assert.equal(changes.length, wanted([]).length);
  assert.ok(changes.every((c) => c.startsWith("removed ")));
  assert.deepEqual(settings.hooks, { PreToolUse: [other], SessionStart: [mine], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
  assert.equal(settings.model, "x");
  assert.deepEqual(settings.statusLine, before.statusLine);
  // Windows paths, and settings with nothing of ours.
  const win = { hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "C:\\src\\imprimatur\\hooks\\waiting.mjs"' }] }] } };
  assert.deepEqual(removeOurHooks(win).settings, {});
  assert.deepEqual(removeOurHooks(before), { settings: before, changes: [] });
  assert.deepEqual(removeOurHooks({}), { settings: {}, changes: [] });
});

test("setup: pluginEnabled reads `claude plugin list --json`", () => {
  const p = (o) => ({ id: "imprimatur@imprimatur", version: "0.37.0", scope: "user", enabled: true, ...o });
  assert.equal(pluginEnabled([p({})]), true);
  assert.equal(pluginEnabled([p({ id: "imprimatur@my-fork" })]), true);
  assert.equal(pluginEnabled([p({ enabled: false })]), false);
  assert.equal(pluginEnabled([p({ scope: "project" })]), false);
  assert.equal(pluginEnabled([p({ id: "other@imprimatur" })]), false);
  assert.equal(pluginEnabled(undefined), false);
});

test("config: language from IMPRIMATUR_LANG, then the plugin's option, then config.json", () => {
  const file = { lang: "German" };
  assert.equal(hookLang({ IMPRIMATUR_LANG: "Turkish", CLAUDE_PLUGIN_OPTION_LANGUAGE: "French" }, file), "Turkish");
  assert.equal(hookLang({ CLAUDE_PLUGIN_OPTION_LANGUAGE: "French" }, file), "French");
  assert.equal(hookLang({ CLAUDE_PLUGIN_OPTION_LANGUAGE: " " }, file), "German");
  assert.equal(hookLang({}, {}), undefined);
});

test("config: extensions from args, then the plugin's option, then config.json, then md,mdx", () => {
  const file = { exts: ["txt"] };
  assert.deepEqual(hookExts(["MD", "rst"], { CLAUDE_PLUGIN_OPTION_EXTENSIONS: "adoc" }, file), ["md", "rst"]);
  assert.deepEqual(hookExts([], { CLAUDE_PLUGIN_OPTION_EXTENSIONS: ".adoc, MD" }, file), ["adoc", "md"]);
  assert.deepEqual(hookExts([], {}, file), ["txt"]);
  assert.deepEqual(hookExts([], {}, {}), ["md", "mdx"]);
});

test("config: config.json lives next to the database; setup merges into it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-config-"));
  const env = { IMPRIMATUR_DB: path.join(dir, "imprimatur.db") };
  assert.equal(configPath(env), path.join(dir, "config.json"));
  assert.deepEqual(readConfig(configPath(env)), {});
  fs.writeFileSync(configPath(env), JSON.stringify({ lang: "Turkish", other: 1 }));
  assert.equal(hookLang(env), "Turkish");
  assert.deepEqual(hookExts([], env), ["md", "mdx"]);
  const merged = mergeConfig(readConfig(configPath(env)), { exts: ["md", "TXT"] });
  assert.deepEqual(merged, { config: { lang: "Turkish", other: 1, exts: ["md", "txt"] }, changed: true });
  assert.equal(mergeConfig(merged.config, { lang: "Turkish" }).changed, false);
  fs.writeFileSync(configPath(env), "not json");
  assert.deepEqual(readConfig(configPath(env)), {});
});

test("config: Imprimatur's tools under both server names", () => {
  assert.equal(imprimaturTool("mcp__imprimatur__task_upsert"), "task_upsert");
  assert.equal(imprimaturTool("mcp__plugin_imprimatur_imprimatur__task_upsert"), "task_upsert");
  assert.equal(imprimaturTool("mcp__plugin_other_imprimatur__task_upsert"), undefined);
  assert.equal(imprimaturTool(undefined), undefined);
});
