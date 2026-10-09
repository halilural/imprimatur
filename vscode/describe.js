// @ts-check
// Plain-words description of one agent edit, for the graph's Description column
// (#8, #63). The graph asks for it when it shows an edit nothing else describes
// (vscode/graphView.js describeShown); hooks/describe.mjs runs it by hand.
// It diffs the edit (its `before` ↔ the next edit's `before`, or the file now),
// asks a small model for one short sentence (`claude -p --model haiku`, no
// tools, no MCP, no settings: so no hooks run again) and appends
// {toolUseId, file, text} to <root>/.claude/imprimatur/descriptions.jsonl.
// Any failure leaves no line; the graph then shows the changed line.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DESCRIPTIONS = path.join(".claude", "imprimatur", "descriptions.jsonl");
const DIFF_LINES = 120;

/**
 * The edit as unified-ish diff lines ("- old", "+ new", "@@" between hunks), capped.
 * @param {string} before @param {string} after
 */
function diffText(before, after) {
  const { diff } = require("./diff.js");
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const out = [];
  for (const h of diff(before, after)) {
    out.push("@@");
    for (let i = h.oldStart; i < h.oldEnd; i++) out.push(`- ${a[i]}`);
    for (let i = h.newStart; i < h.newEnd; i++) out.push(`+ ${b[i]}`);
  }
  return out.length > DIFF_LINES ? [...out.slice(0, DIFF_LINES), `… ${out.length - DIFF_LINES} more lines`].join("\n") : out.join("\n");
}

/** @param {string} file @param {string} diff @param {string} lang */
function promptFor(file, diff, lang) {
  return [
    `An AI agent edited ${path.basename(file)}. Below is the change ("-" removed, "+" added).`,
    `In ${lang}, write ONE short sentence (at most 90 characters) saying what changed, in plain words,`,
    `as a change summary a reviewer reads in a list: what was added, removed or reworded, about what.`,
    `No file name, no quotes, no markdown, no preamble. Only the sentence.`,
    "",
    diff,
  ].join("\n");
}

/** The model's sentence, cleaned to one line. @param {string} out */
const cleanSentence = (out) => {
  const line = out.trim().split("\n").filter((l) => l.trim())[0]?.trim().replace(/^["“'`*]+|["”'`*]+$/g, "") ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/**
 * Before and after of the edit made by a tool call, from the file's history.
 * @param {string} root @param {string} file @param {string} toolUseId
 * @returns {{before: string, after: string} | undefined}
 */
function editTexts(root, file, toolUseId) {
  const { HISTORY_DIR } = require("./review-state.js");
  const log = path.join(root, HISTORY_DIR, `${file}.jsonl`);
  if (!fs.existsSync(log)) return undefined;
  const rows = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  // "#3": the file's third edit (older rows have no toolUseId).
  const i = /^#\d+$/.test(toolUseId) ? Number(toolUseId.slice(1)) - 1 : rows.findLastIndex((r) => r.toolUseId === toolUseId);
  if (i < 0 || i >= rows.length) return undefined;
  const abs = path.join(root, file);
  const after = i + 1 < rows.length ? rows[i + 1].before : fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  return { before: rows[i].before, after };
}

const { askModel } = require("./model.js");

/**
 * Describe one edit and append it to the repo's descriptions.
 * @param {string} root @param {string} file @param {string} toolUseId @param {string} lang
 * @param {(prompt: string) => Promise<string>} [ask] the model call (tests pass a fake)
 */
async function describe(root, file, toolUseId, lang, ask = askModel) {
  const texts = editTexts(root, file, toolUseId);
  if (!texts || texts.before === texts.after) return undefined;
  const text = cleanSentence(await ask(promptFor(file, diffText(texts.before, texts.after), lang)));
  if (!text) return undefined;
  const out = path.join(root, DESCRIPTIONS);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), toolUseId, file, text }) + "\n");
  return text;
}


module.exports = { DESCRIPTIONS, diffText, promptFor, cleanSentence, editTexts, describe, askModel };
