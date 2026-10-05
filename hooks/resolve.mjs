#!/usr/bin/env node
// Syncs the user's chat message to the "Waiting on you" list: which open
// steps did it settle (answered, approved, declined, said done)? waiting.mjs
// starts it in the background on UserPromptSubmit:
//
//   node resolve.mjs <waiting log> <message>
//
// A small model (vscode/model.js) picks the step numbers; if it fails, steps
// ending in "?" count as answered. Each settled step gets a "check" record
// with by: "chat"; an item closes when all its steps are ticked
// (vscode/waiting.js). The agent's side is hooks/audit.mjs.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { askModel } = require("../vscode/model.js");
const { openSteps, tickStep, labelsIn } = require("../vscode/waiting.js");

export { openSteps };

/** @param {ReturnType<typeof openSteps>} steps @param {string} text */
export function resolvePrompt(steps, text) {
  return [
    "An AI agent left these open steps for the user (questions to decide, things to do):",
    ...steps.map((s) => `${s.label}. ${s.text}`),
    "",
    "The user then wrote:",
    text,
    "",
    "Which steps does this message settle: answers, approves, declines, or says are done?",
    "A step the user only mentions, or still has to do, is not settled. A step asking for approval (merge,",
    "commit, close an issue) or for the user's own check is settled only by words about that very step:",
    '"let\'s try", "ok" about something else, or a new request, settle nothing. When unsure, keep it open.',
    "",
    "Steps are labelled with letters; numbers in the user's message refer to something else, never to a step.",
    "",
    "First, one line per step: its letter, settled or open, and the quoted evidence.",
    'Then, as the very last line, only the settled letters separated by commas, or "none".',
  ].join("\n");
}

/** The steps the model settled: the letters on its last line. @param {string} out @param {ReturnType<typeof openSteps>} steps */
export const settledIn = (out, steps) => labelsIn(out.trim().split("\n").pop() ?? "", steps);

/**
 * Tick the steps the user's message settled. @param {string} log @param {string} reply
 * @param {(prompt: string) => Promise<string>} [ask] @returns {Promise<number[]>} ticked step numbers
 */
export async function resolve(log, reply, ask = askModel) {
  const steps = openSteps(log);
  if (!steps.length || !reply.trim()) return [];
  let picked;
  try {
    picked = settledIn(await ask(resolvePrompt(steps, reply)), steps);
  } catch {
    picked = steps.filter((s) => /\?\s*\)?$/.test(s.text)).map((s) => s.n); // no model: a reply answers the questions
  }
  const note = reply.trim().split("\n")[0].slice(0, 200);
  for (const n of picked) tickStep(log, steps[n - 1], "chat", note);
  return picked;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [log, reply = ""] = process.argv.slice(2);
  resolve(log, reply)
    .catch((e) => process.stderr.write(`imprimatur resolve: ${e.message}\n`))
    .finally(() => process.exit(0));
}
