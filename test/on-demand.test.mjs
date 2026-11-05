import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildIndex, mentioned, onDemand } = createRequire(import.meta.url)("../vscode/on-demand.js");

test("on demand (#144): the index holds the official marketplace's integrations, by their name's first part", () => {
  const available = [
    { pluginId: "terraform@claude-plugins-official", name: "terraform", description: "Terraform MCP server. More.", installCount: 12000, marketplaceName: "claude-plugins-official" },
    { pluginId: "stripe@claude-plugins-official", name: "stripe", description: "Stripe.", installCount: 80000, marketplaceName: "claude-plugins-official" },
    { pluginId: "code-review@claude-plugins-official", name: "code-review", description: "Review.", installCount: 400000, marketplaceName: "claude-plugins-official" },
    { pluginId: "rare@claude-plugins-official", name: "rare", description: "x", installCount: 10, marketplaceName: "claude-plugins-official" },
    { pluginId: "terraform@other", name: "terraform", description: "x", installCount: 90000, marketplaceName: "other" },
    { pluginId: "sentry@claude-plugins-official", name: "sentry", description: "Sentry.", installCount: 40000, marketplaceName: "claude-plugins-official" },
    { pluginId: "hookify@claude-plugins-official", name: "hookify", description: "Hooks.", installCount: 60000, marketplaceName: "claude-plugins-official" },
  ];
  const entries = { terraform: { source: "./external_plugins/terraform" }, stripe: { source: "./plugins/stripe", category: "productivity" }, "code-review": { source: "./plugins/code-review", category: "development" }, rare: { source: "./external_plugins/rare" },
    sentry: { source: { source: "git-subdir", url: "https://github.com/getsentry/x.git" }, category: "development" }, hookify: { source: "./plugins/hookify", category: "productivity", author: "Anthropic" } };
  const index = buildIndex(available, entries, () => ({ flags: [], reads: "1 MCP server" }));
  assert.deepEqual(Object.keys(index).sort(), ["sentry", "stripe", "terraform"], "a vendor's own repo counts; Anthropic's workflows, little-used and other marketplaces' plugins are left out");
  assert.deepEqual(index.terraform, [{ id: "terraform@claude-plugins-official", what: "Terraform MCP server.", installs: 12000, flags: [], reads: "1 MCP server" }]);
  assert.deepEqual(mentioned("Add a Terraform module for the bucket", ["terraform", "stripe"]), ["terraform"]);
  assert.deepEqual(mentioned("terraforming mars", ["terraform"]), [], "whole words only");
});

test("on demand (#144): an uncovered technology gives the agent its candidates once a week; a covered one nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-od-"));
  const state = path.join(dir, "on-demand.json");
  const index = { terraform: [{ id: "terraform@o", what: "Terraform MCP server.", installs: 12000, flags: ["brings its own memory"], reads: "MCP server terraform (network)" }] };
  const o = { index, covered: ["code-review", "cloudflare"], state, now: 1000 };
  const ctx = onDemand("write terraform for the bucket", "/r", o);
  assert.match(ctx, /names terraform, and no installed plugin, skill or MCP server covers it/);
  assert.match(ctx, /- terraform@o: Terraform MCP server\. \(12k installs; brings MCP server terraform \(network\); ⚠ brings its own memory\)/);
  assert.match(ctx, /install it only after they say yes/);
  assert.equal(onDemand("terraform again", "/r", { ...o, now: 2000 }), "", "once a week");
  assert.notEqual(onDemand("terraform again", "/r", { ...o, now: 1000 + 8 * 24 * 3600 * 1000 }), "");
  assert.equal(onDemand("terraform", "/r", { ...o, covered: ["terraform-skills"], state: path.join(dir, "b.json") }), "", "a skill named for it covers it");
  assert.equal(onDemand("nothing here", "/r", o), "");
  fs.rmSync(dir, { recursive: true, force: true });
});
