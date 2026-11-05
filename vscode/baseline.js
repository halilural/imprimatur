// @ts-check
// The baseline (#141): what Imprimatur wants in every repo, beyond what its own plugin brings
// (its hooks, MCP server and skills: issues, study, exercise, imprimatur-stats, social-post).
// Third-party items are not shipped: each is installed from its own marketplace or repo, at
// user scope, on the user's yes (the #128 license rule is for what Imprimatur redistributes).
// A missing item is a Checklist row with an Install action; a repo opts out of an item in
// Imprimatur's data for that repo, or by turning the plugin off in its own settings. Imprimatur
// touches only what it installs: it adds, and never edits or removes, a hook or a file it did not write.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * @typedef {{key: string, kind: "lsp" | "plugin" | "skill", label: string, why: string, id?: string, market?: string, repo?: string, warn?: string}} Item
 * @type {Item[]}
 */
const BASELINE = [
  { key: "lsp", kind: "lsp", label: "the repo's language server", why: "exact go-to-definition, references and type errors for the repo's language" },
  { key: "security-guidance", kind: "plugin", id: "security-guidance@claude-plugins-official", label: "security-guidance", why: "warns about security problems while Claude edits" },
  { key: "ponytail", kind: "plugin", id: "ponytail@ponytail", market: "DietrichGebert/ponytail", label: "ponytail", why: "the smallest change that fully solves a task" },
  { key: "context-mode", kind: "plugin", id: "context-mode@context-mode", market: "mksglu/context-mode", label: "context-mode", why: "keeps large tool output out of the context window",
    warn: "it keeps its own session store next to Imprimatur's records (the #128 rule against a second store)" },
  { key: "humanizer", kind: "skill", repo: "blader/humanizer", label: "humanizer", why: "clears AI tells from prose: docs, posts, issue and PR text" },
];

/** @param {string} f @returns {any} */
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};

/** The repo's baseline choices, in its Imprimatur data (not the repo): {optOut: keys}. @param {string} root */
const choicesFile = (root) => require("./data-dir.js").dataPath(root, path.join(".claude", "imprimatur"), "baseline.json");

/** The keys a repo opted out of. @param {string} root @returns {string[]} */
function optedOut(root) {
  const keys = readJson(choicesFile(root))?.optOut;
  return Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [];
}

/** Opts a repo out of an item, or back in. @param {string} root @param {string} key @param {boolean} out */
function setOptOut(root, key, out) {
  const keys = new Set(optedOut(root));
  if (out) keys.add(key);
  else keys.delete(key);
  const f = choicesFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ optOut: [...keys].sort() }, null, 1));
}

/** The language servers this repo's files call for (the LSP rules of suggest-rules.js), cached ten minutes. */
const lspCache = new Map();
/** @param {string} root @param {boolean} trusted @returns {string[]} plugin ids */
function lspsFor(root, trusted) {
  const hit = lspCache.get(root);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ids;
  const rules = require("./suggest-rules.js");
  const signals = rules.repoSignals(root, "", { trusted });
  const ids = rules.RULES.filter((r) => r.plugin.endsWith("-lsp") && rules.firedBy(r.signals, signals)).map((r) => `${r.plugin}@claude-plugins-official`);
  lspCache.set(root, { at: Date.now(), ids });
  return ids;
}

/**
 * Where each plugin stands for a repo: installed at user scope or for this repo, and whether
 * it is turned off (enabledPlugins false) by the repo or, the repo saying nothing, by the user.
 * @param {string} root @param {string} home
 */
function pluginState(root, home) {
  const installed = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"))?.plugins ?? {};
  const user = readJson(path.join(home, ".claude", "settings.json"))?.enabledPlugins ?? {};
  const repo = { ...(readJson(path.join(root, ".claude", "settings.json"))?.enabledPlugins ?? {}), ...(readJson(path.join(root, ".claude", "settings.local.json"))?.enabledPlugins ?? {}) };
  const here = path.resolve(root);
  /** @param {string} id */
  return (id) => {
    const list = Array.isArray(installed[id]) ? installed[id] : [];
    const has = list.some((/** @type {any} */ e) => e?.scope === "user" || (typeof e?.projectPath === "string" && path.resolve(e.projectPath) === here));
    return { installed: has, repoOff: repo[id] === false, userOff: repo[id] === undefined && user[id] === false };
  };
}

/**
 * The baseline for a repo, item by item: ok, opted out, or what to do.
 * @param {string} root @param {{home?: string, trusted?: boolean, lsps?: string[]}} [o] lsps: for tests
 * @returns {Array<Item & {state: "ok" | "out" | "install" | "enable", target?: string}>}
 */
function baselineOf(root, { home = os.homedir(), trusted = false, lsps } = {}) {
  const out = new Set(optedOut(root));
  const plugin = pluginState(root, home);
  /** @type {any[]} */
  const rows = [];
  for (const it of BASELINE) {
    if (out.has(it.key)) {
      rows.push({ ...it, state: "out" });
      continue;
    }
    if (it.kind === "skill") {
      const name = String(it.repo).split("/")[1];
      const has = [path.join(home, ".claude", "skills", name), path.join(root, ".claude", "skills", name)].some((d) => fs.existsSync(path.join(d, "SKILL.md")));
      rows.push({ ...it, state: has ? "ok" : "install", target: name });
      continue;
    }
    const ids = it.kind === "lsp" ? lsps ?? lspsFor(root, trusted) : [String(it.id)];
    for (const id of ids) {
      const s = plugin(id);
      const label = it.kind === "lsp" ? id.split("@")[0] : it.label;
      rows.push({ ...it, label, id, target: id, state: s.repoOff ? "out" : !s.installed ? "install" : s.userOff ? "enable" : "ok" });
    }
  }
  return rows;
}

module.exports = { BASELINE, baselineOf, optedOut, setOptOut, choicesFile, pluginState };
