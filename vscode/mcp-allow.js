// @ts-check
// The allow rule for Imprimatur's MCP server (#113). In auto mode every MCP call
// without an allow rule waits for Claude Code's permission classifier: 5.5 s on
// average in one day's log, while the server answers in 5-108 ms. A rule naming
// the server (no tool) allows all its tools and skips the classifier:
//   https://code.claude.com/docs/en/permissions
// The server has two names: "imprimatur" from `npm run setup` (user scope) and
// "plugin_imprimatur_imprimatur" from the plugin (#67).
"use strict";
const os = require("node:os");
const path = require("node:path");
const { readSources, mergeSettings, decide } = require("./setup-merged.js");

/** The allow rule per install. */
const ALLOW = { settings: "mcp__imprimatur", plugin: "mcp__plugin_imprimatur_imprimatur" };
/** Imprimatur's own audit rule id (not agnix's). */
const RULE = "IMP-MCP-001";
/** A tool call to test the effective rules with, per install. */
const PROBE = { settings: "mcp__imprimatur__task_get", plugin: "mcp__plugin_imprimatur_imprimatur__task_get" };

/**
 * Settings with the allow rule in permissions.allow. Pure: returns a copy and
 * the change (undefined when a rule already covers the server).
 * @param {any} settings @param {string} rule
 * @returns {{settings: any, change: string | undefined}}
 */
function mergeAllow(settings, rule) {
  const out = structuredClone(settings ?? {});
  const allow = out.permissions?.allow;
  if (Array.isArray(allow) && allow.some((r) => r === rule || r === `${rule}__*`)) return { settings: out, change: undefined };
  out.permissions ??= {};
  out.permissions.allow = [...(Array.isArray(allow) ? allow : []), rule];
  return { settings: out, change: `added   permissions.allow "${rule}" (auto mode skips the permission check for Imprimatur's MCP calls)` };
}

/**
 * The effective decision for Imprimatur's MCP calls in a repo: user, project,
 * local and managed settings merged. Allowed when either server name is.
 * @param {{root: string, home?: string, managedDir?: string}} where
 * @returns {{allowed: boolean, effect: string, rule?: string, scope?: string}}
 */
function mcpDecision({ root, home = os.homedir(), managedDir }) {
  const merged = mergeSettings(readSources({ root, home, ...(managedDir ? { managedDir } : {}) }));
  const ds = Object.values(PROBE).map((call) => decide(merged, call));
  const hit = ds.find((d) => d.effect === "allow") ?? ds.find((d) => d.effect !== "default") ?? ds[0];
  return { allowed: hit.effect === "allow", ...hit };
}

/**
 * An agnix-shaped diagnostic when Imprimatur's MCP calls have no allow rule;
 * undefined when they have one, or when a deny or ask rule decides them on
 * purpose (that choice is the user's).
 * @param {{root: string, home?: string, managedDir?: string}} where
 */
function allowDiagnostic(where) {
  const d = mcpDecision(where);
  if (d.allowed || d.effect !== "default") return undefined;
  const file = path.join(where.home ?? os.homedir(), ".claude", "settings.json");
  return {
    level: "warning",
    rule: RULE,
    file,
    line: 1,
    category: "permissions",
    applies_to_tool: "claude-code",
    message: "No allow rule for Imprimatur's MCP server: in auto mode each call waits for the permission check (5.5 s on average, against 5-108 ms for the call)",
    suggestion: `Run \`npm run setup\` in the Imprimatur checkout, or add "${ALLOW.settings}" (or "${ALLOW.plugin}" with the plugin) to permissions.allow in ~/.claude/settings.json.`,
  };
}

/** The audit rule's explanation, in agnix explain's shape (agnix does not know it). */
const RULE_INFO = {
  name: "Allow rule for Imprimatur's MCP server",
  evidence: { source_type: "imprimatur", source_urls: ["https://code.claude.com/docs/en/permissions", "https://code.claude.com/docs/en/permission-modes"] },
};

module.exports = { ALLOW, RULE, RULE_INFO, PROBE, mergeAllow, mcpDecision, allowDiagnostic };
