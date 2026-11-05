import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { stackKeys, fitting, repoOf, vet } = createRequire(import.meta.url)("../vscode/suggest.js");

test("suggestions (#143): fit the stack by whole words, best first, installed and little-used ones left out; vetting flags", () => {
  const stack = [{ name: "Cloudflare Workers" }, { name: "Cloudflare D1" }, { name: "Terraform" }, { name: "GitHub REST API" }, { name: "Model Context Protocol" }];
  assert.deepEqual(stackKeys(stack)[0].keys, ["cloudflare workers", "cloudflare"]);
  assert.deepEqual(stackKeys([{ name: "Model Context Protocol" }, { name: "Claude (via CLI)" }]).map((k) => k.keys), [[], []], "what every plugin shares fits nothing");
  assert.deepEqual(stackKeys([{ name: "Visual Studio Code" }])[0].keys, ["vs code", "vscode"]);
  const available = [
    { pluginId: "cf@m", name: "cloudflare", description: "Workers and D1 on Cloudflare", installCount: 90000, source: { source: "url", url: "https://github.com/cloudflare/skills.git" } },
    { pluginId: "tf@m", name: "terraform", description: "HashiCorp Terraform skills", installCount: 40000, source: "./plugins/terraform" },
    { pluginId: "gh@m", name: "github", description: "Official GitHub MCP server", installCount: 1000000 },
    { pluginId: "tiny@m", name: "terraform-tiny", description: "terraform", installCount: 10 },
    { pluginId: "x@m", name: "react", description: "React components", installCount: 500000 },
    { pluginId: "have@m", name: "terraform-have", description: "terraform", installCount: 9999 },
    { pluginId: "word@m", name: "a", description: "terraformed land", installCount: 9999 },
  ];
  const got = fitting(available, stack, ["have@m"]);
  assert.deepEqual(got.map((p) => p.pluginId), ["gh@m", "cf@m", "tf@m"], "installs times the parts it fits");
  assert.deepEqual(got[1].fits, ["Cloudflare Workers", "Cloudflare D1"]);
  assert.equal(repoOf(available[0].source), "cloudflare/skills");
  assert.equal(repoOf("./plugins/terraform"), "");
  assert.deepEqual(vet({ description: "x" }, { license: "MIT" }, { hooks: 0, mcp: [] }), { flags: [], reads: "no hooks or MCP servers" });
  assert.deepEqual(vet({ description: "keeps a memory of sessions" }, { license: "" }, undefined).flags, ["brings its own memory or tasks: a second store next to Imprimatur's"]);
  assert.deepEqual(vet({ description: "x" }, { license: "" }, undefined).flags, [], "no license is shown, not flagged: installing is not redistributing");
  assert.equal(vet({}, { license: "MIT" }, { hooks: 2, mcp: ["ctx"] }).reads, "2 hooks, MCP server ctx (network)");
});

test("suggestions (#143): refreshed once a day or when the stack changes; repo facts from gh; parts read when local", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { refreshSuggestions, readSuggestions, DAY } = createRequire(import.meta.url)("../vscode/suggest.js");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "suggest-")), "s.json");
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "claude") return { available: [
      { pluginId: "tf@m", name: "terraform", description: "Terraform", installCount: 9000, source: { source: "url", url: "https://github.com/hashicorp/tf-skills.git" } },
      { pluginId: "local@m", name: "terraform-local", description: "Terraform helpers", installCount: 800, source: "./plugins/x" },
    ] };
    return { stargazers_count: 1234, pushed_at: "2026-10-30T00:00:00Z", license: { spdx_id: "MPL-2.0" } };
  };
  const o = { components: [{ name: "Terraform" }], installed: [], file, claude: "claude", home: "/h", run, partsOf: (p) => (p.source === "./plugins/x" ? { hooks: 1, mcp: [] } : undefined) };
  assert.equal(await refreshSuggestions({ ...o, now: 1000 }), true);
  const s = readSuggestions(file);
  assert.deepEqual(s.items.map((i) => [i.id, i.gh?.stars, i.gh?.license, i.reads.slice(0, 6)]), [["tf@m", 1234, "MPL-2.0", "hooks "], ["local@m", undefined, undefined, "1 hook"]]);
  assert.equal(calls.filter((c) => c.startsWith("gh")).length, 1, "gh only for a GitHub source");
  assert.equal(await refreshSuggestions({ ...o, now: 1000 + DAY - 1 }), false, "once a day");
  assert.equal(await refreshSuggestions({ ...o, now: 1000 + 1, components: [{ name: "Terraform" }, { name: "React" }] }), true, "a new stack refreshes");
});
