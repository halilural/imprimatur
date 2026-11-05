// @ts-check
// A skill on demand (#144): when a prompt names a technology that no installed plugin, skill or
// connected MCP server covers, the UserPromptSubmit hook hands the agent the marketplace's
// candidates with their vetting, and the agent asks the user before installing. The
// technologies come from an index the extension writes from the catalog (the third-party
// integrations: Terraform, Stripe, Figma…), so the hook reads one small file and runs no command.
// The same technology is brought up at most once a week per repo; the Suggested row shows it too.
// shortcut: the official marketplace's external integrations only; other marketplaces' plugins
// are not indexed yet (their names are often not a technology's).
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** First name parts that say nothing about a technology. */
/** First name parts that say nothing about a technology, or are everyday words a prompt uses ("render the page", "save it"). */
const STOP = new Set(["code", "data", "agent", "agents", "claude", "cloud", "deploy", "learn", "math", "open", "api", "the", "skills", "plugin", "dev", "web", "app", "ai", "mcp", "auth", "ui", "test", "security",
  "box", "browser", "databases", "desktop", "knowledge", "project", "save", "session", "vibe", "render", "monday", "hunter", "neon", "exa", "amazon", "apollo", "runway", "commit", "receipts", "fakechat",
  "atomic", "circle", "modern", "migration", "build", "forge", "liquid", "lumen", "remember", "superpowers", "preset", "nimble", "zoom", "sanity", "resend", "unity", "base", "output"]);
/** Categories of the official marketplace that are products, not workflows. */
const PRODUCT = new Set(["security", "design", "database", "monitoring", "deployment", "location", "testing", "productivity", "automation", "migration"]);
const MIN_INSTALLS = 500;
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** The catalog's index, next to the database. @param {NodeJS.ProcessEnv} [env] */
const indexFile = (env = process.env) => path.join(path.dirname(require("./db.js").dbPath(env)), "catalog-index.json");

/**
 * The technologies of the catalog and their plugins (#144), for the hook: the official
 * marketplace's third-party integrations (external_plugins/, a plugin kept in its vendor's own
 * repo, or a product category; none by Anthropic, whose plugins are workflows), keyed by
 * their name's first part. Each candidate keeps its vetting (vet in suggest.js).
 * @param {Array<{pluginId: string, name: string, description?: string, installCount?: number, marketplaceName?: string}>} available
 * @param {Record<string, {source?: any, category?: string, author?: string}>} entries the official marketplace's entries by name
 * @param {(p: any) => {flags: string[], reads: string}} vet
 * @returns {Record<string, Array<{id: string, what: string, installs: number, flags: string[], reads: string}>>}
 */
function buildIndex(available, entries, vet) {
  const { whatOf } = require("./suggest.js");
  /** @type {Record<string, any[]>} */
  const index = {};
  for (const p of available) {
    const e = entries[p.name];
    if (p.marketplaceName !== "claude-plugins-official" || !e || (p.installCount ?? 0) < MIN_INSTALLS) continue;
    if (/anthropic/i.test(String(e.author ?? ""))) continue;
    const integration = typeof e.source === "object" || (typeof e.source === "string" && e.source.startsWith("./external_plugins/")) || PRODUCT.has(String(e.category));
    if (!integration) continue;
    const key = p.name.split("-")[0].toLowerCase();
    if (key.length < 3 || STOP.has(key) || !/^[a-z0-9]+$/.test(key)) continue;
    (index[key] ??= []).push({ id: p.pluginId, what: whatOf(p.description), installs: p.installCount ?? 0, ...vet(p) });
  }
  for (const k of Object.keys(index)) index[k] = index[k].sort((a, b) => b.installs - a.installs).slice(0, 3);
  return index;
}

/** The technologies a prompt names, as whole words. @param {string} prompt @param {string[]} keys */
function mentioned(prompt, keys) {
  const words = new Set(String(prompt).toLowerCase().split(/[^a-z0-9]+/));
  return keys.filter((k) => words.has(k));
}

/**
 * What already covers technologies: installed plugins' names, skills' folder names (the user's,
 * the repo's, the plugins'), MCP servers the last session had. Lowercased.
 * @param {string} root @param {string} [home]
 */
function coveredNames(root, home = os.homedir()) {
  const names = [];
  /** @param {string} dir */
  const ls = (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  let plugins = {};
  try {
    plugins = JSON.parse(fs.readFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")).plugins ?? {};
  } catch {}
  for (const [id, list] of Object.entries(plugins)) {
    names.push(id.split("@")[0]);
    for (const e of Array.isArray(list) ? list : []) if (typeof e?.installPath === "string") names.push(...ls(path.join(e.installPath, "skills")));
  }
  names.push(...ls(path.join(home, ".claude", "skills")), ...ls(path.join(root, ".claude", "skills")));
  try {
    const as = require("./agent-setup.js");
    names.push(...require("./session-context.js").connectedServers(path.join(home, ".claude", "projects", as.projectSlug(as.gitRootOf(root))), home));
  } catch {}
  return names.map((n) => String(n).toLowerCase());
}

/** The repo's on-demand state: when each technology was last brought up, and its candidates. @param {string} root */
const stateFile = (root) => require("./data-dir.js").dataPath(root, path.join(".claude", "imprimatur"), "on-demand.json");

/** @param {string} f @returns {any} */
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The hook's work (#144): the agent's context for a prompt that names an uncovered technology,
 * or "" (nothing named, all covered, brought up this week, no index).
 * @param {string} prompt @param {string} root
 * @param {{now?: number, index?: Record<string, any[]>, covered?: string[], state?: string}} [o] for tests
 */
function onDemand(prompt, root, { now = Date.now(), index, covered, state } = {}) {
  const idx = index ?? readJson(indexFile())?.index;
  if (!idx || !prompt) return "";
  const keys = mentioned(prompt, Object.keys(idx));
  if (!keys.length) return "";
  const have = covered ?? coveredNames(root);
  const file = state ?? stateFile(root);
  const st = readJson(file) ?? {};
  const fresh = keys.filter((k) => !have.some((n) => n.includes(k)) && !(typeof st[k]?.at === "number" && now - st[k].at < WEEK));
  if (!fresh.length) return "";
  for (const k of fresh) st[k] = { at: now, candidates: idx[k] };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st, null, 1));
  } catch {}
  const k = (/** @type {number} */ n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  return [`Imprimatur (#144): this prompt names ${fresh.join(", ")}, and no installed plugin, skill or MCP server covers ${fresh.length === 1 ? "it" : "them"}. Marketplace candidates:`,
    ...fresh.flatMap((t) => idx[t].map((/** @type {any} */ c) => `- ${c.id}: ${c.what} (${k(c.installs)} installs; brings ${c.reads}${c.flags.length ? `; ⚠ ${c.flags.join("; ")}` : ""})`)),
    `Only if one would clearly help with this task: tell the user which and why, with its vetting above, and install it only after they say yes (claude plugin install <id> --scope project; Claude Code records its version). Otherwise ignore this. It is also listed in Imprimatur's Agent Setup → Suggested for this repo.`].join("\n");
}

/** The technologies brought up for a repo, newest first, for the Suggested row. @param {string} root */
function recentOnDemand(root) {
  const st = readJson(stateFile(root)) ?? {};
  return Object.entries(st).map(([key, v]) => ({ key, at: Number(v?.at ?? 0), candidates: Array.isArray(v?.candidates) ? v.candidates : [] })).sort((a, b) => b.at - a.at);
}

module.exports = { buildIndex, mentioned, coveredNames, onDemand, recentOnDemand, indexFile, stateFile, WEEK };
