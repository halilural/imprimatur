// @ts-check
// Paths and lookups shared by the hook and the extension.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASELINE_DIR = path.join(".claude", "agent-review", "baseline");
const HISTORY_DIR = path.join(".claude", "agent-review", "history");

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
 * ponytail: reads the whole log; fine for documents, tail-read if logs grow large.
 * @param {string} log path of the .jsonl history @returns {string | undefined}
 */
function latestBefore(log) {
  if (!fs.existsSync(log)) return undefined;
  const lines = fs.readFileSync(log, "utf8").trimEnd().split("\n");
  try {
    return JSON.parse(lines[lines.length - 1]).before;
  } catch {
    return undefined;
  }
}

/**
 * The agent's edits to one file, newest first, like a commit log. Each edit's
 * "after" is the next edit's "before", or the current text for the latest one.
 * @param {string} log path of the .jsonl history @param {string} current current text
 * @returns {Array<{n: number, t: string, session?: string, tool?: string, before: string, after: string, added: number, removed: number}>}
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
    });
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
      return { n: i + 1, t: r.t, session: r.session, tool: r.tool, before: r.before, after, added, removed };
    })
    .reverse();
}

module.exports = { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore, historyEdits };
