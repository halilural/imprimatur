#!/usr/bin/env node
// Sets Imprimatur up on this machine, for every repo:
// - the Claude Code hooks in ~/.claude/settings.json (a backup first; ours are
//   found by their script name, added when missing, updated when the path or
//   language differs; other hooks are left alone);
// - the Imprimatur MCP server (mcp/server.mjs) for Claude Code (user scope, via
//   `claude mcp`), Cursor (~/.cursor/mcp.json) and Codex (~/.codex/config.toml)
//   when those are installed;
// - the VS Code extension (npm run package + code --install-extension);
// - with --lang, imprimatur.language (the extension's model calls use the
//   hooks' language), and with --show-in, where Markdown changes show (preview | editor | both), in
//   VS Code's machine settings (~/.vscode-server/data/Machine/settings.json on
//   a remote/WSL machine, else the user settings);
// - checks that the `claude` CLI is on PATH (the model features use it).
//
//   npm run setup -- [--lang Turkish] [--show-in both] [--exts md,mdx] [--no-extension] [--dry-run]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ASK = "AskUserQuestion";

/**
 * The hooks Imprimatur needs: [event, matcher, script, args].
 * @param {string[]} exts @returns {Array<[string, string | undefined, string, string]>}
 */
const wanted = (exts) => [
  ["PreToolUse", "Edit|Write|Bash", "baseline.mjs", ` ${exts.join(" ")}`],
  ["PostToolUse", "Bash", "baseline.mjs", ` ${exts.join(" ")}`],
  ["PostToolUseFailure", "Bash", "baseline.mjs", ` ${exts.join(" ")}`],
  ["PreToolUse", ASK, "waiting.mjs", ""],
  ["PostToolUse", ASK, "waiting.mjs", ""],
  ["PermissionRequest", "*", "waiting.mjs", ""],
  ["Notification", "agent_needs_input|elicitation_dialog|elicitation_url_dialog", "waiting.mjs", ""],
  ["Stop", undefined, "waiting.mjs", ""],
  ["UserPromptSubmit", undefined, "waiting.mjs", ""],
  ["PreToolUse", "mcp__imprimatur__.*", "mcp-session.mjs", ""],
  // Process checks (#56): they act only in repos with .claude/imprimatur.json.
  ["SessionStart", undefined, "process.mjs", ""],
  ["PreToolUse", "Bash|Edit|Write|MultiEdit|NotebookEdit", "process.mjs", ""],
  ["PostToolUse", "Edit|Write|MultiEdit|Bash|mcp__imprimatur__task_upsert", "process.mjs", ""],
  ["Stop", undefined, "process.mjs", ""],
];

const MCP_NAME = "imprimatur";
/** How every client starts the MCP server. @param {string} root */
const mcpCommand = (root) => ({ command: "node", args: [path.join(root, "mcp", "server.mjs")] });

/**
 * Cursor's ~/.cursor/mcp.json with our server. Pure: returns a copy and the change.
 * @param {any} config @param {{root: string}} opts
 */
export function mergeCursor(config, { root }) {
  const out = structuredClone(config ?? {});
  out.mcpServers ??= {};
  const want = { type: "stdio", ...mcpCommand(root) };
  const have = out.mcpServers[MCP_NAME];
  if (have && have.command === want.command && JSON.stringify(have.args) === JSON.stringify(want.args)) {
    return { config: out, change: undefined };
  }
  out.mcpServers[MCP_NAME] = { ...have, ...want };
  return { config: out, change: `${have ? "updated" : "added  "} mcpServers.${MCP_NAME}` };
}

/** The table header's dotted key, quotes removed (`[ mcp_servers."x" ]` → "mcp_servers.x"); undefined for other lines. @param {string} line */
function tomlHeader(line) {
  const m = /^\s*\[(?!\[)\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*\]/.exec(line);
  return m?.[1].split(/\s*\.\s*(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).map((k) => k.replace(/^["']|["']$/g, "")).join(".");
}

/**
 * Where each line of a TOML text starts a table: lines inside multi-line arrays
 * and strings never do. @param {string[]} lines @returns {boolean[]}
 */
function tableStarts(lines) {
  let depth = 0;
  let inString = "";
  return lines.map((line) => {
    const starts = !inString && depth === 0 && /^\s*\[/.test(line);
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inString) {
        if (line.startsWith(inString, i)) {
          i += inString.length - 1;
          inString = "";
        } else if (c === "\\" && inString[0] === '"') i++;
        continue;
      }
      if (c === "#") break;
      const triple = line.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        inString = triple;
        i += 2;
      } else if (c === '"' || c === "'") inString = c;
      else if (!starts && c === "[") depth++;
      else if (!starts && c === "]") depth = Math.max(0, depth - 1);
    }
    // A one-line string cannot run past its line.
    if (inString.length === 1) inString = "";
    return starts;
  });
}

/**
 * Codex's config.toml with our [mcp_servers.imprimatur] table (and its subtables) replaced.
 * Pure text edit: the rest of the file is kept byte for byte, line endings too.
 * @param {string} toml @param {{root: string}} opts
 */
export function mergeCodex(toml, { root }) {
  const { command, args } = mcpCommand(root);
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const blockLines = [`[mcp_servers.${MCP_NAME}]`, `command = ${JSON.stringify(command)}`, `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`];
  const block = blockLines.join(eol) + eol;
  const lines = toml.split(eol);
  const starts = tableStarts(lines);
  const ours = (i) => {
    const key = starts[i] && tomlHeader(lines[i]);
    return Boolean(key) && (key === `mcp_servers.${MCP_NAME}` || key.startsWith(`mcp_servers.${MCP_NAME}.`));
  };
  const start = lines.findIndex((_, i) => ours(i));
  if (start < 0) {
    const sep = toml === "" || toml.endsWith(eol + eol) ? "" : toml.endsWith(eol) ? eol : eol + eol;
    return { toml: toml + sep + block, change: `added   [mcp_servers.${MCP_NAME}]` };
  }
  let end = start + 1;
  while (end < lines.length && (!starts[end] || ours(end))) end++;
  // Keep the blank lines that separated the old block from the next table.
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  if (lines.slice(start, end).join(eol) === blockLines.join(eol) && lines.findIndex((_, i) => i >= end && ours(i)) < 0) {
    return { toml, change: undefined };
  }
  const rest = lines.slice(end).filter((_, i) => !ours(end + i));
  const next = [...lines.slice(0, start), ...blockLines, ...rest].join(eol);
  return { toml: next, change: `updated [mcp_servers.${MCP_NAME}]` };
}

/**
 * Settings with Imprimatur's hooks in place. Pure: returns a copy and the changes.
 * @param {any} settings ~/.claude/settings.json content
 * @param {{root: string, lang?: string, exts?: string[]}} opts root: this repo
 * @returns {{settings: any, changes: string[]}}
 */
export function mergeHooks(settings, { root, lang, exts = ["md", "mdx"] }) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  const changes = [];
  for (const [event, matcher, script, args] of wanted(exts)) {
    const command = `${lang ? `IMPRIMATUR_LANG=${lang} ` : ""}node "${path.join(root, "hooks", script)}"${args}`;
    const entries = (out.hooks[event] ??= []);
    const ours = entries
      .filter((e) => (e.matcher ?? "") === (matcher ?? ""))
      .flatMap((e) => e.hooks ?? [])
      // Ours: the script under an imprimatur folder (a generic name like process.mjs may be someone else's).
      .find((h) => typeof h.command === "string" && h.command.includes(`/hooks/${script}`) && /imprimatur/i.test(h.command));
    const label = `${event}${matcher ? ` [${matcher}]` : ""} → ${script}`;
    if (!ours) {
      entries.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
      changes.push(`added   ${label}`);
    } else if (ours.command.replace(/"/g, "") !== command.replace(/"/g, "")) {
      ours.command = command;
      changes.push(`updated ${label}`);
    }
  }
  return { settings: out, changes };
}

/**
 * VS Code settings with one imprimatur setting set. Pure: returns a copy and the change.
 * @param {any} settings @param {string} key @param {string} value @param {string} fallback shown when unset
 */
function mergeSetting(settings, key, value, fallback) {
  const out = structuredClone(settings ?? {});
  if (out[key] === value) return { settings: out, change: undefined };
  const change = `${key}: ${out[key] ?? `(default ${fallback})`} → ${value}`;
  out[key] = value;
  return { settings: out, change };
}

/** imprimatur.showIn (--show-in). @param {any} settings @param {string} showIn */
export function mergeShowIn(settings, showIn) {
  if (!["preview", "editor", "both"].includes(showIn)) throw new Error(`--show-in: preview, editor or both, not ${showIn}`);
  return mergeSetting(settings, "imprimatur.showIn", showIn, "preview");
}

/**
 * imprimatur.language (--lang): the extension's model calls (Scan history,
 * Audit) write in the hooks' language. The hooks get it from IMPRIMATUR_LANG
 * in their command; the extension does not see that variable.
 * @param {any} settings @param {string} lang
 */
export const mergeLanguage = (settings, lang) => mergeSetting(settings, "imprimatur.language", lang, "the agent's language");

/** Where VS Code keeps this machine's settings: the server's machine settings on a remote, else the user's. */
function vscodeSettingsFile() {
  const home = os.homedir();
  if (fs.existsSync(path.join(home, ".vscode-server"))) return path.join(home, ".vscode-server", "data", "Machine", "settings.json");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User", "settings.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? home, "Code", "User", "settings.json");
  return path.join(home, ".config", "Code", "User", "settings.json");
}

/** Back up a file (if any), then write JSON to it. @param {string} file @param {any} data */
function writeWithBackup(file, data) {
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-imprimatur`;
    fs.copyFileSync(file, backup);
    console.log(`  backup: ${backup}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/**
 * The MCP server in every installed client. node:sqlite needs Node >= 22.13.
 * @param {string} root @param {{dry: boolean}} opts
 */
function registerMcp(root, { dry }) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.log(`MCP server: Node ${process.versions.node} has no node:sqlite; install Node >= 22.13 and run setup again.`);
    return;
  }
  const home = os.homedir();
  const { command, args } = mcpCommand(root);

  let claudeHas;
  try {
    claudeHas = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers?.[MCP_NAME];
  } catch {}
  const claudeSame = claudeHas?.command === command && JSON.stringify(claudeHas?.args) === JSON.stringify(args);
  if (claudeSame) console.log("MCP server in Claude Code: in place");
  else if (!has("claude")) console.log(`MCP server in Claude Code: 'claude' not on PATH; run: claude mcp add -s user ${MCP_NAME} -- ${command} ${args.join(" ")}`);
  else {
    console.log(`MCP server in Claude Code: ${claudeHas ? "updated" : "added"} (user scope)`);
    if (!dry) {
      try {
        // `claude mcp add` refuses an existing name: remove first, put the old one back if add fails.
        if (claudeHas) execFileSync("claude", ["mcp", "remove", "-s", "user", MCP_NAME], { stdio: "ignore" });
        try {
          execFileSync("claude", ["mcp", "add", "-s", "user", MCP_NAME, "--", command, ...args], { stdio: ["ignore", "ignore", "pipe"] });
        } catch (e) {
          if (claudeHas) execFileSync("claude", ["mcp", "add-json", "-s", "user", MCP_NAME, JSON.stringify(claudeHas)], { stdio: "ignore" });
          throw e;
        }
      } catch (e) {
        console.log(`  failed: ${String(/** @type {any} */ (e).stderr || /** @type {Error} */ (e).message).trim()}`);
      }
    }
  }

  const cursorDir = path.join(home, ".cursor");
  if (fs.existsSync(cursorDir)) {
    const file = path.join(cursorDir, "mcp.json");
    try {
      const { config, change } = mergeCursor(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}, { root });
      console.log(`MCP server in Cursor (${file}): ${change ?? "in place"}`);
      if (change && !dry) writeWithBackup(file, config);
    } catch {
      console.log(`MCP server in Cursor: ${file} is not plain JSON; add ${JSON.stringify({ [MCP_NAME]: { type: "stdio", command, args } })} to mcpServers by hand.`);
    }
  } else console.log("MCP server in Cursor: not installed (~/.cursor missing), skipped");

  const codexDir = path.join(home, ".codex");
  if (fs.existsSync(codexDir)) {
    const file = path.join(codexDir, "config.toml");
    try {
      const { toml, change } = mergeCodex(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", { root });
      console.log(`MCP server in Codex (${file}): ${change ?? "in place"}`);
      if (change && !dry) {
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-imprimatur`);
        fs.writeFileSync(file, toml);
      }
    } catch (e) {
      console.log(`MCP server in Codex: ${file}: ${/** @type {Error} */ (e).message}`);
    }
  } else console.log("MCP server in Codex: not installed (~/.codex missing), skipped");
}

/** @param {string[]} argv */
function options(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    lang: get("--lang"),
    showIn: get("--show-in"),
    exts: get("--exts")?.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    extension: !argv.includes("--no-extension"),
    dry: argv.includes("--dry-run"),
  };
}

/** @param {string} cmd @param {string[]} args */
const has = (cmd, args = ["--version"]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const opts = options(process.argv.slice(2));
  const file = path.join(os.homedir(), ".claude", "settings.json");
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const { settings, changes } = mergeHooks(before, { root, lang: opts.lang, exts: opts.exts });

  console.log(`Hooks in ${file}:`);
  console.log(changes.length ? changes.map((c) => `  ${c}`).join("\n") : "  all in place");
  if (changes.length && !opts.dry) writeWithBackup(file, settings);

  registerMcp(root, opts);

  if (opts.showIn || opts.lang) {
    const vs = vscodeSettingsFile();
    const wanted = { ...(opts.showIn && { "imprimatur.showIn": opts.showIn }), ...(opts.lang && { "imprimatur.language": opts.lang }) };
    // VS Code settings may carry comments: those files are left to the user.
    let current = {};
    try {
      current = fs.existsSync(vs) ? JSON.parse(fs.readFileSync(vs, "utf8")) : {};
    } catch {
      console.log(`VS Code settings ${vs}: not plain JSON (comments?); set ${JSON.stringify(wanted)} there by hand.`);
      current = undefined;
    }
    if (current) {
      let next = current;
      const changes = [];
      for (const [merge, value] of [[mergeShowIn, opts.showIn], [mergeLanguage, opts.lang]]) {
        if (!value) continue;
        const r = merge(next, value);
        next = r.settings;
        if (r.change) changes.push(r.change);
      }
      console.log(`VS Code settings ${vs}:\n  ${changes.join("\n  ") || "already set"}`);
      if (changes.length && !opts.dry) writeWithBackup(vs, next);
    }
  }

  if (opts.extension && !opts.dry) {
    console.log("Extension:");
    execFileSync("npm", ["run", "-s", "package"], { cwd: root, stdio: "inherit" });
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "vscode", "package.json"), "utf8"));
    const vsix = path.join(root, "dist", `imprimatur-${version}.vsix`);
    if (has("code")) execFileSync("code", ["--install-extension", vsix, "--force"], { stdio: "inherit" });
    else console.log(`  'code' not on PATH: install ${vsix} from the Extensions view (Install from VSIX).`);
  }

  console.log(
    has("claude")
      ? "claude CLI: found (edit descriptions, chat sync and audit use it)."
      : "claude CLI: not on PATH; edit descriptions, chat sync and audit fall back to rules.",
  );
  console.log("New Claude Code sessions pick the hooks up; reload VS Code windows for the extension.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
