// @ts-check
// Suggestions for this repo (#143): plugins from Claude Code's marketplaces that fit the repo's
// stack (the best-practice review's source map, #86), ranked by how many stack parts they fit
// and how widely they are installed, with the vetting rules of #128 that apply to installing:
// hooks and MCP servers read when the marketplace has the files, and no second
// task or memory store next to Imprimatur's; the license is shown, not judged, since installing
// a plugin to use it is not redistributing it. Repo facts (stars, last push, license) come from
// GitHub through gh, cached a day. Read only: nothing is installed here.
"use strict";

/** Words in a stack part's name that say nothing about the technology. */
const STOP = new Set(["api", "rest", "the", "via", "and", "for", "cli", "sdk", "js", "node", "model", "protocol", "built", "in", "with", "based", "legacy", "modern", "visual", "studio", "code", "context"]);
/** Stack parts every plugin shares (it runs in Claude Code, over MCP): they fit nothing in particular. */
const COMMON = /^(claude|anthropic|model context protocol|mcp)\b/;
/** Names a plugin uses for a part, when they differ from the part's own. */
const ALIASES = { "visual studio code": ["vs code", "vscode"], "node.js": ["node.js", "nodejs"] };

/**
 * The words a plugin must mention to fit a stack part: the part's full name, and its first
 * word when that word names a vendor or product (Cloudflare Workers → "cloudflare workers", "cloudflare").
 * @param {Array<{name: string}>} components @returns {Array<{part: string, keys: string[]}>}
 */
function stackKeys(components) {
  return components.map((c) => {
    const name = String(c.name).toLowerCase().replace(/\(.*?\)/g, "").trim();
    if (COMMON.test(name)) return { part: c.name, keys: [] };
    const alias = /** @type {Record<string, string[]>} */ (ALIASES)[name];
    if (alias) return { part: c.name, keys: alias };
    const words = name.split(/[^a-z0-9.+#-]+/).filter((w) => w.length >= 3 && !STOP.has(w));
    return { part: c.name, keys: [...new Set([name, ...(words.length ? [words[0]] : [])])].filter((k) => k.length >= 3) };
  });
}

/** Whether text mentions a key as a whole word. @param {string} text @param {string} key */
const mentions = (text, key) => new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);

/** Descriptions that bring their own tasks or memory: a second store next to Imprimatur's (#128). */
const STORE = /\b(memory|memories|knowledge base|second brain|todo list|task manager|task tracking|session continuity)\b/i;
/** Installs below this are not "well adopted". */
const MIN_INSTALLS = 500;

/**
 * The plugins that fit, best first: installs times the stack parts they fit. Installed ones are left out.
 * @param {Array<{pluginId: string, name: string, description?: string, installCount?: number, source?: any}>} available
 * @param {Array<{name: string}>} components @param {string[]} installed plugin ids
 */
function fitting(available, components, installed) {
  const keys = stackKeys(components);
  const have = new Set(installed);
  return available
    .filter((p) => !have.has(p.pluginId) && (p.installCount ?? 0) >= MIN_INSTALLS)
    .map((p) => {
      const text = `${p.name} ${p.description ?? ""}`.toLowerCase();
      const fits = keys.filter((k) => k.keys.some((key) => mentions(text, key))).map((k) => k.part);
      return { ...p, fits };
    })
    .filter((p) => p.fits.length)
    // Well adopted first: installs times the parts it fits (a plugin that fits two parts but few use does not lead).
    .sort((a, b) => (b.installCount ?? 0) * b.fits.length - (a.installCount ?? 0) * a.fits.length);
}

/** The GitHub repo of a marketplace source ("owner/repo"), or "" (a plugin inside the marketplace). @param {any} source */
function repoOf(source) {
  const url = typeof source === "object" ? String(source?.url ?? source?.repo ?? "") : "";
  return /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? (typeof source?.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(source.repo) ? source.repo : "");
}

/**
 * What the #128 rules say about a candidate: flags, each a short reason; none means it passes.
 * @param {{description?: string}} p @param {{license?: string} | undefined} gh repo facts
 * @param {{hooks: number, mcp: string[]} | undefined} parts what it brings, when the marketplace has its files
 */
function vet(p, gh, parts) {
  // The license is shown, not flagged: installing a plugin to use it needs no right to
  // redistribute it. That rule (#128) is for what Imprimatur itself ships (the baseline, #141).
  const flags = [];
  if (STORE.test(p.description ?? "")) flags.push("brings its own memory or tasks: a second store next to Imprimatur's");
  const reads = parts ? [parts.hooks && `${parts.hooks} hook${parts.hooks === 1 ? "" : "s"}`, parts.mcp.length && `MCP server ${parts.mcp.join(", ")} (network)`].filter(Boolean).join(", ") || "no hooks or MCP servers"
    : "hooks and MCP servers: read them before installing (the files are not in the marketplace)";
  return { flags, reads };
}

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

/** A command's stdout as JSON. @param {string} cmd @param {string[]} args @returns {Promise<any>} */
const json = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 32 << 20, encoding: "utf8" }, (err, out) => {
      if (err) return reject(new Error(String(err.message).split("\n")[0].slice(0, 160)));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    }));

const DAY = 24 * 60 * 60 * 1000;
const SHOW = 8;

/** The last suggestions for a repo, or undefined. @param {string} file */
function readSuggestions(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Builds the suggestions for a stack and writes them (at most once a day, or when the stack
 * changed): the catalog from `claude plugin list --available --json`, repo facts through
 * `gh api`, what a plugin brings read from the marketplace's copy when it has one.
 * @param {{components: Array<{name: string}>, installed: string[], file: string, claude: string, home: string,
 *   now?: number, run?: (cmd: string, args: string[]) => Promise<any>, partsOf?: (p: any) => {hooks: number, mcp: string[]} | undefined}} o
 * @returns {Promise<boolean>} whether it ran
 */
async function refreshSuggestions({ components, installed, file, claude, home, now = Date.now(), run = json, partsOf }) {
  // The vetting's version is part of the key: a change to the rules refreshes at once.
  const stack = `v2|${components.map((c) => c.name).sort().join("|")}`;
  const last = readSuggestions(file);
  if (last && last.stack === stack && now - last.at < DAY) return false;
  const available = (await run(claude, ["plugin", "list", "--available", "--json"]))?.available ?? [];
  const items = [];
  for (const p of fitting(available, components, installed).slice(0, SHOW)) {
    const repo = repoOf(p.source);
    let gh;
    if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo))
      try {
        const r = await run("gh", ["api", `repos/${repo}`]);
        gh = { stars: Number(r.stargazers_count ?? 0), pushed: String(r.pushed_at ?? "").slice(0, 10), license: String(r.license?.spdx_id ?? "").replace(/^NOASSERTION$/, "") };
      } catch {}
    const parts = partsOf?.(p);
    items.push({ id: p.pluginId, name: p.name, description: String(p.description ?? "").slice(0, 300), installs: p.installCount ?? 0, fits: p.fits, repo, gh, ...vet(p, gh, parts) });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: now, stack, items }, null, 1));
  return true;
}

module.exports = { stackKeys, fitting, repoOf, vet, mentions, readSuggestions, refreshSuggestions, MIN_INSTALLS, DAY };
