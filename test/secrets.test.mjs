// #124: keys and tokens move from config.json to secrets.json (0600); agents are kept off it.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const sec = require("../vscode/secrets.js");
const { readJira } = require("../vscode/tracker.js");

const setup = (config) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-124-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  return path.join(dir, "imprimatur.db");
};
const json = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const CONFIG = {
  lang: "Turkish",
  plugins: ["/p/plugin/index.js"],
  sync: { url: "https://sync.example", token: "sync-secret" },
  cards: { url: "https://cards.example", key: "cards-secret", deck: "Misc" },
  tracker: { jira: { baseUrl: "https://acme.atlassian.net", email: "me@acme.test", token: "jira-secret" } },
};

test("secrets: only the keys a reader takes move; the rest stay and are named; values never returned", () => {
  const db = setup(CONFIG);
  const f = sec.filesOf(db);
  const r = sec.migrateSecrets(db, { keys: [...sec.OWN, "sync.token"] });
  assert.deepEqual(r, { moved: ["sync.token", "tracker.jira.token"], left: ["cards.key"] });
  assert.ok(!JSON.stringify(r).includes("secret"), "no value in the report");
  const config = json(f.config);
  assert.deepEqual(config.sync, { url: "https://sync.example" });
  assert.equal(config.cards.key, "cards-secret", "a plugin that does not read secrets.json keeps its key");
  assert.deepEqual(config.tracker.jira, { baseUrl: "https://acme.atlassian.net", email: "me@acme.test" });
  assert.equal(config.lang, "Turkish");
  assert.deepEqual(json(f.secrets), { sync: { token: "sync-secret" }, tracker: { jira: { token: "jira-secret" } } });
  if (process.platform !== "win32") for (const file of [f.config, f.secrets]) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
  // Again, the cards plugin updated: it moves too; nothing else changes.
  assert.deepEqual(sec.migrateSecrets(db, { keys: [...sec.OWN, "sync.token", "cards.key"] }), { moved: ["cards.key"], left: [] });
  assert.equal(json(f.secrets).cards.key, "cards-secret");
  assert.deepEqual(sec.migrateSecrets(db, { keys: [...sec.OWN, "sync.token", "cards.key"] }), { moved: [], left: [] });
});

test("secrets: a value already in secrets.json wins over config.json's", () => {
  const db = setup({ sync: { url: "u", token: "old" } });
  fs.writeFileSync(sec.filesOf(db).secrets, JSON.stringify({ sync: { token: "new" } }), { mode: 0o600 });
  sec.migrateSecrets(db, { keys: ["sync.token"] });
  assert.equal(json(sec.filesOf(db).secrets).sync.token, "new");
  assert.deepEqual(json(sec.filesOf(db).config), { sync: { url: "u" } });
});

test("secrets: the plugins' declared keys, with Imprimatur's own", () => {
  assert.deepEqual(sec.keysOf({ plugins: [{ secrets: ["sync.token"] }, { name: "remote" }, { secrets: ["cards.key", 3] }] }), ["tracker.jira.token", "sync.token", "cards.key"]);
  assert.deepEqual(sec.keysOf(undefined), ["tracker.jira.token"]);
});

test("secrets: Jira reads its token from secrets.json after the move; one others may read is ignored", () => {
  const db = setup(CONFIG);
  sec.migrateSecrets(db);
  assert.deepEqual(readJira(db, {}, "linux"), { jira: { baseUrl: "https://acme.atlassian.net", email: "me@acme.test", token: "jira-secret" } });
  if (process.platform !== "win32") {
    fs.chmodSync(sec.filesOf(db).secrets, 0o644);
    assert.match(readJira(db, {}, "linux").why, /no token/);
  }
  assert.equal(readJira(db, { IMPRIMATUR_JIRA_TOKEN: "env" }, "linux").jira.token, "env", "the env var still wins");
});

test("secrets: Claude Code's file tools are denied the keys file; setup adds the rules once", () => {
  const home = "/home/u";
  assert.deepEqual(sec.denyRules("/home/u/.local/share/imprimatur/imprimatur.db", home), ["Read(~/.local/share/imprimatur/secrets.json)", "Edit(~/.local/share/imprimatur/secrets.json)"]);
  assert.deepEqual(sec.denyRules("/data/imprimatur/imprimatur.db", home), ["Read(//data/imprimatur/secrets.json)", "Edit(//data/imprimatur/secrets.json)"]);
  const rules = sec.denyRules("/home/u/.local/share/imprimatur/imprimatur.db", home);
  const { settings, change } = sec.mergeDeny({ permissions: { allow: ["x"], deny: ["Read(.env)"] } }, rules);
  assert.deepEqual(settings.permissions, { allow: ["x"], deny: ["Read(.env)", ...rules] });
  assert.match(change, /permissions.deny/);
  assert.equal(sec.mergeDeny(settings, rules).change, undefined);
});
