// The hooks' language and file extensions without command-line args (#67): a
// plugin's hooks.json has one command for every user. Each value is taken from
// the first place that has it:
//   1. IMPRIMATUR_LANG (settings-file hooks set it in their command);
//   2. the plugin's options (/config, or `claude plugin install --config`),
//      which Claude Code exports to hooks as CLAUDE_PLUGIN_OPTION_<KEY>;
//   3. <folder of the database>/config.json, {lang, exts}, which
//      `npm run setup -- --lang X [--exts md,mdx]` writes.
// A repo's .claude/imprimatur.json "lang" wins over all three for that repo (repoLang, #80).
// Extensions given as hook args (settings-file hooks) win over all three.
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_EXTS = ["md", "mdx"];

/** The user's config file, next to the database (vscode/db.js). @param {NodeJS.ProcessEnv} [env] */
function configPath(env = process.env) {
  return path.join(path.dirname(require("./db.js").dbPath(env)), "config.json");
}

/** config.json's content; {} when missing or not JSON. @param {string} [file] @returns {{lang?: string, exts?: string[]}} */
function readConfig(file = configPath()) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

/** "md, MDX .txt" or ["md"] → ["md", "mdx", "txt"]. @param {unknown} v @returns {string[] | undefined} */
function parseExts(v) {
  const list = (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/) : [])
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : undefined;
}

/** @param {unknown} v */
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * The language model-written text uses; undefined: the agent's own.
 * @param {NodeJS.ProcessEnv} [env] @param {{lang?: string}} [config]
 */
function hookLang(env = process.env, config = readConfig(configPath(env))) {
  return text(env.IMPRIMATUR_LANG) ?? text(env.CLAUDE_PLUGIN_OPTION_LANGUAGE) ?? text(config.lang);
}

/** A repo's own settings, .claude/imprimatur.json; {} without or when it is not JSON. @param {string} root @returns {{lang?: string}} */
function repoConfig(root) {
  return readConfig(path.join(root, ".claude", "imprimatur.json"));
}

/** The folder of dir that has .git (dir itself or one above), else dir. @param {string} dir */
function repoRootOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return path.resolve(dir);
  }
}

/**
 * The language model-written text uses in this repo (#80): the repo's .claude/imprimatur.json
 * "lang" first (a public repo in English while the user's own repos are in another), then hookLang.
 * @param {string | undefined} root @param {NodeJS.ProcessEnv} [env] @param {{lang?: string}} [config]
 */
function repoLang(root, env = process.env, config) {
  return ownLang(root) ?? hookLang(env, config ?? readConfig(configPath(env)));
}

/** The repo's own "lang" only, undefined without; it wins over the imprimatur.language setting too. @param {string | undefined} root */
const ownLang = (root) => (root ? text(repoConfig(root).lang) : undefined);

/**
 * The extensions whose edits are tracked: the hook's args, else the same chain as hookLang.
 * @param {string[]} [args] @param {NodeJS.ProcessEnv} [env] @param {{exts?: string[]}} [config]
 */
function hookExts(args = [], env = process.env, config = readConfig(configPath(env))) {
  return parseExts(args) ?? parseExts(env.CLAUDE_PLUGIN_OPTION_EXTENSIONS) ?? parseExts(config.exts) ?? DEFAULT_EXTS;
}

/**
 * config.json with lang and exts set (setup). Pure: a copy and whether it changed.
 * @param {any} config @param {{lang?: string, exts?: string[]}} opts
 */
function mergeConfig(config, { lang, exts }) {
  const out = { ...(config && typeof config === "object" && !Array.isArray(config) ? config : {}) };
  if (lang) out.lang = lang;
  if (exts?.length) out.exts = parseExts(exts);
  return { config: out, changed: JSON.stringify(out) !== JSON.stringify(config ?? {}) };
}

/** Imprimatur's own MCP tools, registered by hand (mcp__imprimatur__x) or by the plugin (mcp__plugin_imprimatur_imprimatur__x). */
const MCP_TOOL = /^mcp__(?:plugin_imprimatur_)?imprimatur__/;

/** The tool's short name ("task_upsert") when it is one of Imprimatur's MCP tools. @param {unknown} name */
function imprimaturTool(name) {
  const s = String(name ?? "");
  return MCP_TOOL.test(s) ? s.replace(MCP_TOOL, "") : undefined;
}

module.exports = { DEFAULT_EXTS, configPath, readConfig, repoConfig, repoRootOf, repoLang, ownLang, parseExts, hookLang, hookExts, mergeConfig, imprimaturTool, MCP_TOOL };
