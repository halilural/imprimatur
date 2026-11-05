// @ts-check
// Which Imprimatur hook work runs for an event and a tool (#118). One list for the
// dispatcher (hooks/run.mjs runs the work in one process) and for the hook settings
// (setup.mjs wanted(), the plugin's hooks.json): one entry per event instead of one
// process per script. Tool tests are anchored, whatever Claude Code's matcher does.
"use strict";

/** Imprimatur's own MCP tools, under the settings server name or the plugin's (#67). @param {string} t */
const imprimaturTool = (t) => /^mcp__(?:plugin_imprimatur_)?imprimatur__/.test(t);
/** The MCP tools whose writes the process checks look at after the call. @param {string} t */
const recordWrite = (t) => imprimaturTool(t) && /__(?:task_upsert|record_add|record_update)$/.test(t);
/** @param {string[]} names */
const oneOf = (names) => (/** @type {string} */ t) => names.includes(t);

/**
 * @typedef {"baseline" | "waiting" | "mcp" | "process" | "activity" | "ondemand"} Work
 * @typedef {{work: Work, tools?: (tool: string) => boolean}} Step
 */
/** Per event, the work in order; `tools` limits a step to some tools (tool events only). @type {Record<string, Step[]>} */
const PLAN = {
  PreToolUse: [
    { work: "baseline", tools: oneOf(["Edit", "Write", "Bash"]) },
    { work: "waiting", tools: oneOf(["AskUserQuestion"]) },
    { work: "mcp", tools: imprimaturTool },
    { work: "process", tools: oneOf(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) },
  ],
  PostToolUse: [
    { work: "baseline", tools: oneOf(["Bash"]) },
    { work: "waiting", tools: oneOf(["AskUserQuestion"]) },
    { work: "process", tools: (t) => ["Edit", "Write", "MultiEdit", "ExitPlanMode", "Bash"].includes(t) || recordWrite(t) },
  ],
  PostToolUseFailure: [{ work: "baseline", tools: oneOf(["Bash"]) }],
  PermissionRequest: [{ work: "waiting" }],
  Notification: [{ work: "waiting" }],
  UserPromptSubmit: [{ work: "waiting" }, { work: "ondemand" }],
  SessionStart: [{ work: "process" }],
  Stop: [{ work: "waiting" }, { work: "process" }],
};

/** Events whose every tool call gets an activity row (#55). */
const ACTIVITY_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);

/**
 * The work for one hook call. On a tool event that runs the dispatcher anyway, the
 * activity row is written there too; for every other tool, the async activity hook does.
 * @param {string} event @param {string} [tool] @returns {Work[]}
 */
function stepsFor(event, tool = "") {
  const steps = (PLAN[event] ?? []).filter((s) => !s.tools || s.tools(tool)).map((s) => s.work);
  if (steps.length && ACTIVITY_EVENTS.has(event)) steps.push("activity");
  return steps;
}

/** Whether the async activity hook (hooks/activity.mjs) writes this call's row: the dispatcher does not run for it. @param {string} event @param {string} tool */
const activityHookWrites = (event, tool) => ACTIVITY_EVENTS.has(event) && !stepsFor(event, tool).includes("activity");

/**
 * The settings matcher per event: every tool a step names, as Claude Code's regex
 * matcher; undefined for events without tools or a step that takes every call.
 * plugin: the MCP names under the plugin's server too.
 * @param {string} event @param {{plugin?: boolean}} [o] @returns {string | undefined}
 */
function matcherFor(event, { plugin = false } = {}) {
  const NAMES = {
    PreToolUse: ["Edit", "Write", "Bash", "MultiEdit", "NotebookEdit", "AskUserQuestion", "mcp__imprimatur__.*"],
    PostToolUse: ["Edit", "Write", "MultiEdit", "ExitPlanMode", "Bash", "AskUserQuestion", "mcp__imprimatur__task_upsert", "mcp__imprimatur__record_add", "mcp__imprimatur__record_update"],
    PostToolUseFailure: ["Bash"],
    PermissionRequest: ["*"],
    Notification: ["agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"],
  };
  /** @type {string[] | undefined} */
  const names = /** @type {any} */ (NAMES)[event];
  if (!names) return undefined;
  if (!plugin) return names.join("|");
  return names.flatMap((n) => (n.startsWith("mcp__imprimatur__") ? [n, n.replace("mcp__imprimatur__", "mcp__plugin_imprimatur_imprimatur__")] : [n])).join("|");
}

/** The events the dispatcher is installed on. */
const EVENTS = Object.keys(PLAN);

module.exports = { PLAN, EVENTS, stepsFor, activityHookWrites, matcherFor, imprimaturTool, recordWrite };
