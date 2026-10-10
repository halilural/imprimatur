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
const os = require("node:os");

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
  if (rel === ".cursor/hooks.json") return { tool: "Cursor", kind: "hooks" };
  if (r(/^\.cursor\/commands\/.+\.md$/)) return { tool: "Cursor", kind: "command" };
  if (rel === ".cursorrules") return { tool: "Cursor", kind: "rules" };
  if (rel === ".cursor/mcp.json") return { tool: "Cursor", kind: "MCP servers" };
  // What the agent may not see: ignore files count as setup too.
  if (base === ".cursorignore" || base === ".cursorindexingignore") return { tool: "Cursor", kind: "ignore" };
  if (rel === ".github/copilot-instructions.md") return { tool: "GitHub Copilot", kind: "rules" };
  if (r(/^\.github\/instructions\/.+\.md$/)) return { tool: "GitHub Copilot", kind: "rules" };
  if (r(/^\.github\/prompts\/.+\.md$/)) return { tool: "GitHub Copilot", kind: "prompt" };
  if (r(/^\.github\/chatmodes\/.+\.md$/)) return { tool: "GitHub Copilot", kind: "chat mode" };
  // Custom agents: NAME.agent.md (the docs' pattern; a plain .md is read too)
  if (r(/^\.github\/agents\/.+\.md$/)) return { tool: "GitHub Copilot", kind: "agent" };
  if (rel === ".vscode/mcp.json") return { tool: "GitHub Copilot", kind: "MCP servers" };
  // Codex reads AGENTS.override.md in place of AGENTS.md in the same folder.
  if (base === "AGENTS.md" || base === "AGENTS.override.md") return { tool: "Codex / AGENTS.md", kind: "rules" };
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
    ".cursor/mcp.json", ".cursor/hooks.json", ".codex/AGENTS.md", ".codex/AGENTS.override.md", ".codex/config.toml", ".gemini/GEMINI.md", ".gemini/settings.json",
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
    ...under(".cursor/commands", (e) => (e.isFile() && e.name.endsWith(".md") ? [e.name] : [])),
    // Personal rules apply to every project; subfolders count too.
    ...listFiles(path.join(home, ".claude/rules"), 3).filter((p) => p.endsWith(".md")).map((p) => `.claude/rules/${p}`),
  ].sort();
}

/** Global files' tool and kind: their path under home, read like a repo's. @param {string} rel */
function classifyGlobal(rel) {
  if (rel === ".claude/CLAUDE.md") return { tool: "Claude Code", kind: "rules" };
  if (rel === ".claude.json") return { tool: "Claude Code", kind: "MCP servers" };
  if (rel === ".codex/AGENTS.md" || rel === ".codex/AGENTS.override.md") return { tool: "Codex / AGENTS.md", kind: "rules" };
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

/** A hook command's script name, or its first two words. @param {string} cmd */
const scriptName = (cmd) => /([\w.-]+\.(?:sh|mjs|js|cjs|py|ts))\b/.exec(cmd)?.[1] ?? cmd.split(/\s+/).slice(0, 2).join(" ");

/**
 * Whether the tool reading this JSON file allows comments and trailing
 * commas: VS Code's own .vscode files and Gemini CLI's settings do; Claude
 * Code settings are strict JSON (its docs), and Cursor's are left strict
 * except mcp.json, which Cursor reads like VS Code.
 * @param {string} abs
 */
function allowsComments(abs) {
  const p = abs.split(path.sep).join("/");
  return /\/\.vscode\/[^/]+\.json$/.test(p) || /\/\.gemini\/settings\.json$/.test(p) || /\/\.cursor\/mcp\.json$/.test(p);
}

/** JSONC to JSON: drops // and /* *\/ comments and trailing commas, leaves strings alone. @param {string} text */
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** A JSON file's value, JSONC where its tool allows it; throws when invalid. @param {string} abs @param {string} text */
const parseJson = (abs, text) => JSON.parse(allowsComments(abs) ? stripJsonc(text) : text);

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
        out.push(`${event}${e.matcher ? ` [${e.matcher}]` : ""} → ${scriptName(cmd)}`);
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
  const isMcp = c.kind === "MCP servers" || abs.endsWith("managed-mcp.json");
  if (c.kind === "hooks") {
    try {
      const hooks = Object.entries(parseJson(abs, text).hooks ?? {}).flatMap(([event, list]) =>
        (Array.isArray(list) ? list : []).map((h) => `${event} → ${scriptName(String(h?.command ?? ""))}`));
      return { summary: hooks.length ? `${hooks.length} hooks` : "no hooks", details: hooks };
    } catch {
      return { summary: "not valid JSON", details: [] };
    }
  }
  if ((c.kind === "settings" || c.kind === "managed policy") && abs.endsWith(".json") && !isMcp) {
    let s;
    try {
      s = parseJson(abs, text);
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
  if (isMcp) {
    try {
      const j = parseJson(abs, text);
      // .vscode/mcp.json keeps them under "servers"
      const names = Object.keys(j.mcpServers ?? j.servers ?? {});
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
  if (["agent", "command", "hook script", "output style", "prompt", "chat mode", "git hook", "memory"].includes(kind)) return parts[parts.length - 1].replace(/(\.agent)?\.(md|mdc)$/, "");
  if (kind === "managed policy") return `managed ${parts[parts.length - 1]}`;
  if (kind === "rules" && /^\.(cursor|windsurf|github)\//.test(rel) && parts.length > 2) return parts[parts.length - 1].replace(/\.(md|mdc)$/, "");
  return rel;
}

/**
 * The agent setup of a folder (a repo, or the home folder with global: true).
 * @param {string} root @param {{global?: boolean, home?: string, managedDir?: string | null}} [opts] home: where ~ and auto memory are; managedDir: the policy folder (null: none)
 * @returns {SetupItem[]} with import rows under children
 */
function scanSetup(root, opts = {}) {
  const home = opts.home ?? os.homedir();
  const files = opts.global ? findGlobalFiles(root) : findAgentFiles(root);
  /** @param {string} abs @param {string} rel @param {{tool: string, kind: string}} c @param {string} [label] @returns {SetupItem} */
  const item = (abs, rel, c, label) => ({ rel, abs, ...c, label: label ?? labelOf(rel, c.kind), ...summarize(abs, c), hash: hashOf(abs) });
  /** @type {SetupItem[]} */
  const items = files.map((rel) => item(path.join(root, rel), rel, opts.global ? classifyGlobal(rel) : /** @type {{tool: string, kind: string}} */ (classify(rel))));
  // Outside the folder: the repo's auto memory, or the machine's managed policy.
  /** @param {string} abs */
  const display = (abs) => (isUnder(abs, root) ? path.relative(root, abs).split(path.sep).join("/") : isUnder(abs, home) ? `~/${path.relative(home, abs).split(path.sep).join("/")}` : abs);
  if (!opts.global) {
    const dir = autoMemoryDir(root, home);
    for (const p of listFiles(dir, 2).filter((f) => f.endsWith(".md")))
      items.push(item(path.join(dir, p), display(path.join(dir, p)), { tool: "Claude Code", kind: "memory" }));
  } else {
    const dir = opts.managedDir === undefined ? managedDir() : opts.managedDir;
    const names = dir ? ["CLAUDE.md", "managed-settings.json", "managed-mcp.json", ...listFiles(path.join(dir, "managed-settings.d"), 1).filter((f) => f.endsWith(".json")).map((f) => `managed-settings.d/${f}`)] : [];
    for (const n of names)
      if (dir && fs.existsSync(path.join(dir, n))) items.push(item(path.join(dir, n), path.join(dir, n), { tool: "Claude Code", kind: "managed policy" }));
  }
  // @imports of Claude's instruction files: child rows of the file that imports them.
  /** @param {SetupItem} it @param {number} hop @param {Set<string>} chain */
  const addImports = (it, hop, chain) => {
    const kids = [];
    for (const imp of importsOf(it.abs, home)) {
      if (!imp.exists || chain.has(imp.abs) || hop > IMPORT_HOPS) continue;
      const child = item(imp.abs, display(imp.abs), { tool: "Claude Code", kind: "import" }, `@${imp.written}`);
      child.parent = it.rel;
      addImports(child, hop + 1, new Set([...chain, imp.abs]));
      kids.push(child);
    }
    if (kids.length) it.children = kids;
  };
  for (const it of items) if (readsImports(it)) addImports(it, 1, new Set([it.abs]));
  return items;
}

/**
 * @typedef {{rel: string, abs: string, tool: string, kind: string, label: string, summary: string, details: string[], hash: string,
 *   parent?: string, children?: SetupItem[]}} SetupItem
 */

/** Imported files load recursively up to four hops (Claude Code memory docs). */
const IMPORT_HOPS = 4;

/** Whether Claude Code expands @imports in this file: CLAUDE.md, CLAUDE.local.md, rules, AGENTS.md, managed CLAUDE.md. @param {{abs: string, kind: string, tool: string}} it */
function readsImports(it) {
  const base = path.basename(it.abs);
  if (["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].includes(base)) return true;
  return it.tool === "Claude Code" && it.kind === "rules" && base.endsWith(".md");
}

/** @param {string} p @param {string} dir */
const isUnder = (p, dir) => {
  const r = path.relative(dir, p);
  return !!r && !r.startsWith("..") && !path.isAbsolute(r);
};

/** Files under a folder (relative, "/" separated), down to a depth; none when it is missing. @param {string} dir @param {number} depth @returns {string[]} */
function listFiles(dir, depth) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d @param {string} prefix @param {number} level */
  const walk = (d, prefix, level) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      let dirLike = e.isDirectory();
      if (e.isSymbolicLink()) dirLike = fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false;
      if (dirLike) {
        if (level < depth) walk(abs, `${prefix}${e.name}/`, level + 1);
      } else out.push(`${prefix}${e.name}`);
    }
  };
  walk(dir, "", 1);
  return out.sort();
}

/**
 * @path imports in an instruction file: what was written, where it resolves
 * (relative to the importing file, ~ is home), and whether it exists. Code
 * spans and fenced blocks are skipped, "\ " is a space (Claude Code memory
 * docs). An @ counts only at a line start or after whitespace, so emails do not.
 * @param {string} abs @param {string} [home] @param {string} [text]
 * @returns {Array<{written: string, abs: string, exists: boolean, line: number}>}
 */
function importsOf(abs, home = os.homedir(), text) {
  if (text === undefined) {
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return [];
    }
  }
  const out = [];
  let fence = "";
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const fm = /^\s*(```|~~~)/.exec(lines[n]);
    if (fm) {
      if (!fence) fence = fm[1];
      else if (fm[1] === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const line = lines[n].replace(/(`+)[\s\S]*?\1/g, (m) => " ".repeat(m.length));
    for (const m of line.matchAll(/(?:^|\s)@((?:\\ |[^\s`])+)/g)) {
      const written = m[1].replace(/\\ /g, " ").replace(/[.,;:!?)\]}'"]+$/, "");
      if (!written || written.includes("@")) continue;
      const expanded = written === "~" || written.startsWith("~/") ? path.join(home, written.slice(1)) : written;
      const target = path.resolve(path.dirname(abs), expanded);
      out.push({ written, abs: target, exists: fs.statSync(target, { throwIfNoEntry: false })?.isFile() ?? false, line: n + 1 });
    }
  }
  return out;
}

/**
 * The git repo a folder is in (a worktree counts as its main repo), or the
 * folder itself outside git: what Claude Code keys auto memory by.
 * @param {string} dir
 */
function gitRootOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const git = path.join(d, ".git");
    const st = fs.statSync(git, { throwIfNoEntry: false });
    if (st?.isDirectory()) return d;
    if (st?.isFile()) {
      const to = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf8"))?.[1]?.trim();
      const main = to && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(d, to));
      return main ? main[1] : d;
    }
    if (path.dirname(d) === d) return path.resolve(dir);
  }
}

/** Claude Code's project folder name for a path: every character but letters and digits becomes "-". @param {string} p */
const projectSlug = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The repo's auto memory folder: autoMemoryDirectory from the settings
 * (local, project, user), else ~/.claude/projects/<slug>/memory/.
 * @param {string} root @param {string} home
 */
function autoMemoryDir(root, home) {
  for (const f of [path.join(root, ".claude/settings.local.json"), path.join(root, ".claude/settings.json"), path.join(home, ".claude/settings.json")]) {
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8")).autoMemoryDirectory;
      if (typeof d === "string" && d) return d.startsWith("~") ? path.join(home, d.slice(1)) : path.resolve(root, d);
    } catch {
      // missing or invalid: the next one
    }
  }
  return path.join(home, ".claude/projects", projectSlug(gitRootOf(root)), "memory");
}

/** The machine's managed policy folder (Claude Code managed settings docs). @param {string} [platform] */
function managedDir(platform = process.platform) {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/** Items with their import rows, depth first. @param {SetupItem[]} items @returns {SetupItem[]} */
const flatItems = (items) => items.flatMap((i) => [i, ...flatItems(i.children ?? [])]);

/**
 * What changed since the user last saw the setup: per file "new" | "changed",
 * and the files gone. No snapshot yet: nothing is new (the first look sets it).
 * @param {Array<{rel: string, hash: string}>} items @param {Record<string, string> | undefined} seen rel -> hash
 */
function changesSince(items, seen) {
  /** @type {Record<string, "new" | "changed">} */
  const state = {};
  if (!seen) return { state, removed: [] };
  for (const it of flatItems(items)) {
    if (!(it.rel in seen)) state[it.rel] = "new";
    else if (seen[it.rel] !== it.hash) state[it.rel] = "changed";
  }
  const now = new Set(flatItems(items).map((i) => i.rel));
  return { state, removed: Object.keys(seen).filter((r) => !now.has(r)) };
}

/** A snapshot to remember as seen. @param {Array<{rel: string, hash: string}>} items */
const snapshotOf = (items) => Object.fromEntries(flatItems(items).map((i) => [i.rel, i.hash]));

module.exports = { classify, findAgentFiles, scanSetup, changesSince, snapshotOf, hooksOf, summarize, importsOf, gitRootOf, projectSlug, autoMemoryDir, managedDir, flatItems, parseJson, allowsComments, stripJsonc };
