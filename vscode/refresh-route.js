// @ts-check
// What a change under .claude/imprimatur/ should redraw (#114). The hooks write
// there on every tool call; before this, every write outside waiting/ redrew
// everything three times (at once, 500 ms and 2 s later).
//   "edits"  copies and history of files under review: editors, lenses, preview, graph
//   "graph"  what only the panel and the counts show (waiting/, activity/, descriptions, calls)
//   "none"   the hooks' own bookkeeping, and files the extension writes itself
"use strict";
const path = require("node:path");

const BASE = path.join(".claude", "imprimatur");
/** Folders and files whose changes redraw everything. */
const EDITS = ["baseline", "history"];
/**
 * Nothing shows these, or the extension wrote them and redraws by itself:
 * pending/ (a Bash call's before state, gone after it), process.json (the
 * process hooks' notes), open-edits.json (the status line's count, written by
 * the launcher), archive/ and docs-backup/ (archiveAll and docs sync redraw),
 * todo-done.json, scanned.json, setup-history.json (the extension's own state).
 */
const NONE = ["pending", "archive", "docs-backup", "process.json", "open-edits.json", "todo-done.json", "scanned.json", "setup-history.json"];

/**
 * The route for one changed path.
 * @param {string} root the repo @param {string} file the changed path
 * @returns {"edits" | "graph" | "none"}
 */
function routeOf(root, file) {
  const rel = path.relative(path.join(root, BASE), file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "none";
  const first = rel.split(path.sep)[0];
  if (EDITS.includes(first)) return "edits";
  if (NONE.includes(first)) return "none";
  return "graph";
}

/**
 * Runs fn once, `wait` ms after the last call of a burst, and at least every
 * `maxWait` ms while calls keep coming (a long burst still draws).
 * @param {() => void} fn @param {{wait?: number, maxWait?: number, now?: () => number, set?: typeof setTimeout, clear?: typeof clearTimeout}} [o]
 */
function trailing(fn, { wait = 300, maxWait = 2000, now = Date.now, set = setTimeout, clear = clearTimeout } = {}) {
  /** @type {any} */
  let timer;
  let first = 0;
  const fire = () => {
    clear(timer);
    timer = undefined;
    first = 0;
    fn();
  };
  const call = () => {
    first ||= now();
    clear(timer);
    timer = set(fire, Math.max(0, Math.min(wait, first + maxWait - now())));
  };
  call.cancel = () => {
    clear(timer);
    timer = undefined;
    first = 0;
  };
  call.flush = () => {
    if (timer !== undefined) fire();
  };
  return call;
}

module.exports = { routeOf, trailing, EDITS, NONE };
