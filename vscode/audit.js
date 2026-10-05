// @ts-check
// Haiku keeps the "Waiting on you" list honest. After each agent turn
// (hooks/audit.mjs) it reads the agent's final message with the open steps:
// steps no longer waiting on the user are ticked (done, answered, asked again,
// or only a report), and what the message really needs from the user becomes
// a new item of short steps. The panel's Audit button runs the same review on
// the open list alone.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { askModel } = require("./model.js");
const { openSteps, tickStep, labelsIn } = require("./waiting.js");

/**
 * Lines of the agent's message it marked for the user (👉 at the line start,
 * not inside bold): its asks, verbatim, markdown stripped. @param {string} message
 */
function pointedAsks(message) {
  return message
    .split(/\r?\n/)
    .map((raw) => raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))
    .filter((l) => /^👉\s/u.test(l)) // "👉 ask", not "👉'lı" (the emoji as a word)
    .map((l) => l.replace(/^👉\s*/, "").replace(/\*\*|__|`/g, "").trim())
    .filter(Boolean);
}

/**
 * @param {ReturnType<typeof openSteps>} steps
 * @param {{message?: string, request?: string, lang?: string}} turn the agent's final message, the user's request it answered, the asks' language
 * @param {string[]} [pointed] asks the agent marked itself (then the model only settles)
 */
function auditPrompt(steps, turn, pointed = []) {
  const extract = !!turn.message && !pointed.length;
  const out = [
    "You keep the list of what an AI coding agent is waiting on the user for. You are not the agent:",
    "do not answer anyone, only judge the list.",
    "",
    "<open_steps>",
    ...(steps.length
      ? steps.flatMap((s) => [
          `${s.label}. ${s.text}`,
          ...(s.request ? [`   asked after the user wrote: ${s.request.slice(0, 160)}`] : []),
          ...(s.since ?? []).slice(-4).map((n) => `   the user wrote since: ${n.slice(0, 200)}`),
        ])
      : ["(none)"]),
    "</open_steps>",
    "",
  ];
  if (turn.message)
    out.push(
      `<user_request>${turn.request ?? "(unknown)"}</user_request>`,
      "<agent_reply>",
      turn.message,
      "</agent_reply>",
      "",
    );
  if (pointed.length) out.push("<new_asks>", ...pointed.map((a) => `- ${a}`), "</new_asks>", "(The agent's reply asks these now; they are recorded already.)", "");
  out.push(
    '1. "settled": letters of open steps that no longer wait on the user, each with clear evidence above:',
    "   the user's own words answer or decide it, the agent reports it done, a later step, a new ask or the",
    "   agent's reply asks the same thing again, or the step is only a report, not a request. A step nobody has",
    "   answered yet stays open. A step that needs the user's own check or approval (look at something, close",
    "   an issue, merge) is settled only by the user's explicit answer to that very step, or by the same ask",
    "   coming again. When unsure, keep it open: closing a real request by mistake is the worst outcome.",
  );
  if (extract)
    out.push(
      '2. "asks": what the agent_reply really needs from the user now: a decision, or something to check, test',
      `   or do. One short question or instruction each, written in ${turn.lang ?? "the same language as the agent_reply"}.`,
      "   Leave out reports and explanations. When it asks again what an open step asks, settle that old step",
      "   and put the new wording here (one entry per decision). Empty if it needs nothing.",
    );
  out.push(
    "",
    "Steps are labelled with letters; numbers in the messages refer to something else, never to a step.",
    "First, one line per open step: its letter, open or settled, and the quoted evidence.",
    `Then, as the very last line, JSON only: {"settled": [letters]${extract ? ', "asks": [strings]' : ""}}`,
  );
  return out.join("\n");
}

/** Words of a step, for comparing asks (letters and digits, 3+ long, lowercase). @param {string} s */
const words = (s) => new Set((s.toLocaleLowerCase("tr").match(/[\p{L}\p{N}'#]{3,}/gu) ?? []).map((w) => w.replace(/^'+|'+$/g, "")));

/** Share of words two asks have in common (Jaccard). @param {string} a @param {string} b */
function overlap(a, b) {
  const [x, y] = [words(a), words(b)];
  const both = [...x].filter((w) => y.has(w)).length;
  return both / (x.size + y.size - both || 1);
}

/** The same decision asked again: a new ask shares half its words with an old step. */
const ASKED_AGAIN = 0.5;

/** The model's JSON (its last line starting with "{"), checked. @param {string} out @param {ReturnType<typeof openSteps>} steps */
function parseAudit(out, steps) {
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  const r = JSON.parse((line ?? "").trim().replace(/`+$/, ""));
  const settled = labelsIn((Array.isArray(r.settled) ? r.settled : []).map(String).join(" "), steps);
  const asks = (Array.isArray(r.asks) ? r.asks : []).map((a) => String(a).trim()).filter(Boolean).slice(0, 8);
  return { settled, asks };
}

/**
 * Review a session's open steps, with the agent's latest turn when there is one.
 * Throws when the model fails (the caller falls back).
 * @param {string} log session log
 * @param {{message?: string, request?: string, title?: string, session?: string, lang?: string, at?: string}} turn at: when the turn ended (a past turn, vscode/history.js)
 * @param {(prompt: string) => Promise<string>} [ask]
 */
async function audit(log, turn = {}, ask = askModel) {
  const steps = openSteps(log);
  const pointed = turn.message ? pointedAsks(turn.message) : [];
  if (!steps.length && !turn.message) return { settled: [], asks: [] };
  // The agent marked its asks: those are the asks; the model only settles old steps.
  const res = !steps.length && pointed.length ? { settled: [], asks: [] } : parseAudit(await ask(auditPrompt(steps, turn, pointed)), steps);
  if (pointed.length) res.asks = pointed;
  const note = turn.message ? `agent: ${turn.message.trim().split("\n")[0].slice(0, 160)}` : "review";
  // Asked again in nearly the same words: the new wording replaces the old step.
  const again = steps.filter((s) => res.asks.some((a) => overlap(a, s.text) >= ASKED_AGAIN)).map((s) => s.n);
  for (const n of again) if (!res.settled.includes(n)) res.settled.push(n);
  for (const n of res.settled) tickStep(log, steps[n - 1], "audit", note, again.includes(n) ? "again" : undefined);
  if (res.asks.length) {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const item = { t: turn.at ?? new Date().toISOString(), session: turn.session ?? path.basename(log, ".jsonl"), kind: "verify", text: res.asks.join("\n") };
    fs.appendFileSync(log, JSON.stringify({ ...item, detail: turn.message?.slice(0, 4000), prompt: turn.request, title: turn.title }) + "\n");
  }
  return res;
}

module.exports = { audit, auditPrompt, parseAudit, pointedAsks, overlap };
