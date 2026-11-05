// @ts-check
// Fix it's proposed edits (#156): the background agent only reads; it ends its answer with an
// "imprimatur-edits" block of {file, old, new} replacements. Imprimatur checks each against the
// fix's target files and the file's current text, shows the diffs, and applies them when the
// user says so. Claude Code does not let an unattended agent edit ~/.claude, and an agent that
// cannot write anything cannot be talked into writing the wrong thing.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** The last fenced "imprimatur-edits" block's array, [] when there is none or it is not JSON. @param {string} answer */
function parseEdits(answer) {
  const blocks = [...String(answer).matchAll(/```imprimatur-edits\s*\n([\s\S]*?)\n```/g)];
  if (!blocks.length) return [];
  try {
    const v = JSON.parse(blocks.at(-1)?.[1] ?? "[]");
    return Array.isArray(v) ? v.filter((e) => e && typeof e.file === "string" && typeof e.old === "string" && typeof e.new === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The new text of each file, or why an edit was left out: a file that is not a target, an
 * old text that is empty or not found exactly once. Edits to one file apply in order.
 * @param {Array<{file: string, old: string, new: string}>} edits @param {string[]} targets
 * @param {(file: string) => string} [read]
 * @returns {{files: Map<string, {before: string, after: string}>, skipped: Array<{file: string, why: string}>}}
 */
function planEdits(edits, targets, read = (f) => fs.readFileSync(f, "utf8")) {
  const allowed = new Set(targets.map((t) => path.resolve(t)));
  /** @type {Map<string, {before: string, after: string}>} */
  const files = new Map();
  const skipped = [];
  for (const e of edits) {
    const file = path.resolve(e.file);
    if (!allowed.has(file)) {
      skipped.push({ file: e.file, why: "not one of this fix's files" });
      continue;
    }
    let cur = files.get(file);
    if (!cur) {
      try {
        const text = read(file);
        cur = { before: text, after: text };
      } catch {
        skipped.push({ file: e.file, why: "cannot be read" });
        continue;
      }
    }
    const n = e.old ? cur.after.split(e.old).length - 1 : 0;
    if (n !== 1) {
      skipped.push({ file: e.file, why: e.old ? `the old text is found ${n} times` : "no old text" });
      continue;
    }
    cur.after = cur.after.replace(e.old, () => e.new);
    files.set(file, cur);
  }
  for (const [f, c] of files) if (c.after === c.before) files.delete(f);
  return { files, skipped };
}

/** Why the agent says a finding should be dismissed: wrong for its file, intended here, caused by a third-party plugin's file, or not a file fix. */
const DISMISS = new Set(["false", "local", "plugin", "other"]);

/**
 * The last "imprimatur-dismiss" block: findings the agent says to dismiss, by their number in
 * the prompt's list (1 to count), with a reason and one line of why. Anything else is left out.
 * @param {string} answer @param {number} count @returns {Array<{n: number, reason: string, why: string}>}
 */
function parseDismissals(answer, count) {
  const blocks = [...String(answer).matchAll(/```imprimatur-dismiss\s*\n([\s\S]*?)\n```/g)];
  let v = [];
  try {
    v = JSON.parse(blocks.at(-1)?.[1] ?? "[]");
  } catch {}
  const seen = new Set();
  return (Array.isArray(v) ? v : [])
    .filter((d) => d && Number.isInteger(d.n) && d.n >= 1 && d.n <= count && DISMISS.has(d.reason) && !seen.has(d.n) && seen.add(d.n))
    .map((d) => ({ n: d.n, reason: d.reason, why: String(d.why ?? "").replace(/[\r\n]+/g, " ").slice(0, 200) }));
}

module.exports = { parseEdits, planEdits, parseDismissals };
