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
const { sessionItems } = require("./session-context.js");

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
    // env: names only, values can be secrets.
    const env = Object.keys(s.env ?? {});
    const auto = (s.autoMode?.allow?.length ?? 0) + (s.autoMode?.environment?.length ?? 0);
    const parts = [hooks.length && `${hooks.length} hooks`, (allow || deny) && `${allow} allow / ${deny} deny`, plugins && `${plugins} plugins`,
      s.permissions?.defaultMode && `mode ${s.permissions.defaultMode}`, s.model && `model ${s.model}`, s.effortLevel && `effort ${s.effortLevel}`,
      s.outputStyle && `style ${s.outputStyle}`, s.sandbox?.enabled && "sandbox on", env.length && `${env.length} env`, auto && `${auto} auto-mode rules`].filter(Boolean);
    return { summary: parts.join(" · ") || "no hooks or permissions", details: [...hooks, ...(env.length ? [`env: ${env.join(", ")}`] : [])] };
  }
  if (isMcp) {
    try {
      const j = parseJson(abs, text);
      // .vscode/mcp.json keeps them under "servers"
      const servers = Object.entries(j.mcpServers ?? j.servers ?? {});
      const names = servers.map(([n]) => n);
      const versions = servers.map(([n, def]) => `${n}: ${mcpVersion(def)}`);
      const unpinned = versions.filter((v) => v.includes("unpinned")).length;
      return { summary: names.length ? [`${names.length} servers: ${names.slice(0, 5).join(", ")}`, unpinned && `${unpinned} unpinned`].filter(Boolean).join(" · ") : "no servers", details: versions };
    } catch {
      return { summary: "not valid JSON", details: [] };
    }
  }
  const fm = frontMatter(text);
  const lines = text.split(/\r?\n/).length;
  if (c.kind === "skill") {
    const desc = (fm.description || firstLine(text)).slice(0, 140);
    const { from, details, origin } = skillOrigin(path.dirname(abs));
    return { summary: from ? `from ${from} · ${desc}` : desc, details, ...(origin ? { origin } : {}) };
  }
  if (c.kind === "agent" || c.kind === "command")
    return { summary: (fm.description || firstLine(text)).slice(0, 140), details: [] };
  if (abs.endsWith(".mdc")) {
    const when = fm.alwaysApply === "true" ? "always" : fm.globs ? `for ${fm.globs}` : "on request";
    return { summary: `${when} · ${(fm.description || firstLine(text)).slice(0, 100)}`, details: [] };
  }
  return { summary: `${lines} lines · ${firstLine(text)}`, details: [] };
}

/** Package runners whose first non-flag argument is the package that runs. */
const RUNNERS = new Set(["npx", "bunx", "uvx", "pipx", "dlx"]);

/**
 * Which version of an MCP server runs (#139), from its definition: a remote URL, a package
 * a runner fetches (pinned "pkg@1.2.3" / "pkg==1.2", or unpinned: the newest at each start),
 * a Docker image tag, or a local file. @param {any} def an mcpServers entry
 */
function mcpVersion(def) {
  if (typeof def?.url === "string") {
    try {
      return `remote ${new URL(def.url).host}, version set by the provider`;
    } catch {
      return "remote";
    }
  }
  const words = [String(def?.command ?? ""), ...(Array.isArray(def?.args) ? def.args.map(String) : [])];
  const bin = (/** @type {string} */ w) => path.basename(w).replace(/\.(cmd|exe)$/, "");
  const at = words.findIndex((w) => RUNNERS.has(bin(w)));
  if (at >= 0) {
    // "npx -y pkg", "pnpm dlx pkg": the first non-flag word; "uvx --from pkg cmd": the --from value.
    const rest = words.slice(at + 1);
    const from = rest.indexOf("--from");
    const pkg = from >= 0 ? rest[from + 1] : rest.find((w) => !w.startsWith("-"));
    if (!pkg) return "unpinned";
    const m = /^(@?[^@=\s]+)(?:@|==)(.+)$/.exec(pkg);
    return m && m[2] !== "latest" ? `${m[1]} ${m[2]}` : `${m ? m[1] : pkg} unpinned, newest at each start`;
  }
  const d = words.indexOf("run");
  if (bin(words[0]) === "docker" && d >= 0) {
    const image = words.slice(d + 1).find((w, i, a) => !w.startsWith("-") && !(i > 0 && /^-(e|v|p|-name|-env|-volume)$/.test(a[i - 1])));
    if (image) return image.includes(":") && !image.endsWith(":latest") ? `image ${image}` : `image ${image.replace(/:latest$/, "")} unpinned`;
  }
  const file = words.find((w) => /\.(m?js|cjs|ts|py)$/.test(w));
  return file ? "local file" : words[0] ? `runs ${bin(words[0])}` : "?";
}

/**
 * Where a hand-installed skill came from (#139): its SOURCE.txt ("source: <url>", "commit: <sha>"),
 * or the folder a symlinked skill points to. @param {string} dir the skill's folder
 * @returns {{from: string, details: string[]}}
 */
function skillOrigin(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, "SOURCE.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const field = (/** @type {string} */ k) => lines.find((l) => l.toLowerCase().startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? "";
    const src = field("source").replace(/^https?:\/\//, "").replace(/\s.*$/, "");
    const commit = field("commit");
    // "https://github.com/o/r (sub/path)": the repo and the skill's folder in it, for the upstream check (#140).
    const gh = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s+\(([^)]+)\))?$/.exec(field("source"));
    // Some notes start the folder with the repo's own name ("InvestSkill/plugins/…"): drop it.
    const sub = (gh?.[2] ?? "").replace(new RegExp(`^${(gh?.[1].split("/")[1] ?? "").replace(/[.]/g, "\\.")}/`), "");
    const origin = gh && /^[0-9a-f]{7,40}$/i.test(commit) ? { key: `${gh[1]}:${sub}`, repo: gh[1], path: sub, commit } : undefined;
    return { from: [src, commit && `@${commit.slice(0, 12)}`].filter(Boolean).join(" ") || "SOURCE.txt", details: lines, origin };
  } catch {}
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) {
      const target = fs.realpathSync(dir);
      return { from: `linked from ${target.replace(os.homedir(), "~")}`, details: [] };
    }
  } catch {}
  return { from: "", details: [], origin: undefined };
}

/**
 * What a plugin brings (#139): hooks, MCP servers, skills, agents and commands, from its
 * manifest's fields or the default folders. A plugin without a manifest ("strict": false)
 * is described by its marketplace entry. @param {string} dir the plugin's install path
 * @param {any} [entry] the plugin's entry in its marketplace.json
 * @returns {string[]} e.g. ["3 hooks", "1 MCP server: context-mode", "5 skills"]
 */
function pluginContents(dir, entry = {}) {
  /** @type {any} */
  let m = {};
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")) ?? {};
  } catch {}
  m = { ...entry, ...m };
  /** @param {unknown} v @param {string} fallback a JSON file under dir, or inline object */
  const json = (v, fallback) => {
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, typeof v === "string" ? v : fallback), "utf8")) ?? {};
    } catch {
      return {};
    }
  };
  /** Names in the default folder plus the manifest's extra paths. @param {string} key @param {(e: fs.Dirent) => boolean} pick */
  const count = (key, pick) => {
    const dirs = new Set([key, ...[m[key]].flat().filter((p) => typeof p === "string").map((p) => path.normalize(p))]);
    const names = new Set();
    for (const d of dirs) {
      try {
        for (const e of fs.readdirSync(path.join(dir, d), { withFileTypes: true })) if (pick(e)) names.add(e.name);
      } catch {}
    }
    return names.size;
  };
  // "hooks" is a file, an inline object, or a list of either; a hooks file wraps the events in "hooks".
  const hooks = (Array.isArray(m.hooks) ? m.hooks : [m.hooks]).reduce((sum, v) => {
    const h = json(v, "hooks/hooks.json");
    return sum + hooksOf(h.hooks ? h : { hooks: h }).length;
  }, 0);
  const mcpJson = json(m.mcpServers, ".mcp.json");
  const mcp = Object.keys(mcpJson.mcpServers ?? mcpJson);
  const lsp = Object.keys(m.lspServers && typeof m.lspServers === "object" ? m.lspServers : json(m.lspServers, ".lsp.json"));
  const skills = count("skills", (e) => e.isDirectory() || e.isSymbolicLink());
  const agents = count("agents", (e) => e.name.endsWith(".md"));
  const commands = count("commands", (e) => e.name.endsWith(".md"));
  /** @param {number} k @param {string} what */
  const n = (k, what) => k && `${k} ${what}${k === 1 ? "" : "s"}`;
  return [n(hooks, "hook"), mcp.length && `${n(mcp.length, "MCP server")}: ${mcp.join(", ")}`, lsp.length && `${n(lsp.length, "LSP server")}: ${lsp.join(", ")}`, n(skills, "skill"), n(agents, "agent"), n(commands, "command")].filter(Boolean);
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
 * What the last upstream check found for a hand-installed skill (#140): a newer commit that
 * touches its folder adds "upstream changed" and the GitHub compare link; no change says so.
 * @param {SetupItem} it @param {any} u the check's entry for the skill's source
 */
function markUpstream(it, u) {
  if (!it.origin || !u || u.commit !== it.origin.commit) return;
  if (u.error) return void it.details.push(`upstream: not checked (${u.error})`);
  if (u.latest && u.latest !== u.installedSha && u.latestDate > u.installedDate) {
    it.summary = `upstream changed ${u.latestDate.slice(0, 10)} · ${it.summary}`;
    it.compare = `https://github.com/${it.origin.repo}/compare/${u.installedSha}...${u.latest}`;
    it.details.push(`upstream: ${u.latest.slice(0, 7)} on ${u.latestDate.slice(0, 10)}, installed ${u.installedSha.slice(0, 7)}; checked ${day(u.checkedAt)}`);
  } else it.details.push(`upstream: no change since install; checked ${day(u.checkedAt)}`);
}

/**
 * The agent setup of a folder (a repo, or the home folder with global: true).
 * @param {string} root @param {{global?: boolean, home?: string, managedDir?: string | null, upstream?: Record<string, any>}} [opts] home: where ~ and auto memory are; managedDir: the policy folder (null: none); upstream: the last upstream check (#140)
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
  if (opts.upstream) for (const it of items) if (it.origin) markUpstream(it, opts.upstream[it.origin.key]);
  items.push(...pluginItems(root, home, !!opts.global));
  if (opts.global) items.push(...syncedSkills(home), ...memoryStores(home));
  // What the repo's last Claude Code session was given (#139): read from its transcript.
  else items.push(...sessionItems(path.join(home, ".claude", "projects", projectSlug(gitRootOf(root))), home));
  return items;
}

/** A JSON file, {} when missing or invalid. @param {string} abs @returns {any} */
function readJson(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8")) ?? {};
  } catch {
    return {};
  }
}

/** A JSON file under ~/.claude, {} when missing or invalid. @param {string} home @param {string} rel @returns {any} */
const readClaudeJson = (home, rel) => readJson(path.join(home, ".claude", rel));

/** A day from an ISO time or ms, "" without. @param {unknown} t */
const day = (t) => (typeof t === "string" || typeof t === "number" ? new Date(t).toISOString().slice(0, 10) : "");

/**
 * Claude Code plugins installed for this folder (#139): user scope in the global
 * list, project and local scope in the repo they were installed for. The version
 * is the row's hash, so an update shows as "changed". A plugin also installed for
 * every repo says so: its hooks may run twice.
 * @param {string} root @param {string} home @param {boolean} global @returns {SetupItem[]}
 */
function pluginItems(root, home, global) {
  const installed = readClaudeJson(home, "plugins/installed_plugins.json").plugins ?? {};
  const markets = readClaudeJson(home, "plugins/known_marketplaces.json");
  /** @type {SetupItem[]} */
  const out = [];
  for (const [id, list] of Object.entries(installed)) {
    const all = /** @type {any[]} */ (Array.isArray(list) ? list : []);
    const mine = all.filter((e) => (global ? e.scope === "user" : e.scope !== "user" && typeof e.projectPath === "string" && path.resolve(e.projectPath) === path.resolve(root)));
    for (const e of mine) {
      const src = markets[id.split("@")[1]]?.source;
      const from = src?.repo ? `github.com/${src.repo}` : src?.url ?? src?.path ?? id.split("@")[1] ?? "?";
      const market = markets[id.split("@")[1]]?.installLocation;
      const entry = market ? (/** @type {any[]} */ (readJson(path.join(market, ".claude-plugin", "marketplace.json")).plugins ?? [])).find((p) => p?.name === id.split("@")[0]) : undefined;
      const version = String(e.version ?? "?");
      const { latest, behind } = behindOf(market, entry, e);
      const manifest = path.join(String(e.installPath ?? ""), ".claude-plugin", "plugin.json");
      out.push({
        rel: `plugin ${id} (${e.scope})`, abs: fs.existsSync(manifest) ? manifest : String(e.installPath ?? ""),
        tool: "Claude Code", kind: "installed plugin", label: id,
        summary: [/^\d/.test(version) ? `v${version}` : version.slice(0, 12), global ? "every repo" : `${e.scope} scope`, `from ${from}`,
          !global && all.some((x) => x.scope === "user") && "also installed for every repo", behind && `update available: ${latest}`].filter(Boolean).join(" · "),
        details: [...pluginContents(String(e.installPath ?? ""), entry), `source: ${from}`, e.gitCommitSha && `commit ${String(e.gitCommitSha).slice(0, 12)}`, e.installedAt && `installed ${day(e.installedAt)}`, e.lastUpdated && `updated ${day(e.lastUpdated)}`,
          markets[id.split("@")[1]]?.lastUpdated && `marketplace refreshed ${day(markets[id.split("@")[1]].lastUpdated)}`].filter(Boolean),
        hash: version,
        ...(behind ? { update: { id, scope: String(e.scope), cwd: typeof e.projectPath === "string" ? e.projectPath : "" } } : {}),
      });
    }
  }
  return out;
}

/**
 * The version a plugin's marketplace offers (#140): its entry's version, or the manifest of a
 * plugin kept in the marketplace itself. Read from the local copy of the marketplace, which
 * Claude Code refreshes; a plugin fetched from its own repo has no version here.
 * shortcut: no network check, so a plugin pinned by commit or fetched by URL shows no update;
 * upgrade with git ls-remote on a schedule when that matters.
 * @param {string | undefined} market the marketplace's folder @param {any} entry @returns {string}
 */
function latestVersion(market, entry) {
  if (!market || !entry) return "";
  if (typeof entry.version === "string") return entry.version;
  if (typeof entry.source !== "string") return "";
  const v = readJson(path.join(market, entry.source, ".claude-plugin", "plugin.json")).version;
  return typeof v === "string" ? v : "";
}

/**
 * Whether an installed plugin is behind its marketplace (#140), and what it would get: a newer
 * version number; for a plugin fetched from its own repo, the commit the marketplace now pins;
 * for one kept in the marketplace under a commit "version", files that differ from the install.
 * @param {string | undefined} market @param {any} entry @param {any} e the install record
 * @returns {{latest: string, behind: boolean}}
 */
function behindOf(market, entry, e) {
  const version = String(e.version ?? "");
  const latest = latestVersion(market, entry);
  if (latest && isNewer(latest, version)) return { latest: `v${latest}`, behind: true };
  const pin = entry?.source && typeof entry.source === "object" ? entry.source.sha : undefined;
  if (typeof pin === "string" && typeof e.gitCommitSha === "string" && pin !== e.gitCommitSha) return { latest: `commit ${pin.slice(0, 12)}`, behind: true };
  if (market && typeof entry?.source === "string" && !/^\d+(\.\d+)*$/.test(version) && e.installPath && treeHash(path.join(market, entry.source)) !== treeHash(String(e.installPath)))
    return { latest: "newer files in the marketplace", behind: true };
  return { latest: "", behind: false };
}

/** Claude Code's own markers in a plugin's cache folder (files or folders), not the plugin's files. */
const MARKERS = new Set([".in_use", ".orphaned_at"]);

/** One hash of a folder's files (names and contents), "" when missing. @param {string} dir */
function treeHash(dir) {
  const files = listFiles(dir, 8).filter((f) => !f.split("/").some((p) => MARKERS.has(p) || SKIP.has(p)));
  if (!files.length) return "";
  const h = crypto.createHash("sha1");
  for (const f of files) {
    try {
      h.update(f).update("\0").update(fs.readFileSync(path.join(dir, f))).update("\0");
    } catch {}
  }
  return h.digest("hex");
}

/** Whether version a is newer than b, both dotted numbers ("5.3.3" > "4.10.0"); anything else is not. @param {string} a @param {string} b */
function isNewer(a, b) {
  const num = (/** @type {string} */ v) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const x = num(a), y = num(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * Skills synced from claude.ai (#139): ~/.claude/skills/synced/<account>/manifest.json lists
 * them with their source and last update, which becomes the row's hash.
 * @param {string} home @returns {SetupItem[]}
 */
function syncedSkills(home) {
  const dir = path.join(home, ".claude", "skills", "synced");
  /** @type {SetupItem[]} */
  const out = [];
  for (const acct of listFiles(dir, 2).filter((f) => f.endsWith("/manifest.json"))) {
    for (const sk of /** @type {any[]} */ (readClaudeJson(home, `skills/synced/${acct}`).skills ?? [])) {
      if (typeof sk?.name !== "string") continue;
      const abs = path.join(dir, path.dirname(acct), sk.name, "SKILL.md");
      out.push({
        rel: `~/.claude/skills/synced/${sk.name}`, abs, tool: "Claude Code", kind: "synced skill", label: sk.name,
        summary: [sk.source, sk.updatedAt && `updated ${day(sk.updatedAt)}`, String(sk.description ?? "").slice(0, 100)].filter(Boolean).join(" · "),
        details: [], hash: String(sk.updatedAt ?? ""),
      });
    }
  }
  return out;
}

/** Folders other memory systems keep on this machine. */
const MEMORY_STORES = [".mem0", ".claude-mem", ".claude/context-mode", ".supermemory", ".letta"];

/**
 * Other memory systems' local stores (#139, PDR 9345): listed as data sources with their last
 * change, never read, because what they hold reaches the agent unvetted. @param {string} home
 * @returns {SetupItem[]}
 */
function memoryStores(home) {
  return MEMORY_STORES.flatMap((rel) => {
    let st;
    try {
      st = fs.statSync(path.join(home, rel));
    } catch {
      return [];
    }
    if (!st.isDirectory()) return [];
    // The newest change one level down: a folder's own time moves only when entries come and go.
    let ms = st.mtimeMs;
    try {
      for (const n of fs.readdirSync(path.join(home, rel))) ms = Math.max(ms, fs.statSync(path.join(home, rel, n)).mtimeMs);
    } catch {}
    const changed = day(ms);
    return [{ rel: `~/${rel}`, abs: "", tool: "Claude Code", kind: "data sources", label: `~/${rel}`,
      summary: `memory store on this machine · changed ${changed} · not read by Imprimatur`, details: [], hash: changed }];
  });
}

/**
 * @typedef {{rel: string, abs: string, tool: string, kind: string, label: string, summary: string, details: string[], hash: string,
 *   parent?: string, children?: SetupItem[], update?: {id: string, scope: string, cwd: string},
 *   origin?: {key: string, repo: string, path: string, commit: string}, compare?: string}} SetupItem
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

module.exports = { isNewer, mcpVersion, classify, findAgentFiles, scanSetup, changesSince, snapshotOf, hooksOf, summarize, importsOf, gitRootOf, projectSlug, autoMemoryDir, managedDir, flatItems, parseJson, allowsComments, stripJsonc };
