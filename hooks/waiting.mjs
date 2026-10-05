#!/usr/bin/env node
// Claude Code hook: records what the agent waits on the user for, in
// <root>/.claude/imprimatur/waiting/<session>.jsonl, for the extension's
// "Waiting on you" tab. Events:
// - PreToolUse AskUserQuestion: a question (and its options);
// - PermissionRequest: a command or tool waiting for the user's OK;
// - Notification agent_needs_input / elicitation_dialog: other input;
// - Stop: lines of the final message that ask something ("?", "test et", "shall I");
// - UserPromptSubmit, PostToolUse AskUserQuestion: the user's answer.
// Every record closes the session's earlier open items (see vscode/waiting.js).
//
//   node waiting.mjs
//
// Never blocks: every path ends in exit 0.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Loaded on use, inside the caller's try: a missing module must not fail the hook.
const require = createRequire(import.meta.url);

const TEXT_MAX = 1500;
const DETAIL_MAX = 4000;
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Asks in the agent's own words, Turkish and English. Matched lowercase.
// Actions are things the user has to go and do (they stay open until done);
// the rest only want an answer.
const ACTION_PHRASES = [
  "kontrol et", "kontrol eder misin", "test et", "test eder misin", "doğrula", "dener misin", "deneyebilir misin", "dene", "bakar mısın",
  "reload window", "yeniden yükle", "can you", "could you",
  "please verify", "please check", "please test", "please run", "please try",
];
const ANSWER_PHRASES = [
  "onayla", "onaylar mısın", "ister misin", "ister misiniz", "söylersen", "haber ver",
  "should i", "shall i", "want me to", "do you want", "would you like", "please confirm", "let me know",
];
/** @param {string} lower @param {string[]} phrases */
const hasPhrase = (lower, phrases) => phrases.some((p) => new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, "u").test(lower));

/**
 * Lines of a final message that ask the user something, markdown stripped.
 * Code blocks and table rows are skipped. @param {string} message
 * @returns {{lines: string[], question: boolean, action: boolean}}
 */
export function asksIn(message) {
  const lines = [];
  let question = false;
  let action = false;
  let fence = false;
  for (const raw of message.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (fence || /^\s*\|/.test(raw)) continue;
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, "").replace(/\*\*|__|`/g, "").trim();
    if (!line) continue;
    // 👉 marks a line the agent means for the user, whatever its wording.
    if (line.startsWith("👉")) {
      lines.push(line.replace(/^👉\s*/, ""));
      action = true;
      continue;
    }
    const q = /\?\s*\)?$/.test(line);
    // Quoted text names a phrase, it does not ask; a phrase must end a word
    // ("kontrol et", not "kontrol ettim").
    const lower = ` ${line.replace(/"[^"]*"|“[^”]*”/g, " ").toLocaleLowerCase("tr")} `;
    const act = hasPhrase(lower, ACTION_PHRASES);
    if (q || act || hasPhrase(lower, ANSWER_PHRASES)) {
      lines.push(line);
      question ||= q;
      action ||= act;
    }
  }
  return { lines, question, action };
}

/** The user's answers in an AskUserQuestion result, as one line. @param {any} res */
function answerText(res) {
  if (res == null) return undefined;
  if (typeof res === "string") return res;
  const answers = res.answers ?? res.tool_response?.answers;
  if (answers && typeof answers === "object") return Object.values(answers).join(" · ");
  return JSON.stringify(res);
}

/**
 * The record a hook event writes, or undefined when it writes none.
 * @param {any} data hook input @returns {{kind: string, text?: string, detail?: string, answer?: string, closeOnly?: boolean} | undefined}
 */
export function recordOf(data) {
  const ev = data.hook_event_name;
  if (ev === "PreToolUse" && data.tool_name === "AskUserQuestion") {
    const qs = Array.isArray(data.tool_input?.questions) ? data.tool_input.questions : [];
    const text = qs.map((q) => q.question).filter(Boolean).join("\n");
    const detail = qs
      .map((q) => [q.question, ...(q.options ?? []).map((o) => `  • ${o.label}${o.description ? ` — ${o.description}` : ""}`)].join("\n"))
      .join("\n\n");
    return { kind: "question", text, detail };
  }
  if (ev === "PostToolUse" && data.tool_name === "AskUserQuestion")
    return { kind: "answer", answer: answerText(data.tool_response ?? data.tool_output), closeOnly: true };
  // AskUserQuestion also asks permission to show itself: already a question.
  if (ev === "PermissionRequest" && data.tool_name !== "AskUserQuestion") {
    const input = data.tool_input ?? {};
    const what = input.command ?? input.file_path ?? input.url ?? input.pattern ?? JSON.stringify(input);
    return { kind: "command", text: `${data.tool_name}: ${String(what).split("\n")[0]}`, detail: input.description ? `${input.description}\n\n${what}` : String(what) };
  }
  if (ev === "Notification" && ["agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"].includes(data.notification_type))
    return { kind: "input", text: String(data.message ?? data.notification_type) };
  if (ev === "Stop") {
    const message = String(data.last_assistant_message ?? "");
    const { lines, action } = asksIn(message);
    if (!lines.length) return { kind: "step", closeOnly: true };
    // Something to go and do stays open past the next prompt (vscode/waiting.js).
    return { kind: action ? "verify" : "question", text: lines.join("\n"), detail: message };
  }
  if (ev === "UserPromptSubmit") {
    const prompt = String(data.prompt ?? data.prompt_text ?? "").trim();
    return { kind: "answer", answer: prompt.split("\n")[0], closeOnly: true };
  }
  return undefined;
}

/**
 * Append the event's record to the session's log. Records that only close
 * (an answer, a quiet turn end) are written only when the session has a log.
 * @param {any} data @param {string} project @returns {string | undefined} the log written
 */
export function recordWaiting(data, project) {
  const rec = recordOf(data);
  const session = String(data.session_id ?? "").replace(/[^\w-]/g, "");
  if (!rec || !session) return undefined;
  const { repoRoot } = require("../vscode/review-state.js");
  const { WAITING_DIR } = require("../vscode/waiting.js");
  const { transcriptInfo } = require("./baseline.mjs");
  const root = repoRoot(path.resolve(project)) ?? path.resolve(project);
  const log = path.join(root, WAITING_DIR, `${session}.jsonl`);
  if (rec.closeOnly && !fs.existsSync(log)) return undefined;
  const row = { t: new Date().toISOString(), session: data.session_id, kind: rec.kind };
  if (rec.text) row.text = cap(rec.text, TEXT_MAX);
  if (rec.detail && rec.detail !== rec.text) row.detail = cap(rec.detail, DETAIL_MAX);
  if (rec.answer) row.answer = cap(rec.answer, TEXT_MAX);
  if (!rec.closeOnly) {
    const { prompt, title } = transcriptInfo(data.transcript_path);
    Object.assign(row, { prompt, title });
  }
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify(row) + "\n");
  return log;
}

// IMPRIMATUR_CHILD: a model call started by describe.mjs; nothing to record.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !process.env.IMPRIMATUR_CHILD) {
  process.on("uncaughtException", (e) => {
    process.stderr.write(`imprimatur waiting: ${e.message}\n`);
    process.exit(0);
  });
  let input = "";
  process.stdin.on("error", () => process.exit(0));
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input || "{}");
      recordWaiting(data, process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd());
    } catch (e) {
      process.stderr.write(`imprimatur waiting: ${e.message}\n`);
    }
    process.exit(0);
  });
}
