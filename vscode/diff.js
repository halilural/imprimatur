// @ts-check
// Line diff with word diff inside changed lines. Plain LCS: common head and
// tail are trimmed first, so a typical agent edit leaves a small table.
// ponytail: O(n*m) LCS on the middle part, capped at MAX_CELLS; past the cap
// the middle is shown as one replaced block. Myers if that shows up in practice.
"use strict";

const MAX_CELLS = 4_000_000;

/** @template T @param {T[]} a @param {T[]} b @returns {Array<["=",number,number]|["-",number]|["+",number]>} */
function lcsScript(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  /** @type {Array<any>} */
  const out = [];
  for (let k = 0; k < head; k++) out.push(["=", k, k]);
  if (n * m > MAX_CELLS) {
    for (let i = 0; i < n; i++) out.push(["-", head + i]);
    for (let j = 0; j < m; j++) out.push(["+", head + j]);
    for (let k = 0; k < tail; k++) out.push(["=", a.length - tail + k, b.length - tail + k]);
    return out;
  }
  // dp[i][j] = LCS length of a[head+i..] and b[head+j..] (middle part)
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[head + i] === b[head + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) { out.push(["=", head + i, head + j]); i++; j++; }
    // deletions first, so old text reads before new text ("~~old~~ new")
    else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) { out.push(["-", head + i]); i++; }
    else { out.push(["+", head + j]); j++; }
  }
  for (let k = 0; k < tail; k++) out.push(["=", a.length - tail + k, b.length - tail + k]);
  return out;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * Word diff of one changed line.
 * @param {string} oldLine @param {string} newLine
 * @returns {{inserted: Array<[number, number]>, deleted: Array<{at: number, text: string}>}}
 *   inserted: [start, end) columns in newLine; deleted: old text shown at column `at`.
 */
function wordDiff(oldLine, newLine) {
  const a = oldLine.match(TOKEN) || [];
  const b = newLine.match(TOKEN) || [];
  const startsB = [];
  let col = 0;
  for (const t of b) { startsB.push(col); col += t.length; }
  /** @type {Array<[number, number]>} */
  const inserted = [];
  /** @type {Array<{at: number, text: string}>} */
  const deleted = [];
  let pending = "";
  let nextB = 0; // column in newLine where the next new token starts
  for (const op of lcsScript(a, b)) {
    if (op[0] === "-") { pending += a[op[1]]; continue; }
    if (pending) { deleted.push({ at: nextB, text: pending }); pending = ""; }
    if (op[0] === "+") {
      const s = startsB[op[1]], e = s + b[op[1]].length;
      const last = inserted[inserted.length - 1];
      if (last && last[1] === s) last[1] = e; else inserted.push([s, e]);
      nextB = e;
    } else nextB = startsB[op[2]] + b[op[2]].length;
  }
  if (pending) deleted.push({ at: newLine.length, text: pending });
  return { inserted, deleted };
}

const WORD = /[\p{L}\p{N}_]+/gu;
const words = (s) => (s.match(WORD) || []).length;

/**
 * Word marks only when a single word changed (one replaced, added or removed);
 * otherwise the whole line: the old sentence struck through, then the new one
 * highlighted. Several marked words in a rewritten sentence are unreadable.
 * @param {string} oldLine @param {string} newLine
 */
function lineOrWordDiff(oldLine, newLine) {
  const w = wordDiff(oldLine, newLine);
  const added = w.inserted.reduce((n, [s, e]) => n + words(newLine.slice(s, e)), 0);
  const removed = w.deleted.reduce((n, d) => n + words(d.text), 0);
  if (added <= 1 && removed <= 1) return w;
  // Old sentence first, struck through, then the new one (after the indent).
  const at = newLine.length - newLine.trimStart().length;
  return { inserted: [[at, newLine.length]], deleted: [{ at, text: `${oldLine.trim()} ` }] };
}

/**
 * @typedef {{kind: "added", line: number}
 *   | {kind: "changed", line: number, oldText: string, inserted: Array<[number, number]>, deleted: Array<{at: number, text: string}>}
 *   | {kind: "deleted", afterLine: number, oldLines: string[]}} Mark
 * afterLine is the new-file line the deletion follows (-1 = before the first line).
 * @typedef {{oldStart: number, oldEnd: number, newStart: number, newEnd: number, marks: Mark[]}} Hunk
 */

// CRLF and LF compare equal: an EOL switch is not an agent change.
/** @param {string} text */
const lines = (text) => text.split(/\r?\n/);

/** @param {string} oldText @param {string} newText @returns {Hunk[]} */
function diff(oldText, newText) {
  const a = lines(oldText);
  const b = lines(newText);
  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {number[]} */ let dels = [];
  /** @type {number[]} */ let adds = [];
  let oi = 0, ni = 0; // next old / new line after the last equal pair
  const flush = () => {
    if (!dels.length && !adds.length) return;
    /** @type {Mark[]} */
    const marks = [];
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      const o = a[dels[k]], nw = b[adds[k]];
      marks.push({ kind: "changed", line: adds[k], oldText: o, ...lineOrWordDiff(o, nw) });
    }
    for (let k = pairs; k < adds.length; k++) marks.push({ kind: "added", line: adds[k] });
    if (dels.length > pairs) {
      const after = pairs ? adds[pairs - 1] : ni - 1;
      marks.push({ kind: "deleted", afterLine: after, oldLines: dels.slice(pairs).map((i) => a[i]) });
    }
    hunks.push({ oldStart: oi, oldEnd: oi + dels.length, newStart: ni, newEnd: ni + adds.length, marks });
    dels = []; adds = [];
  };
  for (const op of lcsScript(a, b)) {
    if (op[0] === "-") dels.push(op[1]);
    else if (op[0] === "+") adds.push(op[1]);
    else { flush(); oi = op[1] + 1; ni = op[2] + 1; }
  }
  flush();
  return hunks;
}

/**
 * Baseline with one hunk accepted: its old lines replaced by the new ones.
 * @param {string} oldText @param {string} newText @param {Hunk} hunk
 */
function acceptHunk(oldText, newText, hunk) {
  const a = lines(oldText);
  const b = lines(newText);
  a.splice(hunk.oldStart, hunk.oldEnd - hunk.oldStart, ...b.slice(hunk.newStart, hunk.newEnd));
  return a.join("\n");
}

/**
 * Agent changes since the copy, each mark flagged `fresh` when it is not staged
 * yet: the line also differs between the staged text and the current text.
 * Staged-only changes are reviewed but not committed. No staged text (file not
 * in the index) means everything is fresh.
 * ponytail: freshness is per line; a line with both staged and new words counts as fresh.
 * @param {string} base copy taken before the agent's first edit
 * @param {string | undefined} staged index text
 * @param {string} current editor text
 * @returns {Array<Hunk & {fresh: boolean, marks: Array<Mark & {fresh: boolean}>}>}
 */
function review(base, staged, current) {
  const freshLines = new Set();
  const freshDeletes = new Set();
  if (staged !== undefined)
    for (const h of diff(staged, current))
      for (const m of h.marks) (m.kind === "deleted" ? freshDeletes.add(m.afterLine) : freshLines.add(m.line));
  // Changes inside fenced code blocks are not marked (user, #28).
  const codeNew = codeLines(current);
  const codeOld = codeLines(base);
  const inCode = (h, m) =>
    m.kind === "deleted"
      ? m.oldLines.every((_, k) => codeOld.has(h.oldEnd - m.oldLines.length + k))
      : codeNew.has(m.line);
  return diff(base, current).flatMap((h) => {
    const marks = h.marks
      .filter((m) => !inCode(h, m))
      .map((m) => ({
        ...m,
        fresh: staged === undefined || (m.kind === "deleted" ? freshDeletes.has(m.afterLine) : freshLines.has(m.line)),
      }));
    return marks.length ? [{ ...h, marks, fresh: marks.some((m) => m.fresh) }] : [];
  });
}

/**
 * Line numbers inside Markdown fenced code blocks (``` or ~~~), fence lines included.
 * An unclosed fence runs to the end of the text, as in CommonMark.
 * @param {string} text @returns {Set<number>}
 */
function codeLines(text) {
  const out = new Set();
  /** @type {{ch: string, len: number} | undefined} */
  let open;
  lines(text).forEach((l, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (open) {
      out.add(i);
      if (f && f[1][0] === open.ch && f[1].length >= open.len && l.trim() === f[1]) open = undefined;
    } else if (f) {
      open = { ch: f[1][0], len: f[1].length };
      out.add(i);
    }
  });
  return out;
}

/**
 * Baseline with only new-text lines [start, end) accepted: added lines in the
 * range come in, deleted lines at the range go out, everything else stays as
 * it was. Blank lines right next to the range go with it, so a paragraph's
 * surrounding blank lines do not linger as a change. One pass, no cascade.
 * @param {string} oldText @param {string} newText @param {number} start @param {number} end
 */
function acceptLines(oldText, newText, start, end) {
  const a = lines(oldText);
  const b = lines(newText);
  const blank = (l) => l.trim() === "";
  const take = (j, l) => (j >= start && j < end) || (blank(l) && (j === start - 1 || j === end));
  const out = [];
  /** @type {number[]} */ let dels = [];
  /** @type {number[]} */ let adds = [];
  let ni = 0; // new-text line where the current run starts
  const flush = () => {
    // Same pairing as diff(): dels[k] became adds[k] (a changed line).
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) out.push(take(adds[k], b[adds[k]]) ? b[adds[k]] : a[dels[k]]);
    for (let k = pairs; k < adds.length; k++) if (take(adds[k], b[adds[k]])) out.push(b[adds[k]]);
    // Extra deletions sit after the last new line of the run.
    const at = pairs ? adds[pairs - 1] : ni - 1;
    for (let k = pairs; k < dels.length; k++) {
      const gone = take(at, b[at] ?? "") || take(at + 1, a[dels[k]]);
      if (!gone) out.push(a[dels[k]]);
    }
    dels = [];
    adds = [];
  };
  for (const op of lcsScript(a, b)) {
    if (op[0] === "-") dels.push(op[1]);
    else if (op[0] === "+") adds.push(op[1]);
    else {
      flush();
      out.push(a[op[1]]);
      ni = op[2] + 1;
    }
  }
  flush();
  return out.join("\n");
}

module.exports = { diff, wordDiff, lineOrWordDiff, acceptHunk, acceptLines, review, codeLines };
