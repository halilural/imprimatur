// @ts-check
// Agent setup: everything in a repo (and in the home folder) that shapes what
// a coding agent does, whatever the tool: Claude Code, Cursor, Copilot, Codex /
// AGENTS.md, Gemini, Windsurf, Cline, Aider, and the git hooks the agent's
// commits run through. Found by walking the folders, summed up from the file
// itself (no model), and compared with what the user last saw.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** Folders never walked. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "vendor", "target", ".venv", "venv", "__pycache__", ".terraform"]);
const MAX_DEPTH = 6;

/**
 * Which tool and kind a path (relative, "/" separated) is, or undefined.
 * Instruction files (CLAUDE.md, AGENTS.md, …) count in any folder; the rest
 * only where the tool reads them.
 * @param {string} rel @returns {{tool: string, kind: string} | undefined}
 */
function classify(rel) {
  const base = rel.split("/").pop() ?? "";
  const r = (re) => re.test(rel);
  if (base === "CLAUDE.md" || base === "CLAUDE.local.md") return { tool: "Claude Code", kind: "rules" };
  if (r(/^\.claude\/settings(\.local)?\.json$/)) return { tool: "Claude Code", kind: "settings" };
  if (r(/^\.claude\/hooks\/[^/]+$/)) return { tool: "Claude Code", kind: "hook script" };
  if (r(/^\.claude\/skills\/[^/]+\/SKILL\.md$/)) return { tool: "Claude Code", kind: "skill" };
  if (r(/^\.claude\/commands\/.+\.md$/)) return { tool: "Claude Code", kind: "command" };
  if (r(/^\.claude\/agents\/.+\.md$/)) return { tool: "Claude Code", kind: "agent" };
  if (r(/^\.claude\/rules\/.+\.md$/)) return { tool: "Claude Code", kind: "rules" };
  if (r(/^\.claude\/output-styles\/.+\.md$/)) return { tool: "Claude Code", kind: "output style" };
  if (r(/^\.claude-plugin\/(plugin|marketplace)\.json$/)) return { tool: "Claude Code", kind: "plugin" };
  if (rel === ".mcp.json") return { tool: "Claude Code", kind: "MCP servers" };
  if (r(/^\.cursor\/rules\/.+\.mdc?$/)) return { tool: "Cursor", kind: "rules" };
  if (rel === ".cursorrules") return { tool: "Cursor", kind: "rules" };
  if (rel === ".cursor/mcp.json") return { tool: "Cursor", kind: "MCP servers" };
  // What the agent may not see: ignore files count as setup too.
  if (base === ".cursorignore" || base === ".cursorindexingignore") return { tool: "Cursor", kind: "ignore" };
  if (rel === ".github/copilot-instructions.md") return { tool: "GitHub Copilot", kind: "rules" };
  if (r(/^\.github\/instructions\/.+\.md$/)) return { tool: "GitHub Copilot", kind: "rules" };
  if (r(/^\.github\/prompts\/.+\.md$/)) return { tool: "GitHub Copilot", kind: "prompt" };
  if (r(/^\.github\/chatmodes\/.+\.md$/)) return { tool: "GitHub Copilot", kind: "chat mode" };
  if (base === "AGENTS.md") return { tool: "Codex / AGENTS.md", kind: "rules" };
  if (rel === ".codex/config.toml") return { tool: "Codex / AGENTS.md", kind: "settings" };
  if (base === "GEMINI.md") return { tool: "Gemini", kind: "rules" };
  if (rel === ".gemini/settings.json") return { tool: "Gemini", kind: "settings" };
  if (rel === ".windsurfrules" || r(/^\.windsurf\/rules\/.+/)) return { tool: "Windsurf", kind: "rules" };
  if (rel === ".clinerules" || r(/^\.clinerules\/.+/)) return { tool: "Cline", kind: "rules" };
  if (r(/^\.aider\.conf\.ya?ml$/)) return { tool: "Aider", kind: "settings" };
  if (base === ".aiderignore") return { tool: "Aider", kind: "ignore" };
  if (r(/^\.husky\/[^/_][^/]*$/)) return { tool: "Git hooks", kind: "git hook" };
  if (r(/^(commitlint\.config\.[cm]?[jt]s|\.commitlintrc(\.\w+)?)$/)) return { tool: "Git hooks", kind: "commit rules" };
  if (rel === ".pre-commit-config.yaml" || r(/^lefthook\.ya?ml$/)) return { tool: "Git hooks", kind: "git hook" };
  return undefined;
}

/**
 * Agent files under a folder: relative paths, sorted.
 * @param {string} root @returns {string[]}
 */
function findAgentFiles(root) {
  const out = [];
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        // .claude/imprimatur holds Imprimatur's own data (copies of reviewed files), not setup
        if (!SKIP.has(e.name) && rel !== ".claude/imprimatur" && depth < MAX_DEPTH) walk(abs, depth + 1);
      } else if (e.isFile() && classify(rel)) out.push(rel);
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * The home folder's agent files (they apply to every repo): only the tools'
 * own folders, not a walk of the whole home.
 * @param {string} home @returns {string[]} paths relative to home
 */
function findGlobalFiles(home) {
  const candidates = [
    ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json", ".claude.json",
    ".cursor/mcp.json", ".codex/AGENTS.md", ".codex/config.toml", ".gemini/GEMINI.md", ".gemini/settings.json",
  ].filter((p) => fs.existsSync(path.join(home, p)));
  const under = (dir, pick) => {
    const abs = path.join(home, dir);
    if (!fs.existsSync(abs)) return [];
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .flatMap((e) => pick(e))
      .map((p) => `${dir}/${p}`)
      .filter((p) => fs.existsSync(path.join(home, p)));
  };
  return [
    ...candidates,
    ...under(".claude/hooks", (e) => (e.isFile() ? [e.name] : [])),
    ...under(".claude/skills", (e) => (e.isDirectory() || e.isSymbolicLink() ? [`${e.name}/SKILL.md`] : [])),
    ...under(".claude/commands", (e) => (e.isFile() && e.name.endsWith(".md") ? [e.name] : [])),
    ...under(".claude/agents", (e) => (e.isFile() && e.name.endsWith(".md") ? [e.name] : [])),
    ...under(".cursor/rules", (e) => (e.isFile() ? [e.name] : [])),
  ].sort();
}

/** Global files' tool and kind: their path under home, read like a repo's. @param {string} rel */
function classifyGlobal(rel) {
  if (rel === ".claude/CLAUDE.md") return { tool: "Claude Code", kind: "rules" };
  if (rel === ".claude.json") return { tool: "Claude Code", kind: "MCP servers" };
  if (rel === ".codex/AGENTS.md") return { tool: "Codex / AGENTS.md", kind: "rules" };
  if (rel === ".gemini/GEMINI.md") return { tool: "Gemini", kind: "rules" };
  return classify(rel) ?? { tool: "Other", kind: "file" };
}

/**
 * YAML front matter fields (name, description, globs, alwaysApply). A block
 * value ("description: |" or ">") takes its indented lines, joined.
 * @param {string} text
 */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  /** @type {Record<string, string>} */
  const out = {};
  if (!m) return out;
  /** @type {string | undefined} */
  let block;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      block = /^[|>][-+]?$/.test(kv[2]) ? kv[1] : undefined;
      out[kv[1]] = block ? "" : kv[2].replace(/^["']|["']$/g, "");
    } else if (block && /^\s+\S/.test(line)) out[block] = `${out[block]} ${line.trim()}`.trim();
  }
  return out;
}

/** First meaningful line of a text file: a heading or sentence, or a script's first comment. @param {string} text */
function firstLine(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  for (const raw of body.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#!") || /^(set -|"use strict"|\/\/ @ts-check|import |const |\{|\[)/.test(l)) continue;
    return l.replace(/^(#+|\/\/+|\*+|-+|>)\s*/, "").slice(0, 120);
  }
  return "";
}

/**
 * Hooks in a Claude settings file, one per line: "Event [matcher] → script".
 * @param {any} settings @returns {string[]}
 */
function hooksOf(settings) {
  const out = [];
  for (const [event, entries] of Object.entries(settings?.hooks ?? {}))
    for (const e of /** @type {any[]} */ (entries ?? []))
      for (const h of e.hooks ?? []) {
        const cmd = String(h.command ?? h.url ?? h.prompt ?? "");
        const script = /([\w.-]+\.(?:sh|mjs|js|cjs|py|ts))\b/.exec(cmd)?.[1] ?? cmd.split(/\s+/).slice(0, 2).join(" ");
        out.push(`${event}${e.matcher ? ` [${e.matcher}]` : ""} → ${script}`);
      }
  return out;
}

/**
 * One file's summary for the list, and its details (hooks of a settings file).
 * @param {string} abs @param {{kind: string}} c
 * @returns {{summary: string, details: string[]}}
 */
function summarize(abs, c) {
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { summary: "unreadable", details: [] };
  }
  if (c.kind === "settings" && abs.endsWith(".json")) {
    let s;
    try {
      s = JSON.parse(text);
    } catch {
      return { summary: "not valid JSON", details: [] };
    }
    const hooks = hooksOf(s);
    const allow = s.permissions?.allow?.length ?? 0;
    const deny = s.permissions?.deny?.length ?? 0;
    const plugins = Object.entries(s.enabledPlugins ?? {}).filter(([, on]) => on).length;
    const parts = [hooks.length && `${hooks.length} hooks`, (allow || deny) && `${allow} allow / ${deny} deny`, plugins && `${plugins} plugins`, s.model && `model ${s.model}`].filter(Boolean);
    return { summary: parts.join(" · ") || "no hooks or permissions", details: hooks };
  }
  if (c.kind === "MCP servers") {
    try {
      const names = Object.keys(JSON.parse(text).mcpServers ?? {});
      return { summary: names.length ? `${names.length} servers: ${names.slice(0, 5).join(", ")}` : "no servers", details: names };
    } catch {
      return { summary: "not valid JSON", details: [] };
    }
  }
  const fm = frontMatter(text);
  const lines = text.split(/\r?\n/).length;
  if (c.kind === "skill" || c.kind === "agent" || c.kind === "command")
    return { summary: (fm.description || firstLine(text)).slice(0, 140), details: [] };
  if (abs.endsWith(".mdc")) {
    const when = fm.alwaysApply === "true" ? "always" : fm.globs ? `for ${fm.globs}` : "on request";
    return { summary: `${when} · ${(fm.description || firstLine(text)).slice(0, 100)}`, details: [] };
  }
  return { summary: `${lines} lines · ${firstLine(text)}`, details: [] };
}

/**
 * Content hash, for "changed since you looked". ~/.claude.json is Claude
 * Code's own state too (usage, project history): only its MCP servers count.
 * @param {string} abs
 */
function hashOf(abs) {
  try {
    let data = fs.readFileSync(abs);
    if (path.basename(abs) === ".claude.json") data = Buffer.from(JSON.stringify(JSON.parse(data.toString("utf8")).mcpServers ?? {}));
    return crypto.createHash("sha1").update(data).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

/**
 * A short name for the list: a skill's folder, an agent's or command's file
 * name, a script's name; the path otherwise. @param {string} rel @param {string} kind
 */
function labelOf(rel, kind) {
  const parts = rel.split("/");
  if (kind === "skill") return parts[parts.length - 2];
  if (["agent", "command", "hook script", "output style", "prompt", "chat mode", "git hook"].includes(kind)) return parts[parts.length - 1].replace(/\.(md|mdc)$/, "");
  if (kind === "rules" && /^\.(cursor|windsurf|github)\//.test(rel) && parts.length > 2) return parts[parts.length - 1].replace(/\.(md|mdc)$/, "");
  return rel;
}

/**
 * The agent setup of a folder (a repo, or the home folder with global: true).
 * @param {string} root @param {{global?: boolean}} [opts]
 * @returns {Array<{rel: string, abs: string, tool: string, kind: string, label: string, summary: string, details: string[], hash: string}>}
 */
function scanSetup(root, opts = {}) {
  const files = opts.global ? findGlobalFiles(root) : findAgentFiles(root);
  return files.map((rel) => {
    const abs = path.join(root, rel);
    const c = opts.global ? classifyGlobal(rel) : /** @type {{tool: string, kind: string}} */ (classify(rel));
    return { rel, abs, ...c, label: labelOf(rel, c.kind), ...summarize(abs, c), hash: hashOf(abs) };
  });
}

/**
 * What changed since the user last saw the setup: per file "new" | "changed",
 * and the files gone. No snapshot yet: nothing is new (the first look sets it).
 * @param {Array<{rel: string, hash: string}>} items @param {Record<string, string> | undefined} seen rel -> hash
 */
function changesSince(items, seen) {
  /** @type {Record<string, "new" | "changed">} */
  const state = {};
  if (!seen) return { state, removed: [] };
  for (const it of items) {
    if (!(it.rel in seen)) state[it.rel] = "new";
    else if (seen[it.rel] !== it.hash) state[it.rel] = "changed";
  }
  const now = new Set(items.map((i) => i.rel));
  return { state, removed: Object.keys(seen).filter((r) => !now.has(r)) };
}

/** A snapshot to remember as seen. @param {Array<{rel: string, hash: string}>} items */
const snapshotOf = (items) => Object.fromEntries(items.map((i) => [i.rel, i.hash]));

module.exports = { classify, findAgentFiles, scanSetup, changesSince, snapshotOf, hooksOf, summarize };
