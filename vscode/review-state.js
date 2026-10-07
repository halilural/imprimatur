// @ts-check
// Paths and lookups shared by the hook and the extension.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASELINE_DIR = path.join(".claude", "imprimatur", "baseline");
const HISTORY_DIR = path.join(".claude", "imprimatur", "history");

/** Git top level for a path (walks up to an existing directory), resolved like fsPath. @param {string} p */
function repoRoot(p) {
  let dir = p;
  while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return path.resolve(out.trim());
  } catch {
    return undefined;
  }
}

/**
 * Text before the agent's latest edit: the `before` of the last history line.
 * Read from the end, a chunk at a time: logs keep every edit's full text and grow large.
 * @param {string} log path of the .jsonl history @returns {string | undefined}
 */
function latestBefore(log) {
  if (!fs.existsSync(log)) return undefined;
  const fd = fs.openSync(log, "r");
  try {
    const size = fs.fstatSync(fd).size;
    /** @type {Buffer[]} */
    const chunks = [];
    let pos = size;
    let len = 0;
    while (pos > 0) {
      const n = Math.min(64 * 1024, pos);
      pos -= n;
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, pos);
      chunks.unshift(buf);
      len += n;
      const all = Buffer.concat(chunks, len);
      // Past the trailing blank lines, a newline before the last line's text bounds it.
      let end = all.length;
      while (end > 0 && (all[end - 1] === 10 || all[end - 1] === 13 || all[end - 1] === 32)) end--;
      if (end === 0 && pos > 0) continue;
      const nl = all.subarray(0, end).lastIndexOf(10);
      if (nl >= 0 || pos === 0) {
        const line = all.subarray(nl + 1, end).toString("utf8");
        try {
          return JSON.parse(line).before;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The agent's edits to one file, newest first, like a commit log. Each edit's
 * "after" is the next edit's "before", or the current text for the latest one.
 * @param {string} log path of the .jsonl history @param {string} current current text
 * @returns {Array<{n: number, t: string, session?: string, tool?: string, prompt?: string, intent?: string, title?: string, transcript?: string, toolUseId?: string, branch?: string, before: string, after: string, added: number, removed: number}>}
 */
function historyEdits(log, current) {
  if (!fs.existsSync(log)) return [];
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
    })
    // Two copies of the hook (project + user settings) run in parallel and can
    // both write the same edit; same text within 2 s is one edit.
    .filter((r, i, all) => !(i > 0 && r.before === all[i - 1].before && Date.parse(r.t) - Date.parse(all[i - 1].t) < 2000));
  const { diff } = require("./diff.js");
  return rows
    .map((r, i) => {
      const after = i + 1 < rows.length ? rows[i + 1].before : current;
      let added = 0;
      let removed = 0;
      for (const h of diff(r.before, after)) {
        added += h.newEnd - h.newStart;
        removed += h.oldEnd - h.oldStart;
      }
      return { n: i + 1, t: r.t, session: r.session, tool: r.tool, prompt: r.prompt, intent: r.intent, title: r.title, transcript: r.transcript, toolUseId: r.toolUseId, branch: r.branch, before: r.before, after, added, removed };
    })
    .reverse();
}

module.exports = { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore, historyEdits };
