#!/usr/bin/env node
// Plain-words description of one agent edit, for the graph's Description
// column. baseline.mjs starts it in the background after it records an edit:
//
//   node describe.mjs <root> <file relative to root> <toolUseId | #n> [language]
//
// It waits for the edit to land, diffs the edit (its `before` ↔ the next
// edit's `before`, or the file now), asks a small model for one short sentence
// (`claude -p --model haiku`, no tools, no MCP, no settings: so no hooks run
// again), and appends {toolUseId, file, text} to
// <root>/.claude/imprimatur/descriptions.jsonl. Any failure leaves no line;
// the graph then falls back to the agent's words or the changed line.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export const DESCRIPTIONS = path.join(".claude", "imprimatur", "descriptions.jsonl");
const DIFF_LINES = 120;
const WAIT_MS = 1000;
const LAND_MS = 120_000; // an edit waiting for the user's permission lands late
const TIMEOUT_MS = 60_000;

/**
 * The edit as unified-ish diff lines ("- old", "+ new", "@@" between hunks), capped.
 * @param {string} before @param {string} after
 */
export function diffText(before, after) {
  const { diff } = require("../vscode/diff.js");
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
export function promptFor(file, diff, lang) {
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
export const cleanSentence = (out) => {
  const line = out.trim().split("\n").filter((l) => l.trim())[0]?.trim().replace(/^["“'`*]+|["”'`*]+$/g, "") ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/**
 * Before and after of the edit made by a tool call, from the file's history.
 * @param {string} root @param {string} file @param {string} toolUseId
 * @returns {{before: string, after: string} | undefined}
 */
export function editTexts(root, file, toolUseId) {
  const { HISTORY_DIR } = require("../vscode/review-state.js");
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

/** @param {string} prompt @returns {Promise<string>} */
function askModel(prompt) {
  const args = ["-p", "--model", "haiku", "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--no-session-persistence", "--disable-slash-commands", prompt];
  return new Promise((resolve, reject) =>
    execFile("claude", args, { cwd: os.tmpdir(), timeout: TIMEOUT_MS, env: { ...process.env, IMPRIMATUR_CHILD: "1" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );
}

/**
 * Describe one edit and append it to the repo's descriptions.
 * @param {string} root @param {string} file @param {string} toolUseId @param {string} lang
 * @param {(prompt: string) => Promise<string>} [ask] the model call (tests pass a fake)
 */
export async function describe(root, file, toolUseId, lang, ask = askModel) {
  const texts = editTexts(root, file, toolUseId);
  if (!texts || texts.before === texts.after) return undefined;
  const text = cleanSentence(await ask(promptFor(file, diffText(texts.before, texts.after), lang)));
  if (!text) return undefined;
  const out = path.join(root, DESCRIPTIONS);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), toolUseId, file, text }) + "\n");
  return text;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, file, toolUseId, lang = "English"] = process.argv.slice(2);
  // The hook starts this before the edit lands (PreToolUse): wait until it has.
  const start = Date.now();
  const poll = () => {
    const t = editTexts(root, file, toolUseId);
    if (t && t.before === t.after && Date.now() - start < LAND_MS) return void setTimeout(poll, WAIT_MS);
    describe(root, file, toolUseId, lang)
      .catch((e) => process.stderr.write(`imprimatur describe: ${e.message}\n`))
      .finally(() => process.exit(0));
  };
  setTimeout(poll, WAIT_MS);
}
