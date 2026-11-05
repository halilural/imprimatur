import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { installChecks, PLUGIN_LINE } = createRequire(import.meta.url)("../vscode/install-check.js");

test("install check (#81): CLI, hooks, MCP server and database, from the plugin or npm run setup; each missing one says how to fix it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "install-"));
  const byId = (o) => Object.fromEntries(installChecks({ home, ...o }).map((c) => [c.id, c]));
  const none = byId({});
  assert.deepEqual(Object.values(none).map((c) => c.ok), [false, false, false, true]);
  assert.equal(none.hooks.fix.value, PLUGIN_LINE);
  assert.equal(none.cli.fix.kind, "url");
  assert.match(none.mcp.why, /cannot read or write tasks/);
  const viaPlugin = byId({ claudeBin: `${home}/.local/bin/claude`, plugin: { id: "imprimatur@imprimatur", version: "0.108.0" } });
  assert.ok(Object.values(viaPlugin).every((c) => c.ok && !c.fix));
  assert.equal(viaPlugin.cli.why, "found at ~/.local/bin/claude");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /home/u/projects/imprimatur/hooks/run.mjs stop" }] }] } }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { imprimatur: { command: "node" } } }));
  const viaSetup = byId({ claudeBin: "/x/claude" });
  assert.deepEqual([viaSetup.hooks.ok, viaSetup.mcp.ok], [true, true]);
  assert.match(viaSetup.hooks.why, /npm run setup/);
  const noDb = byId({ claudeBin: "/x/claude", dbError: "locked" });
  assert.deepEqual([noDb.db.ok, noDb.db.fix.value], [false, "workbench.action.reloadWindow"]);
});
