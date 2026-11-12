// @ts-check
// Where did this line come from (#215): from a line of a file to the recorded agent edit that
// wrote it, with its time, session, tool, prompt and ticket. The newest edit whose lines still
// read there as it wrote them owns the line (graph.js spotsOf: a later rewrite takes it). An edit
// outside the agent's calls (by hand, git, a hook) is not the agent's. Nothing is written: git-ai's
// notes are an export for later.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { HISTORY_DIR, historyEdits } = require("./review-state.js");
const { dataPath } = require("./data-dir.js");

/**
 * @param {string} root the repo @param {string} rel the file, repo-relative @param {string} current its text now
 * @param {number} line 0-based
 * @returns {{t: string, session?: string, tool?: string, prompt?: string, intent?: string, title?: string, branch?: string, ticket?: string, n: number} | undefined}
 */
function lineOrigin(root, rel, current, line) {
  const log = path.join(dataPath(root, HISTORY_DIR), `${rel}.jsonl`);
  if (!fs.existsSync(log)) return undefined;
  const { spotsOf, taskOfBranch } = require("./graph.js");
  const edits = historyEdits(log, current).filter((e) => !e.outside && e.after !== e.before);
  for (const e of edits.sort((a, b) => b.n - a.n)) {
    if (!spotsOf(e, current).some(([a, b]) => line >= a && line < b)) continue;
    return { n: e.n, t: e.t, session: e.session, tool: e.tool, prompt: e.prompt, intent: e.intent, title: e.title, branch: e.branch, ticket: e.branch ? taskOfBranch(e.branch) : undefined };
  }
  return undefined;
}

module.exports = { lineOrigin };
