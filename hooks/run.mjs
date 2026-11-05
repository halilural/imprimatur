#!/usr/bin/env node
// One process per hook event (#118): every Imprimatur hook step for this call runs
// here, in the order vscode/hook-plan.js gives, instead of one node process per script
// (five per Bash call before). Each step is caught on its own: a failing one never stops
// the others or the agent. What the steps return is merged into one answer:
//   a block (exit 2) wins and its stderr goes out;
//   additionalContext and systemMessage texts are joined;
//   permissionDecision is the strongest (deny > ask > allow); updatedInput is kept.
// Args: the extensions a settings-file hook passes (baseline's); none from the plugin.
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** @typedef {{code?: number, stdout?: string, stderr?: string}} Out */

/**
 * The steps' answers as one.
 * @param {string} event @param {Out[]} outs @returns {Out}
 */
export function merge(event, outs) {
  const blocks = outs.filter((o) => o.code === 2);
  if (blocks.length) return { code: 2, stderr: blocks.map((o) => o.stderr ?? "").filter(Boolean).join("\n") };
  /** @type {Record<string, any>} */
  const top = {};
  /** @type {Record<string, any>} */
  const hso = {};
  const context = [];
  const messages = [];
  const RANK = { allow: 1, ask: 2, deny: 3 };
  for (const o of outs) {
    if (!o.stdout) continue;
    let j;
    try {
      j = JSON.parse(o.stdout);
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(j)) {
      if (k === "hookSpecificOutput") continue;
      if (k === "systemMessage") messages.push(v);
      else top[k] = v;
    }
    const h = j.hookSpecificOutput;
    if (!h) continue;
    for (const [k, v] of Object.entries(h)) {
      if (k === "additionalContext") context.push(v);
      else if (k === "permissionDecision") {
        if (!hso.permissionDecision || (RANK[v] ?? 0) > (RANK[hso.permissionDecision] ?? 0)) {
          hso.permissionDecision = v;
          if (h.permissionDecisionReason) hso.permissionDecisionReason = h.permissionDecisionReason;
        }
      } else if (k !== "permissionDecisionReason") hso[k] = v;
    }
  }
  if (messages.length) top.systemMessage = messages.join("\n");
  if (context.length) hso.additionalContext = context.join("\n\n");
  if (Object.keys(hso).length) top.hookSpecificOutput = { hookEventName: event, ...hso };
  const errs = outs.map((o) => o.stderr ?? "").filter(Boolean);
  return { code: 0, ...(Object.keys(top).length ? { stdout: JSON.stringify(top) } : {}), ...(errs.length ? { stderr: errs.join("\n") } : {}) };
}

/**
 * Runs the steps for one hook input. Steps are loaded only when used.
 * @param {any} data @param {string[]} [argv] @returns {Promise<Out>}
 */
export async function dispatch(data, argv = []) {
  const event = String(data.hook_event_name ?? "");
  const { stepsFor } = require("../vscode/hook-plan.js");
  const project = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
  const child = !!process.env.IMPRIMATUR_CHILD;
  /** @type {Out[]} */
  const outs = [];
  for (const step of stepsFor(event, String(data.tool_name ?? ""))) {
    try {
      if (step === "baseline") {
        // A model call started by Imprimatur itself (describe.mjs): nothing to record.
        if (!child) (await import("./baseline.mjs")).onHook(data, argv);
      } else if (step === "waiting") {
        if (!child) (await import("./waiting.mjs")).recordWaiting(data, project);
      } else if (step === "mcp") {
        if (data.session_id)
          outs.push({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Imprimatur records", updatedInput: { ...(data.tool_input ?? {}), _session: data.session_id } } }) });
      } else if (step === "process") {
        const { check, reply } = require("../vscode/process.js");
        outs.push(reply(event, check(event, data)));
      } else if (step === "ondemand") {
        // A technology the prompt names and nothing installed covers (#144): the candidates for the agent.
        if (child || process.env.IMPRIMATUR_ON_DEMAND === "off") continue;
        const root = require("../vscode/process.js").repoOf(data.cwd ?? process.cwd());
        const context = root ? require("../vscode/on-demand.js").onDemand(String(data.prompt ?? "").slice(0, 8000), root) : "";
        if (context) outs.push({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }) });
      } else if (step === "activity") {
        if (child) continue;
        const { repoOf } = require("../vscode/process.js");
        const root = repoOf(data.cwd ?? process.cwd());
        if (root) require("../vscode/activity.js").record(root, data);
      }
    } catch (e) {
      outs.push({ stderr: `imprimatur ${step}: ${e instanceof Error ? e.message : e}` });
    }
  }
  return merge(event, outs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }
  dispatch(data, process.argv.slice(2))
    .then((out) => {
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr + "\n");
      process.exit(out.code ?? 0);
    })
    .catch((e) => {
      process.stderr.write(`imprimatur run: ${e instanceof Error ? e.message : e}\n`);
      process.exit(0);
    });
}
