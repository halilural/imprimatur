// @ts-check
// Line diffs for the panel's updates (#115, step 2). The extension keeps the page it
// sent last; a new page goes as the lines that changed: ops of [keep, delete, insert[]].
// The page applies them to its own copy (applyOps, the same function, inlined into
// its script) and draws through its usual update. A typical change is a few KB where
// the whole page was 380-840 KB.
"use strict";

/** @typedef {Array<[number, number, string[]]>} Ops */

/**
 * The ops that turn lines a into lines b, or undefined when they differ in more than
 * maxD lines (the caller sends the whole page). Myers' O(ND) diff over the lines
 * between the common head and tail.
 * @param {string[]} a @param {string[]} b @param {number} [maxD]
 * @returns {Ops | undefined}
 */
function diffLines(a, b, maxD = 2000) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  /** @type {Ops} */
  const ops = [];
  if (!A.length && !B.length) return ops;
  const script = myers(A, B, maxD);
  if (!script) return undefined;
  // script: one char per step, "=" keep, "-" delete from A, "+" insert from B.
  let keep = head;
  let del = 0;
  /** @type {string[]} */
  let ins = [];
  let j = 0;
  const flush = () => {
    if (del || ins.length) {
      ops.push([keep, del, ins]);
      keep = 0;
      del = 0;
      ins = [];
    }
  };
  for (const s of script) {
    if (s === "=") {
      flush();
      keep++;
      j++;
    } else if (s === "-") del++;
    else ins.push(B[j++]);
  }
  flush();
  return ops;
}

/**
 * The edit script from A to B, or undefined past maxD differences.
 * @param {string[]} A @param {string[]} B @param {number} maxD
 * @returns {string[] | undefined}
 */
function myers(A, B, maxD) {
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  /** @type {Int32Array[]} */
  const trace = [];
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, A, B, d, off);
    }
  }
  return undefined;
}

/** @param {Int32Array[]} trace @param {string[]} A @param {string[]} B @param {number} d @param {number} off */
function backtrack(trace, A, B, d, off) {
  /** @type {string[]} */
  const out = [];
  let x = A.length;
  let y = B.length;
  for (let D = d; D > 0; D--) {
    const v = trace[D];
    const kk = x - y;
    const down = kk === -D || (kk !== D && v[off + kk - 1] < v[off + kk + 1]);
    const prevK = down ? kk + 1 : kk - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push("=");
      x--;
      y--;
    }
    out.push(down ? "+" : "-");
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    out.push("=");
    x--;
    y--;
  }
  return out.reverse();
}

/**
 * Lines with the ops applied. Kept free of closures and modern syntax the page
 * might lack: its source is inlined into the panel's script.
 * @param {string[]} lines @param {Ops} ops @returns {string[]}
 */
function applyOps(lines, ops) {
  var out = [];
  var p = 0;
  for (var i = 0; i < ops.length; i++) {
    var keep = ops[i][0], del = ops[i][1], ins = ops[i][2];
    for (var a = 0; a < keep; a++) out.push(lines[p + a]);
    p += keep + del;
    for (var b = 0; b < ins.length; b++) out.push(ins[b]);
  }
  for (; p < lines.length; p++) out.push(lines[p]);
  return out;
}

/** The size of the ops as posted, in characters (about bytes). @param {Ops} ops */
const opsSize = (ops) => ops.reduce((n, [, , ins]) => n + 12 + ins.reduce((m, l) => m + l.length + 3, 0), 0);

module.exports = { diffLines, applyOps, opsSize };
