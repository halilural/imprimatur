// @ts-check
// What the graph needs from an agent's tool call, kept in the repo
// (.claude/imprimatur/calls.jsonl, one line per call): the branch it was made
// on, and for Edit / Write what it asked for and whether it failed. Read from
// the transcript the first time the graph sees a finished call, then from
// here: Claude Code deletes transcripts (cleanupPeriodDays, 30 days by
// default), and the graph keeps telling the agent's change from the rest.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { callInfo } = require("./narration.js");

const CALLS = path.join(".claude", "imprimatur", "calls.jsonl");

/** A kept line's size limit (a Write holds its whole file). */
const MAX_LINE = 512 * 1024;

/** @typedef {{toolUseId: string, branch?: string, name?: string, input?: any, failed?: boolean}} Call */

/** @type {Map<string, {size: number, calls: Map<string, Call>}>} */
const cache = new Map();

/** The repo's kept calls (re-read when the file grew). @param {string} root */
function keptCalls(root) {
  const f = path.join(root, CALLS);
  let size = 0;
  let text = "";
  try {
    size = fs.statSync(f).size;
    const c = cache.get(root);
    if (c && c.size === size) return c.calls;
    text = fs.readFileSync(f, "utf8");
    size = Buffer.byteLength(text);
  } catch {
    // no file yet, or one being replaced: nothing kept
  }
  /** @type {Map<string, Call>} */
  const calls = new Map();
  if (text)
    for (const l of text.split("\n")) {
      try {
        const r = l && JSON.parse(l);
        if (r?.toolUseId) calls.set(r.toolUseId, r);
      } catch {
        // a line being written
      }
    }
  cache.set(root, { size, calls });
  return calls;
}

/**
 * A call as the graph needs it: kept, else from its transcript (and kept once
 * it has finished). undefined when neither knows it.
 * @param {string} root @param {string | undefined} transcript @param {string | undefined} toolUseId
 * @returns {Call | undefined}
 */
function callOf(root, transcript, toolUseId) {
  if (!toolUseId) return undefined;
  const kept = keptCalls(root).get(toolUseId);
  if (kept) return kept;
  const info = callInfo(transcript, toolUseId);
  if (!info) return undefined;
  /** @type {Call} */
  const call = { toolUseId, branch: info.branch, ...(info.name && { name: info.name, input: info.input, failed: info.failed }) };
  // Still running: its result (failed or not) is not known yet.
  if (!info.done) return call;
  let line = JSON.stringify(call) + "\n";
  // A huge Write is not kept: without it the edit reads as before (next edit's text).
  if (line.length > MAX_LINE) line = JSON.stringify({ toolUseId, branch: info.branch }) + "\n";
  try {
    fs.mkdirSync(path.dirname(path.join(root, CALLS)), { recursive: true });
    fs.appendFileSync(path.join(root, CALLS), line);
    // Kept in memory too: the next lookup does not read the whole file again.
    const c = cache.get(root);
    if (c) {
      c.calls.set(toolUseId, JSON.parse(line));
      c.size += Buffer.byteLength(line);
    }
  } catch {
    // read-only repo: the transcript stays the source
  }
  return call;
}

/**
 * The tool-call reader historyEdits takes (review-state.js), for one repo.
 * @param {string} root
 */
const toolCallIn = (root) => (/** @type {string | undefined} */ transcript, /** @type {string | undefined} */ id) => {
  const c = callOf(root, transcript, id);
  return c?.name ? { name: c.name, input: c.input, failed: !!c.failed } : undefined;
};

module.exports = { CALLS, callOf, toolCallIn, keptCalls };
