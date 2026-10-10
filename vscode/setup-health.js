// @ts-check
// Agent setup health: problems in the files the scanner found that make the
// agent behave differently from what the file says. Each check reads the
// files and returns problems; nothing is changed. A secret is never echoed,
// only the line it is on.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { importsOf, flatItems, parseJson, allowsComments } = require("./agent-setup.js");

/** @typedef {{file: string, level: "error" | "warn", message: string, line?: number}} Problem */
/** @typedef {{abs: string, rel: string, tool: string, kind: string, children?: any[]}} Item */

/** @param {string} abs */
const read = (abs) => {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Split a shell command into words like the shell does: quoted parts join
 * the text next to them ("$DIR"/x.sh is one word), quotes are removed, and
 * ; | & < > ( ) end a word.
 * @param {string} cmd @returns {string[]}
 */
function words(cmd) {
  const out = [];
  let cur = "";
  let inWord = false;
  const end = () => {
    if (inWord) out.push(cur);
    cur = "";
    inWord = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"' || ch === "'") {
      const close = cmd.indexOf(ch, i + 1);
      const stop = close < 0 ? cmd.length : close;
      cur += cmd.slice(i + 1, stop).replace(ch === '"' ? /\\(["\\$`])/g : /$^/, "$1");
      inWord = true;
      i = stop;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
    } else if (/[\s;|&<>()]/.test(ch)) end();
    else {
      cur += ch;
      inWord = true;
    }
  }
  end();
  return out;
}

const SCRIPT_EXT = /\.(sh|bash|zsh|mjs|cjs|js|ts|py|rb|pl|ps1)$/;

/**
 * Script files a hook command names that are not on disk. A word counts as a
 * script when it names a path (./x, /x, ~/x, $CLAUDE_PROJECT_DIR/x) or ends in
 * a script extension. Plugin variables (${CLAUDE_PLUGIN_ROOT}, …) and other
 * unknown $VARs are skipped; relative paths resolve from `cwd` (skipped when
 * it is unknown).
 * @param {string} cmd @param {{projectDir?: string, cwd?: string, home?: string}} ctx
 * @returns {string[]} the missing paths as written
 */
function missingScripts(cmd, ctx) {
  const home = ctx.home ?? os.homedir();
  const missing = [];
  for (const w of words(cmd)) {
    if (!w || /\s|[=*?]|:\/\//.test(w)) continue;
    let p = w;
    if (/\$\{?CLAUDE_PROJECT_DIR\}?/.test(p)) {
      if (!ctx.projectDir) continue;
      p = p.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, ctx.projectDir);
    }
    p = p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
    if (p.includes("$")) continue; // plugin root/data or another variable: unknown here
    const pathLike = /^(\.{1,2}\/|\/)/.test(p) || p !== w;
    if (!pathLike && !SCRIPT_EXT.test(p)) continue;
    if (!path.isAbsolute(p)) {
      if (!ctx.cwd) continue;
      p = path.resolve(ctx.cwd, p);
    }
    if (!fs.existsSync(p)) missing.push(w);
  }
  return missing;
}

/** Commands of a Claude settings object: event → command (exec form's command + args). @param {any} s */
function claudeHookCommands(s) {
  const out = [];
  for (const [event, groups] of Object.entries(s?.hooks ?? {}))
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of g?.hooks ?? [])
        if ((h?.type ?? "command") === "command" && typeof h?.command === "string")
          // Exec form (args): no shell, so each part is one word.
          out.push({ event, command: Array.isArray(h.args) ? [h.command, ...h.args.map(String)].map((a) => JSON.stringify(a)).join(" ") : h.command });
  return out;
}

/** Commands of a Cursor hooks.json object. @param {any} s */
function cursorHookCommands(s) {
  const out = [];
  for (const [event, list] of Object.entries(s?.hooks ?? {}))
    for (const h of Array.isArray(list) ? list : []) if (typeof h?.command === "string") out.push({ event, command: h.command });
  return out;
}

/**
 * Hooks whose script is missing: Claude settings (repo, user, managed) and
 * Cursor hooks.json. Claude hooks run from the project folder; Cursor's
 * project hooks from the project root, user hooks from ~/.cursor.
 * @param {Item} it @param {{root: string, global: boolean, home?: string}} scope @returns {Problem[]}
 */
function checkHookScripts(it, scope) {
  const claude = it.tool === "Claude Code" && (it.kind === "settings" || it.kind === "managed policy") && it.abs.endsWith(".json") && !it.abs.endsWith("mcp.json");
  const cursor = it.tool === "Cursor" && it.kind === "hooks";
  if (!claude && !cursor) return [];
  const text = read(it.abs);
  let s;
  try {
    s = text === undefined ? undefined : parseJson(it.abs, text);
  } catch {
    return []; // checkJson reports it
  }
  const home = scope.home ?? os.homedir();
  const ctx = claude
    ? { projectDir: scope.global ? undefined : scope.root, cwd: scope.global ? undefined : scope.root, home }
    : { cwd: scope.global ? path.join(home, ".cursor") : scope.root, home };
  return (claude ? claudeHookCommands(s) : cursorHookCommands(s)).flatMap(({ event, command }) =>
    missingScripts(command, ctx).map((p) => /** @type {Problem} */ ({ file: it.abs, level: "error", message: `${event} hook runs ${p}, which does not exist` })));
}

/**
 * @imports that point at no file. Only words that look like a path (an
 * extension, or ./ ../ / ~/) count, so "@types/node" or a mention of
 * "@someone" is not one.
 * @param {Item} it @param {{home?: string}} scope @returns {Problem[]}
 */
function checkImports(it, scope) {
  const base = path.basename(it.abs);
  const reads = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].includes(base) || (it.tool === "Claude Code" && (it.kind === "rules" || it.kind === "import") && base.endsWith(".md"));
  if (!reads) return [];
  return importsOf(it.abs, scope.home ?? os.homedir())
    .filter((i) => !i.exists && (/^(~|\.{0,2})\//.test(i.written) || /\.[A-Za-z0-9]+$/.test(path.basename(i.written))))
    .map((i) => ({ file: it.abs, level: /** @type {const} */ ("warn"), line: i.line, message: `@${i.written} on line ${i.line} imports a file that does not exist` }));
}

/** A .md under .cursor/rules: Cursor reads only .mdc there. @param {Item} it @returns {Problem[]} */
function checkCursorRuleExt(it) {
  const p = it.abs.split(path.sep).join("/");
  if (!/\/\.cursor\/rules\/.+\.md$/.test(p)) return [];
  return [{ file: it.abs, level: "warn", message: "Cursor reads only .mdc files in .cursor/rules: this .md is skipped (rename it to .mdc with front matter)" }];
}

/**
 * A JSON settings or MCP file that does not parse. Comments and trailing
 * commas are fine only where the tool allows them (.vscode/*.json, Gemini
 * settings, Cursor mcp.json); Claude Code settings are strict JSON.
 * @param {Item} it @returns {Problem[]}
 */
function checkJson(it) {
  if (!it.abs.endsWith(".json")) return [];
  const text = read(it.abs);
  if (text === undefined) return [];
  try {
    parseJson(it.abs, text);
    return [];
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message);
    const pos = /position (\d+)/.exec(msg)?.[1];
    const line = Number(/line (\d+) column/.exec(msg)?.[1]) || (pos === undefined ? undefined : text.slice(0, Number(pos)).split("\n").length);
    const hint = allowsComments(it.abs) ? "" : /\/\/|\/\*|,\s*[}\]]/.test(text) ? " (comments and trailing commas are not allowed here)" : "";
    return [{ file: it.abs, level: "error", ...(line ? { line } : {}), message: `Not valid JSON${line ? ` near line ${line}` : ""}${hint}: the tool ignores this file` }];
  }
}

/**
 * Secret patterns: name, regex, level. A key with a known shape is an error;
 * a long "password=…" / "token: …" value is a warning (it may be a made-up
 * example). Values are matched, never shown.
 * @type {Array<[string, RegExp, "error" | "warn"]>}
 */
const SECRETS = [
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "error"],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/, "error"],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/, "error"],
  ["an OpenAI API key", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/, "error"],
  ["a password or token", /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\b["']?\s*[:=]\s*["']?(?![$<{[(]|process\.|os\.|env\b|your|xxx|\*{3}|\.{3}|example|placeholder|changeme|dummy|redacted)([^\s"'`<>,;)]{16,})/i, "warn"],
];

/** Text kinds a secret should never be in. */
const SECRET_KINDS = new Set(["rules", "memory", "import", "skill", "agent", "command", "prompt", "chat mode", "output style", "managed policy"]);

/**
 * Secrets in rule and memory files (they go into every prompt, and often
 * into git). The message names the kind and line, never the value.
 * @param {Item} it @returns {Problem[]}
 */
function checkSecrets(it) {
  if (!SECRET_KINDS.has(it.kind) || it.abs.endsWith(".json")) return [];
  const text = read(it.abs);
  if (text === undefined) return [];
  /** @type {Problem[]} */
  const out = [];
  text.split(/\r?\n/).forEach((l, n) => {
    for (const [name, re, level] of SECRETS)
      if (re.test(l)) {
        out.push({ file: it.abs, level, line: n + 1, message: `Line ${n + 1} looks like ${name}: if it is real, remove it and rotate it` });
        break;
      }
  });
  return out;
}

/**
 * Every check over a scope's files (import rows included).
 * @param {Item[]} items @param {{root: string, global: boolean, home?: string}} scope @returns {Problem[]}
 */
function checkHealth(items, scope) {
  const seen = new Set();
  /** @type {Problem[]} */
  const out = [];
  for (const it of flatItems(/** @type {any} */ (items))) {
    if (seen.has(it.abs)) continue;
    seen.add(it.abs);
    out.push(...checkHookScripts(it, scope), ...checkImports(it, scope), ...checkCursorRuleExt(it), ...checkJson(it), ...checkSecrets(it));
  }
  return out;
}

module.exports = { checkHealth, checkHookScripts, checkImports, checkCursorRuleExt, checkJson, checkSecrets, missingScripts, words };
