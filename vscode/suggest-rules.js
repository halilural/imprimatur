// @ts-check
// Rule-based suggestions (#143): what the repo shows (its files, its manifests' dependencies, the
// commands its recent Claude sessions ran) matched against rules in the shape of Claude Code's
// marketplace `relevance` block (https://code.claude.com/docs/en/plugins/relevance.md): the
// marketplaces' own blocks, and a built-in table seeded from Anthropic's claude-code-setup
// (plugins-reference.md, "Codebase signal → plugin"). Deterministic: the same repo gives the same
// list, and each pick names what fired it. Read only.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Built-in rules, by plugin name (the official marketplace's, else the most installed of that
 * name). Signals as in `relevance.signals`; filesRead is matched against the repo's files, and
 * `code` (ours, not Claude Code's) is a manifestDeps-shaped match against source files.
 * @type {Array<{plugin: string, topic: string, signals: any}>}
 */
const RULES = [
  { plugin: "plugin-dev", topic: "building Claude Code plugins", signals: { filesRead: ["**/.claude-plugin/plugin.json", "**/.claude-plugin/marketplace.json"] } },
  { plugin: "mcp-server-dev", topic: "building an MCP server", signals: {
    manifestDeps: [{ file: "package\\.json$", pattern: '"@modelcontextprotocol/sdk"\\s*:' }, { file: "(pyproject\\.toml|requirements[^/\\\\]*\\.txt)$", pattern: "\\b(mcp|fastmcp)\\b" }],
    code: [{ file: "\\.(m?js|cjs|ts|py)$", pattern: "[\"']tools/list[\"']" }] } },
  { plugin: "pr-review-toolkit", topic: "a PR-based workflow", signals: { filesRead: ["**/.github/pull_request_template.md", "**/.github/PULL_REQUEST_TEMPLATE/**", "**/.github/CODEOWNERS"] } },
  { plugin: "frontend-design", topic: "a web UI", signals: { manifestDeps: [{ file: "package\\.json$", pattern: '"(react|vue|@angular/core|svelte|solid-js|preact)"\\s*:' }] } },
  { plugin: "typescript-lsp", topic: "TypeScript or JavaScript", signals: { filesRead: ["**/tsconfig.json", "**/jsconfig.json", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs"] } },
  { plugin: "pyright-lsp", topic: "Python", signals: { filesRead: ["**/pyproject.toml", "**/*.py"] } },
  { plugin: "gopls-lsp", topic: "Go", signals: { filesRead: ["**/go.mod"] } },
  { plugin: "rust-analyzer-lsp", topic: "Rust", signals: { filesRead: ["**/Cargo.toml"] } },
  { plugin: "clangd-lsp", topic: "C/C++", signals: { filesRead: ["**/CMakeLists.txt", "**/*.c", "**/*.cpp", "**/*.cc"] } },
  { plugin: "jdtls-lsp", topic: "Java", signals: { filesRead: ["**/pom.xml", "**/*.java"] } },
  { plugin: "kotlin-lsp", topic: "Kotlin", signals: { filesRead: ["**/*.kt", "**/*.kts"] } },
  { plugin: "swift-lsp", topic: "Swift", signals: { filesRead: ["**/Package.swift", "**/*.swift"] } },
  { plugin: "csharp-lsp", topic: "C#", signals: { filesRead: ["**/*.csproj", "**/*.cs"] } },
  { plugin: "php-lsp", topic: "PHP", signals: { filesRead: ["**/composer.json", "**/*.php"] } },
  { plugin: "lua-lsp", topic: "Lua", signals: { filesRead: ["**/*.lua"] } },
  { plugin: "security-guidance", topic: "auth and secrets", signals: { manifestDeps: [{ file: "package\\.json$", pattern: '"(jsonwebtoken|bcrypt|bcryptjs|passport|next-auth|@auth/core|jose)"\\s*:' }] } },
  { plugin: "cloudflare", topic: "Cloudflare Workers", signals: { filesRead: ["**/wrangler.toml", "**/wrangler.json", "**/wrangler.jsonc"], cli: ["wrangler"] } },
  { plugin: "vercel", topic: "Vercel", signals: { filesRead: ["**/vercel.json", "**/.vercel/**"], cli: ["vercel"] } },
  { plugin: "supabase", topic: "Supabase", signals: { filesRead: ["**/supabase/config.toml"], cli: ["supabase"], manifestDeps: [{ file: "package\\.json$", pattern: '"@supabase/supabase-js"\\s*:' }] } },
  { plugin: "firebase", topic: "Firebase", signals: { filesRead: ["**/firebase.json"], cli: ["firebase"] } },
  { plugin: "terraform", topic: "Terraform", signals: { filesRead: ["**/*.tf"], cli: ["terraform"] } },
  { plugin: "stripe", topic: "Stripe", signals: { manifestDeps: [{ file: "package\\.json$", pattern: '"stripe"\\s*:' }, { file: "(requirements[^/\\\\]*\\.txt|pyproject\\.toml)$", pattern: "\\bstripe\\b" }] } },
  { plugin: "sentry", topic: "Sentry", signals: { manifestDeps: [{ file: "package\\.json$", pattern: '"@sentry/[\\w-]+"\\s*:' }, { file: "(requirements[^/\\\\]*\\.txt|pyproject\\.toml)$", pattern: "sentry-sdk" }] } },
  { plugin: "prisma", topic: "Prisma", signals: { filesRead: ["**/schema.prisma"] } },
  { plugin: "playwright", topic: "browser tests", signals: { manifestDeps: [{ file: "package\\.json$", pattern: '"@playwright/test"\\s*:' }] } },
  { plugin: "agent-sdk-dev", topic: "the Claude Agent SDK", signals: { manifestDeps: [{ file: "package\\.json$", pattern: '"@anthropic-ai/claude-agent-sdk"\\s*:' }, { file: "(requirements[^/\\\\]*\\.txt|pyproject\\.toml)$", pattern: "claude-agent-sdk" }] } },
];

/** A glob (*, **, ?) as an anchored, case-insensitive RegExp over a forward-slash path. @param {string} g */
function globRe(g) {
  let re = "";
  const s = g.replace(/\\/g, "/");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*" && s[i + 1] === "*") {
      i++;
      if (s[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** A regex from a rule (a marketplace's is third-party data): at most 256 characters. @param {unknown} src @param {string} [flags] @returns {RegExp | undefined} */
function safeRe(src, flags = "") {
  if (typeof src !== "string" || src.length > 256) return undefined;
  try {
    return new RegExp(src, flags);
  } catch {
    return undefined;
  }
}

const vm = require("node:vm");
const MATCH = new vm.Script("String(re.exec(text)?.[0] ?? '')");
/** Time a match may take: a pattern that backtracks without end is stopped and does not match. */
const MATCH_MS = 100;

/**
 * The text a regex matches ("" for none), in a VM with a time limit: a marketplace's pattern
 * cannot hang the extension host however it is written. Undefined when it was stopped.
 * @param {RegExp} re @param {string} text @returns {string | undefined}
 */
function matchOf(re, text) {
  re.lastIndex = 0;
  try {
    return MATCH.runInNewContext({ re, text }, { timeout: MATCH_MS });
  } catch {
    return undefined;
  }
}

const SKIP = /(^|\/)(node_modules|\.git|dist|build|out|vendor|target|\.venv|venv|__pycache__)\//;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(\.kts)?|composer\.json)$/i;
const MAX_FILES = 20000;
const MAX_BYTES = 512 * 1024;

/**
 * The repo's files, relative: git's list in a trusted folder that is a repo, else a walk four
 * levels down. Git is not run in an untrusted folder: its .git/config can name commands
 * (core.fsmonitor) that git runs; even trusted, fsmonitor is turned off for this call.
 * @param {string} root @param {boolean} [trusted] @returns {string[]}
 */
function repoFiles(root, trusted = false) {
  if (trusted) try {
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((f) => f && !SKIP.test(f)).slice(0, MAX_FILES);
  } catch {}
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ dir, /** @type {number} */ depth) => {
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (files.length >= MAX_FILES || SKIP.test(`${rel}/`)) continue;
      if (e.isDirectory()) {
        if (depth < 4) walk(rel, depth + 1);
      } else files.push(rel);
    }
  };
  walk("", 0);
  return files;
}

/** A file's text when it is small enough, else "". @param {string} f */
const small = (f) => {
  try {
    return fs.statSync(f).size <= MAX_BYTES ? fs.readFileSync(f, "utf8") : "";
  } catch {
    return "";
  }
};

/**
 * The command names the repo's recent Claude sessions ran (the first word of each Bash command,
 * after env assignments and sudo), as Claude Code's `cli` signal records them, with how often.
 * @param {string} projectDir ~/.claude/projects/<slug> @param {number} [sessions] newest transcripts to read
 * @returns {Map<string, number>}
 */
function recentCommands(projectDir, sessions = 5) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {string[]} */
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(projectDir, f))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, sessions).map((x) => x.f);
  } catch {
    return seen;
  }
  for (const f of files) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/"name":"Bash","input":\{"command":"((?:[^"\\]|\\.){1,400})/g)) {
      const words = m[1].replace(/\\[nt]/g, " ").trim().split(/\s+/);
      while (words.length && (/^\w+=/.test(words[0]) || words[0] === "sudo")) words.shift();
      const cmd = path.basename(words[0] ?? "");
      if (/^[\w.-]{2,64}$/.test(cmd)) seen.set(cmd, (seen.get(cmd) ?? 0) + 1);
    }
  }
  return seen;
}

/**
 * What the repo shows, for the rules: its files, its manifests' text, the commands of its recent sessions.
 * @param {string} root @param {string} [projectDir] @param {{trusted?: boolean}} [o] trusted: the folder is trusted, so git may list it
 */
function repoSignals(root, projectDir = "", { trusted = false } = {}) {
  const files = repoFiles(root, trusted);
  const manifests = files.filter((f) => MANIFEST.test(f)).slice(0, 50).map((f) => ({ file: f, text: small(path.join(root, f)) }));
  return { root: root.replace(/\\/g, "/"), files, manifests, commands: projectDir ? recentCommands(projectDir) : new Map() };
}

/**
 * The first signal of a rule that fires, as the reason shown to the user; "" when none does.
 * @param {any} signals a relevance.signals object @param {ReturnType<typeof repoSignals>} repo
 */
function firedBy(signals, repo) {
  const s = signals && typeof signals === "object" ? signals : {};
  // A glob with many ** backtracks like a nested regex: at most 4, and a run of them counts once.
  const arr = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.slice(0, 10).filter((x) => typeof x === "string" && x.length <= 256).map((x) => x.replace(/(\*\*\/)+/g, "**/")).filter((x) => (x.match(/\*\*/g) ?? []).length <= 4) : []);
  for (const g of arr(s.cwd)) {
    // A cwd pattern matches the folder itself and everything under it, absolute or relative to the repo.
    const base = g.replace(/\/(\*\*)?$/, "");
    if (globRe(base).test(repo.root) || globRe(`${base}/**`).test(repo.root)) return `this folder matches ${g}`;
  }
  for (const g of arr(s.filesRead)) {
    const re = globRe(g);
    const hit = repo.files.find((f) => re.test(f) || re.test(`${repo.root}/${f}`));
    if (hit) return `found ${hit}`;
  }
  for (const d of Array.isArray(s.manifestDeps) ? s.manifestDeps.slice(0, 10) : []) {
    const file = safeRe(d?.file, "i"), pattern = safeRe(d?.pattern);
    if (!file || !pattern) continue;
    for (const m of repo.manifests) {
      if (!matchOf(file, m.file)) continue;
      const got = matchOf(pattern, m.text);
      if (got) return `${m.file} lists ${got.replace(/["\s:=]+$/g, "").replace(/^"/, "").slice(0, 60)}`;
    }
  }
  for (const d of Array.isArray(s.code) ? s.code.slice(0, 10) : []) {
    const file = safeRe(d?.file, "i"), pattern = safeRe(d?.pattern);
    if (!file || !pattern) continue;
    for (const f of repo.files.filter((x) => matchOf(file, x)).slice(0, 300)) {
      const got = matchOf(pattern, small(path.join(repo.root, f)));
      if (got) return `${f} serves MCP tools (${got.slice(0, 40)})`;
    }
  }
  for (const c of arr(s.cli)) {
    const n = repo.commands.get(c);
    if (n) return `recent Claude sessions here ran ${c} ${n} time${n === 1 ? "" : "s"}`;
  }
  return "";
}

/**
 * The plugins the rules pick: the marketplaces' own relevance blocks, then the built-in table.
 * Each pick once, with what fired it.
 * @param {Array<{pluginId: string, name: string, installCount?: number, relevance?: any}>} available the catalog
 * @param {ReturnType<typeof repoSignals>} repo
 * @param {Record<string, any>} [relevanceOf] relevance blocks by plugin id, from the marketplaces' local copies
 * @returns {Array<{id: string, why: string, rule: "marketplace" | "built-in", topic: string}>}
 */
function ruleMatches(available, repo, relevanceOf = {}) {
  /** @type {Map<string, {id: string, why: string, rule: "marketplace" | "built-in", topic: string}>} */
  const out = new Map();
  for (const p of available) {
    const rel = relevanceOf[p.pluginId] ?? p.relevance;
    const why = rel ? firedBy(rel.signals, repo) : "";
    if (why) out.set(p.pluginId, { id: p.pluginId, why, rule: "marketplace", topic: String(rel.topic ?? p.name).slice(0, 64) });
  }
  for (const r of RULES) {
    const same = available.filter((p) => p.name === r.plugin);
    const p = same.find((x) => x.pluginId.endsWith("@claude-plugins-official")) ?? same.sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0))[0];
    if (!p || out.has(p.pluginId)) continue;
    const why = firedBy(r.signals, repo);
    if (why) out.set(p.pluginId, { id: p.pluginId, why, rule: "built-in", topic: r.topic });
  }
  return [...out.values()];
}

/**
 * Plugins this repo's own settings turn on (`enabledPlugins` in .claude/settings.json) that are
 * not installed: the repo recommends them.
 * @param {string} root @param {string[]} installed
 */
function declaredBy(root, installed) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    return Object.entries(s?.enabledPlugins ?? {}).filter(([id, on]) => on === true && /^[\w.-]+@[\w.-]+$/.test(id) && !installed.includes(id)).map(([id]) => id);
  } catch {
    return [];
  }
}

module.exports = { RULES, globRe, safeRe, matchOf, repoFiles, recentCommands, repoSignals, firedBy, ruleMatches, declaredBy };
