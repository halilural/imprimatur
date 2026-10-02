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

module.exports = { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore };
