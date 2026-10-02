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
      marks.push({ kind: "changed", line: adds[k], oldText: o, ...wordDiff(o, nw) });
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

module.exports = { diff, wordDiff, acceptHunk };
