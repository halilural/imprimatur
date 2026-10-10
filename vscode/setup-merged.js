// @ts-check
// Effective Claude Code settings (#33): user, project, local and managed
// settings merged the documented way into the hooks that run per event and
// the permission rules that decide, with the scope each comes from.
//
// Precedence (highest first): managed > command line > local > project > user
//   https://code.claude.com/docs/en/settings#settings-precedence
// Lists merge instead of overriding (permissions.allow etc.)
//   https://code.claude.com/docs/en/settings#lists-merge-instead-of-overriding
// Rules are evaluated deny, then ask, then allow; a deny at any level can't be
// allowed by another: https://code.claude.com/docs/en/permissions#settings-precedence
// Hook entries merge across levels; all matching hooks run in parallel; the
// same handler in more than one settings file runs once; disableAllHooks /
// allowManagedHooksOnly: https://code.claude.com/docs/en/hooks
// Managed files: managed-settings.json, then managed-settings.d/*.json in
// alphabetical order: https://code.claude.com/docs/en/managed-settings
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Scopes, highest precedence first (the command line is per session: not read). */
const SCOPES = ["managed", "local", "project", "user"];
const rank = (s) => SCOPES.indexOf(s);

/** Events in the order a session meets them; unknown events follow, by name. */
const EVENT_ORDER = [
  "SessionStart", "Setup", "InstructionsLoaded", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse",
  "PostToolUseFailure", "PostToolBatch", "Notification", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "TeammateIdle",
  "Stop", "StopFailure", "PreCompact", "PostCompact", "ConfigChange", "CwdChanged", "FileChanged", "WorktreeCreate", "WorktreeRemove",
  "MessageDisplay", "Elicitation", "ElicitationResult", "SessionEnd",
];
/** Events without matcher support: a matcher there is silently ignored. */
const NO_MATCHER = new Set(["UserPromptSubmit", "PostToolBatch", "Stop", "TeammateIdle", "TaskCreated", "TaskCompleted", "WorktreeCreate", "WorktreeRemove", "MessageDisplay", "CwdChanged"]);
/** `if` is evaluated only on these; on other events a hook with `if` never runs. */
const IF_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);

/** The managed settings folder per platform. @param {string} [platform] */
function managedDir(platform = process.platform) {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The settings files that exist, highest precedence first.
 * @param {{root: string, home: string, managedDir?: string}} where
 * @returns {Array<{scope: string, file: string, settings: any}>}
 */
function readSources({ root, home, managedDir: mdir = managedDir() }) {
  /** @type {Array<{scope: string, file: string, settings: any}>} */
  const out = [];
  const add = (scope, file) => {
    const settings = readJson(file);
    if (settings && typeof settings === "object") out.push({ scope, file, settings });
  };
  add("managed", path.join(mdir, "managed-settings.json"));
  try {
    const drop = path.join(mdir, "managed-settings.d");
    for (const f of fs.readdirSync(drop).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) add("managed", path.join(drop, f));
  } catch {
    // no drop-in folder
  }
  add("local", path.join(root, ".claude", "settings.local.json"));
  add("project", path.join(root, ".claude", "settings.json"));
  add("user", path.join(home, ".claude", "settings.json"));
  return out;
}

/**
 * A scalar key's value after precedence: the highest scope that sets it
 * (within managed, the last drop-in file wins).
 * @param {Array<{scope: string, settings: any}>} sources @param {(s: any) => any} get
 */
function scalar(sources, get) {
  let best;
  for (const src of sources) {
    const v = get(src.settings);
    if (v === undefined) continue;
    if (!best || rank(src.scope) < rank(best.scope) || (src.scope === best.scope && src.scope === "managed")) best = { value: v, scope: src.scope };
  }
  return best;
}

/** A handler's identity, for "the same handler in more than one file runs once". */
const handlerKey = (event, matcher, h) => JSON.stringify([event, matcher ?? "", h.if ?? "", h.type ?? "command", h.command ?? h.url ?? h.prompt ?? "", !!h.async]);

/** Parse "Tool(spec)" / "Tool". @param {string} rule */
function parseRule(rule) {
  const m = /^([^()]+?)(?:\((.*)\))?$/.exec(rule.trim());
  return m ? { tool: m[1].trim(), spec: m[2] } : { tool: rule, spec: undefined };
}

/**
 * Does rule `broad` cover every call `narrow` covers? Same tool (an MCP server
 * rule covers its tools); no specifier covers all; otherwise broad's
 * specifier, * as a wildcard (legacy ":*" as " *"), matched against narrow's.
 * @param {string} broad @param {string} narrow
 */
function ruleCovers(broad, narrow) {
  if (broad === narrow) return true;
  const b = parseRule(broad);
  const n = parseRule(narrow);
  const sameTool = b.tool === n.tool || (b.tool.startsWith("mcp__") && n.tool.startsWith(`${b.tool}__`)) || (b.tool.endsWith("__*") && n.tool.startsWith(b.tool.slice(0, -1)));
  if (!sameTool) return false;
  if (b.spec === undefined || b.spec === "*" || b.spec === "") return b.tool === n.tool ? true : b.spec === undefined;
  if (n.spec === undefined) return false;
  const pat = b.spec.replace(/:\*$/, " *");
  const re = new RegExp(`^${pat.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(n.spec.replace(/:\*$/, " *"));
}

/**
 * Merge settings sources.
 * @param {Array<{scope: string, file?: string, settings: any}>} sources any order
 */
function mergeSettings(sources) {
  const srcs = [...sources].sort((a, b) => rank(a.scope) - rank(b.scope));
  const managed = srcs.filter((s) => s.scope === "managed");
  const managedFlag = (key) => scalar(managed, (s) => s?.[key])?.value === true;
  const allowManagedHooksOnly = managedFlag("allowManagedHooksOnly");
  const allowManagedPermissionRulesOnly = managedFlag("allowManagedPermissionRulesOnly");
  const disableAllHooks = scalar(srcs, (s) => s?.disableAllHooks);
  const managedDisable = scalar(managed, (s) => s?.disableAllHooks)?.value === true;

  // Hooks: entries merge across levels; identical handlers run once (kept at the highest scope).
  /** @type {Map<string, any[]>} */
  const byEvent = new Map();
  /** @type {Map<string, any>} */
  const seen = new Map();
  for (const src of srcs)
    for (const [event, entries] of Object.entries(src.settings?.hooks ?? {}))
      for (const e of Array.isArray(entries) ? entries : [])
        for (const h of e?.hooks ?? []) {
          const key = handlerKey(event, e.matcher, h);
          const dup = seen.get(key);
          if (dup) {
            if (!dup.alsoIn.includes(src.scope) && dup.scope !== src.scope) dup.alsoIn.push(src.scope);
            continue;
          }
          const isManaged = src.scope === "managed";
          let inactive;
          if (managedDisable) inactive = "disableAllHooks in managed settings";
          else if (!isManaged && disableAllHooks?.value === true) inactive = `disableAllHooks (${disableAllHooks.scope})`;
          else if (!isManaged && allowManagedHooksOnly) inactive = "allowManagedHooksOnly (managed)";
          else if (h.if && !IF_EVENTS.has(event)) inactive = `\`if\` is only evaluated on tool events`;
          const handler = {
            scope: src.scope, file: src.file, type: h.type ?? "command", command: String(h.command ?? h.url ?? h.prompt ?? ""),
            matcher: e.matcher || undefined, matcherIgnored: !!e.matcher && NO_MATCHER.has(event), if: h.if, async: !!(h.async || h.asyncRewake),
            timeout: h.timeout, alsoIn: /** @type {string[]} */ ([]), active: !inactive, inactiveReason: inactive,
          };
          seen.set(key, handler);
          if (!byEvent.has(event)) byEvent.set(event, []);
          /** @type {any[]} */ (byEvent.get(event)).push(handler);
        }
  const order = (e) => (EVENT_ORDER.includes(e) ? EVENT_ORDER.indexOf(e) : EVENT_ORDER.length);
  const hooks = [...byEvent.keys()]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((event) => ({ event, parallel: true, handlers: /** @type {any[]} */ (byEvent.get(event)) }));

  // Permissions: lists merge; per rule the highest scope that lists it, deny > ask > allow.
  /** @type {Record<"deny" | "ask" | "allow", any[]>} */
  const perms = { deny: [], ask: [], allow: [] };
  for (const effect of /** @type {const} */ (["deny", "ask", "allow"]))
    for (const src of srcs)
      for (const rule of src.settings?.permissions?.[effect] ?? []) {
        if (typeof rule !== "string") continue;
        const have = perms[effect].find((r) => r.rule === rule);
        if (have) {
          if (have.scope !== src.scope && !have.alsoIn.includes(src.scope)) have.alsoIn.push(src.scope);
          continue;
        }
        const ignored = allowManagedPermissionRulesOnly && src.scope !== "managed";
        perms[effect].push({ rule, effect, scope: src.scope, file: src.file, alsoIn: [], ignored, effective: !ignored, overriddenBy: undefined });
      }
  const live = (list) => list.filter((r) => !r.ignored);
  for (const r of perms.ask) {
    const d = live(perms.deny).find((x) => ruleCovers(x.rule, r.rule));
    if (d && !r.ignored) Object.assign(r, { effective: false, overriddenBy: { effect: "deny", rule: d.rule, scope: d.scope } });
  }
  for (const r of perms.allow) {
    if (r.ignored) continue;
    const d = live(perms.deny).find((x) => ruleCovers(x.rule, r.rule)) ?? live(perms.ask).find((x) => ruleCovers(x.rule, r.rule));
    if (d) Object.assign(r, { effective: false, overriddenBy: { effect: d.effect, rule: d.rule, scope: d.scope } });
  }
  const defaultMode = scalar(srcs, (s) => s?.permissions?.defaultMode);
  return {
    sources: srcs.map((s) => ({ scope: s.scope, file: s.file })),
    hooks,
    permissions: perms,
    defaultMode,
    disableAllHooks,
    allowManagedHooksOnly,
    allowManagedPermissionRulesOnly,
  };
}

/**
 * The decision for one tool call, the documented way: deny, then ask, then
 * allow; the first match in that order wins, specificity doesn't matter.
 * @param {ReturnType<typeof mergeSettings>} merged @param {string} call e.g. "Bash(aws s3 ls)"
 * @returns {{effect: "deny" | "ask" | "allow" | "default", rule?: string, scope?: string}}
 */
function decide(merged, call) {
  for (const effect of /** @type {const} */ (["deny", "ask", "allow"])) {
    const r = merged.permissions[effect].find((x) => !x.ignored && ruleCovers(x.rule, call));
    if (r) return { effect, rule: r.rule, scope: r.scope };
  }
  return { effect: "default" };
}

/** A command's short name: its script, or its first two words. @param {string} cmd */
const shortCmd = (cmd) => /([\w.-]+\.(?:sh|mjs|js|cjs|py|ts))\b/.exec(cmd)?.[1] ?? cmd.split(/\s+/).slice(0, 2).join(" ");

/**
 * The "Effective settings" tree as plain nodes (group / leaf) for the side bar.
 * @param {ReturnType<typeof mergeSettings>} merged
 */
function mergedTree(merged) {
  const also = (x) => x.scope + (x.alsoIn.length ? ` (also ${x.alsoIn.join(", ")})` : "");
  const events = merged.hooks.map((ev) => ({
    type: "group", label: ev.event, icon: "zap",
    description: `${ev.handlers.length} handler${ev.handlers.length === 1 ? "" : "s"}${ev.handlers.length > 1 ? ", run in parallel" : ""}`,
    children: ev.handlers.map((h) => ({
      type: "leaf", label: shortCmd(h.command), icon: h.active ? "debug-breakpoint-log" : "circle-slash", abs: h.file,
      description: [also(h), h.matcher && `[${h.matcher}]${h.matcherIgnored ? " ignored" : ""}`, h.if && `if ${h.if}`, h.async && "async", !h.active && `off: ${h.inactiveReason}`].filter(Boolean).join(" · "),
      tooltip: `${h.type}: ${h.command}\n${h.file ?? h.scope}`,
    })),
  }));
  const rules = ["deny", "ask", "allow"].flatMap((effect) => merged.permissions[effect]).map((r) => ({
    type: "leaf", label: `${r.effect} ${r.rule}`, abs: r.file,
    icon: r.ignored || !r.effective ? "circle-slash" : r.effect === "deny" ? "error" : r.effect === "ask" ? "question" : "pass",
    description: [also(r), r.ignored && "ignored: allowManagedPermissionRulesOnly", r.overriddenBy && `loses to ${r.overriddenBy.effect} ${r.overriddenBy.rule} (${r.overriddenBy.scope})`].filter(Boolean).join(" · "),
    tooltip: "Rules are evaluated deny, then ask, then allow; a deny at any level can't be allowed elsewhere.",
  }));
  if (merged.defaultMode) rules.unshift({ type: "leaf", label: `mode ${merged.defaultMode.value}`, icon: "settings-gear", description: merged.defaultMode.scope, abs: undefined, tooltip: "permissions.defaultMode" });
  const p = merged.permissions;
  return {
    type: "group", label: "Effective settings", icon: "layers",
    description: merged.sources.length ? [...new Set(merged.sources.map((s) => s.scope))].join(" > ") : "no settings files",
    tooltip: "Claude Code settings merged: managed > local > project > user. Hooks from every level run; permission lists merge.",
    children: [...events, { type: "group", label: "Permissions", icon: "shield", description: `${p.deny.length} deny · ${p.ask.length} ask · ${p.allow.length} allow`, children: rules }],
  };
}

module.exports = { SCOPES, managedDir, readSources, mergeSettings, decide, ruleCovers, mergedTree };
