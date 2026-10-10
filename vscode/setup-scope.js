// @ts-check
// When each agent file applies (#28): "always", "for <globs>" or "on request",
// read from the file's own front matter the way each tool reads it, and which
// rules, instruction files, skills and hooks are in effect when the agent
// works on one file. Pure apart from withScopes(), which reads the files.
//
// Claude Code   https://code.claude.com/docs/en/memory  (.claude/rules `paths:`,
//               CLAUDE.md / AGENTS.md loading), https://code.claude.com/docs/en/skills
//               (`paths`, `disable-model-invocation`)
// Cursor        https://cursor.com/docs/context/rules (alwaysApply / globs / description)
// Copilot       https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
//               (`applyTo`, `excludeAgent`), https://code.visualstudio.com/docs/copilot/customization/custom-instructions
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * Front matter with lists: `key: value`, `key: [a, b]` and `key:` followed by
 * `- item` lines. Quotes are dropped. A block scalar (| or >) joins its lines.
 * @param {string} text @returns {Record<string, string | string[]>}
 */
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  /** @type {Record<string, string | string[]>} */
  const out = {};
  if (!m) return out;
  const unq = (s) => s.trim().replace(/^["']|["']$/g, "");
  /** @type {string | undefined} */
  let open;
  let block = false;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      const v = kv[2].trim();
      open = undefined;
      block = false;
      if (/^\[.*\]$/.test(v)) out[kv[1]] = splitTop(v.slice(1, -1)).map(unq).filter(Boolean);
      else if (v === "") {
        out[kv[1]] = "";
        open = kv[1];
      } else if (/^[|>][-+]?$/.test(v)) {
        out[kv[1]] = "";
        open = kv[1];
        block = true;
      } else out[kv[1]] = unq(v);
      continue;
    }
    if (!open) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && !block) {
      const cur = out[open];
      out[open] = [...(Array.isArray(cur) ? cur : []), unq(item[1])];
    } else if (/^\s+\S/.test(line) && typeof out[open] === "string") out[open] = `${out[open]} ${line.trim()}`.trim();
  }
  return out;
}

/** Split on commas outside {braces}: "src/*.{ts,tsx}, lib/**" → 2 parts. @param {string} s */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") depth++;
    if (c === "}") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** A front matter value as a glob list (YAML list or comma-separated string). @param {string | string[] | undefined} v */
function globList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v.flatMap(splitTop) : splitTop(v)).map((g) => g.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

const esc = (c) => c.replace(/[.+^$()|\\/[\]{}*?]/g, "\\$&");

/**
 * A glob as a RegExp over "/"-separated relative paths: ** spans folders,
 * * and ? stay in one, {a,b} alternates, [abc] is a class, \ escapes.
 * An unusable [ makes the pattern match nothing (as Claude Code does).
 * @param {string} glob @returns {RegExp}
 */
function globToRegExp(glob) {
  const body = (g) => {
    let re = "";
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === "*" && g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else if (c === "\\" && i + 1 < g.length) re += esc(g[++i]);
      else if (c === "{") {
        let depth = 0;
        let end = -1;
        for (let j = i; j < g.length; j++) {
          if (g[j] === "{") depth++;
          if (g[j] === "}" && --depth === 0) {
            end = j;
            break;
          }
        }
        if (end < 0) {
          re += "\\{";
          continue;
        }
        const alts = splitTop(g.slice(i + 1, end));
        const parts = alts.map(body);
        if (parts.some((p) => p === null)) return null;
        re += `(?:${parts.join("|")})`;
        i = end;
      } else if (c === "[") {
        const end = g.indexOf("]", i + 2);
        if (end < 0) return null;
        let cls = g.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (cls[0] === "!") cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = end;
      } else re += esc(c);
    }
    return re;
  };
  const b = body(glob.replace(/^\.?\//, ""));
  return b === null ? /(?!)/ : new RegExp(`^${b}$`);
}

/** Does a relative path match a glob? @param {string} rel @param {string} glob */
const globMatch = (rel, glob) => globToRegExp(glob).test(rel);

/**
 * @typedef {{mode: "always" | "globs" | "request" | "manual", globs: string[], label: string, note?: string}} Scope
 */

/** The folder an instruction file sits in, "" for the root: "docs/CLAUDE.md" → "docs/". @param {string} rel */
function dirOf(rel) {
  const d = rel.split("/").slice(0, -1).filter((p) => p !== ".claude" && p !== ".github").join("/");
  return d ? `${d}/` : "";
}

/** The folder a `.claude/…` path belongs to: "app/.claude/rules/x.md" → "app/". @param {string} rel */
function claudeBase(rel) {
  const i = rel.indexOf(".claude/");
  return i > 0 ? rel.slice(0, i) : "";
}

/** @param {string[]} globs */
const forLabel = (globs) => `for ${globs.join(", ")}`;

/** @param {Scope["mode"]} mode @param {string[]} [globs] @param {string} [note] @returns {Scope} */
function scope(mode, globs = [], note) {
  const label = mode === "always" ? "always" : mode === "globs" ? forLabel(globs) : mode === "request" ? "on request" : "manual";
  return note ? { mode, globs, label, note } : { mode, globs, label };
}

/**
 * When a file applies, from its path and text, or undefined when it is not a
 * rule, instruction file or skill.
 * @param {{rel: string, tool: string, kind: string}} item @param {string} text
 * @param {{global?: boolean}} [opts] global: a home-folder file (applies everywhere)
 * @returns {Scope | undefined}
 */
function scopeOf(item, text, opts = {}) {
  const { rel, tool, kind } = item;
  const base = rel.split("/").pop() ?? "";
  const fm = parseFrontMatter(text);
  if (tool === "Claude Code" && kind === "rules") {
    const where = opts.global ? "" : rel.includes(".claude/rules/") ? claudeBase(rel) : dirOf(rel);
    if (rel.includes(".claude/rules/")) {
      // paths: is the only field Claude Code reads; without it the rule is unconditional.
      const globs = globList(fm.paths);
      if (globs.length) return scope("globs", globs);
      return where ? scope("globs", [`${where}**`], "loads once Claude works on a file there") : scope("always");
    }
    // CLAUDE.md / CLAUDE.local.md: the root (and ancestors) at launch, a subfolder's on demand.
    return where ? scope("globs", [`${where}**`], "loads once Claude works on a file there") : scope("always");
  }
  if (tool === "Claude Code" && kind === "skill") {
    if (String(fm["disable-model-invocation"]) === "true") return scope("manual", [], "only when you type /name");
    const globs = globList(fm.paths);
    if (globs.length) return scope("globs", globs);
    const where = opts.global ? "" : claudeBase(rel);
    if (where) return scope("globs", [`${where}**`], "available once Claude works on a file there");
    return scope("request", [], "description always in context; loads when relevant");
  }
  if (tool === "Codex / AGENTS.md" && base === "AGENTS.md") {
    const where = opts.global ? "" : dirOf(rel);
    return where ? scope("globs", [`${where}**`], "nearest AGENTS.md applies") : scope("always");
  }
  if (tool === "Gemini" && base === "GEMINI.md") {
    const where = opts.global ? "" : dirOf(rel);
    return where ? scope("globs", [`${where}**`]) : scope("always");
  }
  if (tool === "Cursor" && kind === "rules") {
    if (rel === ".cursorrules" || base === ".cursorrules") return scope("always");
    if (String(fm.alwaysApply) === "true") return scope("always");
    const globs = globList(fm.globs);
    if (globs.length) return scope("globs", globs);
    if (fm.description) return scope("request", [], "the agent pulls it in when the description fits");
    return scope("manual", [], "only when @-mentioned");
  }
  if (tool === "GitHub Copilot" && kind === "rules") {
    if (rel.endsWith("copilot-instructions.md")) return scope("always");
    const ex = typeof fm.excludeAgent === "string" && fm.excludeAgent ? `not for ${fm.excludeAgent}` : undefined;
    const globs = globList(fm.applyTo);
    if (globs.some((g) => g === "**" || g === "**/*")) return scope("always", [], ex);
    if (globs.length) return scope("globs", globs, ex);
    if (fm.description) return scope("request", [], ex ?? "the agent loads it when the description fits");
    return scope("manual", [], ex ?? "only when attached by hand");
  }
  if (tool === "Windsurf" || tool === "Cline") return kind === "rules" ? scope("always") : undefined;
  return undefined;
}

/**
 * Scan items with their scope added (reads each rule/skill file once).
 * @template {{rel: string, abs: string, tool: string, kind: string}} T
 * @param {T[]} items @param {{global?: boolean}} [opts] @returns {Array<T & {scope?: Scope}>}
 */
function withScopes(items, opts = {}) {
  return items.map((it) => {
    if (!["rules", "skill"].includes(it.kind)) return it;
    let text = "";
    try {
      text = fs.readFileSync(it.abs, "utf8");
    } catch {
      return it;
    }
    const s = scopeOf(it, text, opts);
    return s ? { ...it, scope: s } : it;
  });
}

/** Does a scope apply to a file (rel to the repo)? @param {Scope} s @param {string} rel */
const applies = (s, rel) => s.mode === "always" || (s.mode === "globs" && s.globs.some((g) => globMatch(rel, g)));

const FILE_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"];
const FILE_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);

/**
 * A hook matcher against a tool name, the documented way: "*", "" or none
 * match all; letters/digits/_/-/space/,/| only is an exact list; anything
 * else an unanchored JavaScript regex.
 * @param {string | undefined} matcher @param {string} name
 */
function matcherMatches(matcher, name) {
  if (!matcher || matcher === "*") return true;
  if (/^[\w\s,|-]+$/.test(matcher)) return matcher.split(/[|,]/).map((s) => s.trim()).includes(name);
  try {
    return new RegExp(matcher).test(name);
  } catch {
    return false;
  }
}

/**
 * A hook's `if` (one permission rule) against a file: "Edit(*.ts)" etc.
 * Rules on other tools (Bash(…)) don't concern a file: no match.
 * @param {string | undefined} rule @param {string} rel
 */
function ifMatchesFile(rule, rel) {
  if (!rule) return true;
  const m = /^(\w+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m || !FILE_TOOLS.includes(m[1])) return false;
  if (!m[2] || m[2] === "*") return true;
  const p = m[2].replace(/^\/\/?|^\.\//, "");
  // gitignore-like: a pattern without "/" matches the name in any folder.
  return p.includes("/") ? globMatch(rel, p) : globMatch(rel.split("/").pop() ?? "", p) || globMatch(rel, p);
}

/**
 * What is in effect when the agent works on a file.
 * @param {string} filePath absolute, or relative to scan.root
 * @param {{root: string, items: Array<{rel: string, tool: string, kind: string, label?: string, scope?: Scope}>,
 *   globalItems?: Array<{rel: string, tool: string, kind: string, label?: string, scope?: Scope}>,
 *   hooks?: Array<{event: string, handlers: Array<{matcher?: string, if?: string, active?: boolean}>}>}} scan
 *   hooks: the merged hooks (setup-merged.js mergeSettings().hooks)
 */
function inEffectFor(filePath, scan) {
  const rel = (path.isAbsolute(filePath) ? path.relative(scan.root, filePath) : filePath).split(path.sep).join("/");
  const inside = !rel.startsWith("..") && !path.isAbsolute(rel);
  const all = [...(inside ? scan.items : []).map((item) => ({ item, global: false })), ...(scan.globalItems ?? []).map((item) => ({ item, global: true }))];
  const out = { rel, rules: /** @type {any[]} */ ([]), onRequest: /** @type {any[]} */ ([]), instructions: /** @type {any[]} */ ([]), skills: /** @type {any[]} */ ([]), hooks: /** @type {any[]} */ ([]) };
  // Claude reads AGENTS.md only when no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md is in the folder or above.
  const claudeMdAbove = all.some(({ item, global }) => !global && /(^|\/)(\.claude\/)?CLAUDE(\.local)?\.md$/.test(item.rel) && !item.rel.includes(".claude/rules/") && item.scope && applies(item.scope, rel));
  for (const { item, global } of all) {
    const s = item.scope;
    if (!s) continue;
    const base = item.rel.split("/").pop() ?? "";
    const isInstr = /^(CLAUDE(\.local)?|AGENTS|GEMINI)\.md$/.test(base) && !item.rel.includes("/rules/");
    if (item.kind === "skill") {
      if (s.mode === "request" || applies(s, rel)) out.skills.push({ ...item, global, how: s.mode === "request" ? "description-triggered" : s.label });
      continue;
    }
    if (item.kind !== "rules") continue;
    if (isInstr) {
      if (!applies(s, rel)) continue;
      const tools = base === "AGENTS.md" ? ["Codex", "Cursor", "GitHub Copilot", ...(claudeMdAbove || global ? [] : ["Claude Code"])] : [item.tool];
      out.instructions.push({ ...item, global, tools });
    } else if (applies(s, rel)) out.rules.push({ ...item, global });
    else if (s.mode === "request") out.onRequest.push({ ...item, global });
  }
  for (const ev of scan.hooks ?? []) {
    if (!FILE_EVENTS.has(ev.event)) continue;
    for (const h of ev.handlers) {
      if (h.active === false) continue;
      if (!FILE_TOOLS.some((t) => matcherMatches(h.matcher, t))) continue;
      if (!ifMatchesFile(h.if, rel)) continue;
      out.hooks.push({ event: ev.event, ...h });
    }
  }
  return out;
}

/**
 * The "For <file>" tree as plain nodes (group / leaf) for the side bar.
 * @param {ReturnType<typeof inEffectFor>} e @param {string} name the file's name
 */
function effectTree(e, name) {
  const leaf = (x, description, icon) => ({ type: "leaf", label: x.label ?? x.rel.split("/").pop(), description, icon, abs: x.abs, tooltip: `${x.global ? `~/${x.rel}` : x.rel} · ${x.tool}` });
  const g = (x) => (x.global ? "global · " : "");
  const groups = [
    { label: "Rules", icon: "book", children: [...e.rules.map((x) => leaf(x, `${g(x)}${x.tool} · ${x.scope.label}`, "book")), ...e.onRequest.map((x) => leaf(x, `${g(x)}${x.tool} · on request`, "question"))] },
    { label: "Instruction files", icon: "file-text", children: e.instructions.map((x) => leaf(x, `${g(x)}${(x.tools ?? [x.tool]).join(", ")}`, "file-text")) },
    { label: "Skills", icon: "mortar-board", children: e.skills.map((x) => leaf(x, `${g(x)}${x.how}`, "mortar-board")) },
    {
      label: "Hooks", icon: "zap",
      children: e.hooks.map((h) => ({ type: "leaf", label: String(h.command).split(/\s+/).pop(), description: [h.event, h.scope, h.matcher && `[${h.matcher}]`, h.if && `if ${h.if}`, h.async && "async"].filter(Boolean).join(" · "), icon: "zap", abs: h.file, tooltip: h.command })),
    },
  ].filter((x) => x.children.length);
  const n = groups.reduce((k, x) => k + x.children.length, 0);
  return {
    type: "group", label: `For ${name}`, icon: "target", description: `${n} in effect`, tooltip: `What shapes the agent when it works on ${e.rel}`,
    children: groups.map((x) => ({ type: "group", ...x, description: String(x.children.length) })),
  };
}

module.exports = { effectTree, parseFrontMatter, splitTop, globToRegExp, globMatch, scopeOf, withScopes, inEffectFor, matcherMatches, ifMatchesFile };
