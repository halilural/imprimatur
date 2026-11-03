// #123: what runs on the machine, read from files; the status line answers from the plugin's copy.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { imprimaturPlugin, extensionVersion, codeVersion } = require("../vscode/versions.js");
const REPO = path.resolve(new URL("..", import.meta.url).pathname);

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-123-"));
const write = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
};

test("versions: the user-scope enabled plugin, the extension's version, a folder's code version", () => {
  const h = home();
  assert.equal(imprimaturPlugin({ home: h }), undefined);
  const install = path.join(h, ".claude", "plugins", "cache", "imprimatur", "imprimatur", "0.73.0");
  fs.mkdirSync(install, { recursive: true });
  write(path.join(h, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: {
    "imprimatur@imprimatur": [{ scope: "project", projectPath: "/x", installPath: "/nowhere", version: "0.1.0" }, { scope: "user", installPath: install, version: "0.73.0" }],
    "other@m": [{ scope: "user", installPath: install, version: "9" }],
  } });
  assert.deepEqual(imprimaturPlugin({ home: h }), { id: "imprimatur@imprimatur", version: "0.73.0", installPath: install });
  write(path.join(h, ".claude", "settings.json"), { enabledPlugins: { "imprimatur@imprimatur": false } });
  assert.equal(imprimaturPlugin({ home: h }), undefined, "disabled: not running");
  write(path.join(h, ".vscode-server", "extensions", "extensions.json"), [{ identifier: { id: "halilural.imprimatur" }, version: "0.75.0" }]);
  assert.equal(extensionVersion({ home: h }), "0.75.0");
  assert.equal(codeVersion(REPO), JSON.parse(fs.readFileSync(path.join(REPO, "vscode", "package.json"), "utf8")).version);
});

test("status line: with the plugin installed, the plugin's copy answers; a version other than the extension's is flagged", () => {
  const h = home();
  // A fake plugin copy that prints who answered.
  const install = path.join(h, "plugin");
  write(path.join(install, "hooks", "statusline.mjs"), 'process.stdout.write("from the plugin copy\\n");');
  write(path.join(h, ".claude", "plugins", "installed_plugins.json"), { plugins: { "imprimatur@imprimatur": [{ scope: "user", installPath: install, version: "0.73.0" }] } });
  let n = 0;
  // A session of its own per run: the status line caches its line for 2 s per repo and session.
  const run = (env = {}) => spawnSync(process.execPath, [path.join(REPO, "hooks", "statusline.mjs")], { input: JSON.stringify({ cwd: REPO, session_id: `s123-${process.pid}-${n++}` }), encoding: "utf8", env: { ...process.env, HOME: h, NO_COLOR: "1", IMPRIMATUR_DB: path.join(h, "i.db"), ...env } }).stdout;
  assert.equal(run(), "from the plugin copy\n");
  assert.notEqual(run({ IMPRIMATUR_STATUSLINE_HOP: "1" }), "from the plugin copy\n", "once only");
  // No plugin, an extension of another version: this copy answers and flags it.
  fs.rmSync(path.join(h, ".claude"), { recursive: true });
  write(path.join(h, ".vscode-server", "extensions", "extensions.json"), [{ identifier: { id: "halilural.imprimatur" }, version: "0.1.0" }]);
  const own = codeVersion(REPO);
  assert.match(run(), new RegExp(`⚠ ${own.replace(/\./g, "\\.")} ≠ extension 0\\.1\\.0`));
});
