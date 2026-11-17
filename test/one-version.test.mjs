// One version everywhere: the extension's (vscode/package.json) is the release; the repo's
// package.json and the Claude Code plugin's manifest carry the same, so none lags behind.
import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8")).version;

test("the repo, the extension and the plugin manifest have one version", () => {
  const release = read("vscode/package.json");
  assert.equal(read("package.json"), release, "package.json");
  assert.equal(read(".claude-plugin/plugin.json"), release, ".claude-plugin/plugin.json");
});
