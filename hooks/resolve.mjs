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
// (vscode/waiting.js). A message that names a task (LATD-13977, or 13977
// alone) also weighs that task's open steps from other sessions, each ticked
// in its own log (#43). The agent's side is hooks/audit.mjs.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { askModel } = require("../vscode/model.js");
const { openSteps, tickStep, labelsIn, stepLabel } = require("../vscode/waiting.js");
const { taskOf, namesTask } = require("../vscode/tasks.js");

export { openSteps };

/** @param {Array<ReturnType<typeof openSteps>[number] & {elsewhere?: boolean}>} steps @param {string} text */
export function resolvePrompt(steps, text) {
  return [
    "An AI agent left these open steps for the user (questions to decide, things to do):",
    ...steps.map((s) => `${s.label}. ${s.elsewhere ? `(${s.task}, asked in another session) ` : ""}${s.text}`),
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

/**
 * The session's open steps, then the open steps of other sessions whose task
 * the message names, numbered on. @param {string} log @param {string} text
 */
export function stepsFor(log, text) {
  const own = openSteps(log);
  const dir = path.dirname(log);
  const others = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl") && path.join(dir, n) !== log) : [];
  const elsewhere = others
    .flatMap((n) => openSteps(path.join(dir, n)))
    .map((s) => ({ ...s, task: taskOf({ ...s, prompt: s.request }) }))
    .filter((s) => s.task && namesTask(text, s.task));
  return [
    ...own,
    ...elsewhere.map((s, k) => ({ ...s, n: own.length + k + 1, label: stepLabel(own.length + k + 1), elsewhere: true })),
  ];
}

/** The steps the model settled: the letters on its last line. @param {string} out @param {ReturnType<typeof openSteps>} steps */
export const settledIn = (out, steps) => labelsIn(out.trim().split("\n").pop() ?? "", steps);

/**
 * Tick the steps the user's message settled. @param {string} log @param {string} reply
 * @param {(prompt: string) => Promise<string>} [ask] @returns {Promise<number[]>} ticked step numbers
 */
export async function resolve(log, reply, ask = askModel) {
  const steps = stepsFor(log, reply);
  if (!steps.length || !reply.trim()) return [];
  let picked;
  try {
    picked = settledIn(await ask(resolvePrompt(steps, reply)), steps);
  } catch {
    // No model: a reply answers this session's questions; another session's steps need the model.
    picked = steps.filter((s) => !s.elsewhere && /\?\s*\)?$/.test(s.text)).map((s) => s.n);
  }
  const note = reply.trim().split("\n")[0].slice(0, 200);
  for (const n of picked) tickStep(steps[n - 1].log, steps[n - 1], "chat", note);
  return picked;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [log, reply = ""] = process.argv.slice(2);
  resolve(log, reply)
    .catch((e) => process.stderr.write(`imprimatur resolve: ${e.message}\n`))
    .finally(() => process.exit(0));
}
