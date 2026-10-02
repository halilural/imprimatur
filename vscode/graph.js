// @ts-check
// Agent Change Graph: every agent edit in a repo, newest first, one lane per
// Claude session (like branches in a git graph).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { HISTORY_DIR, historyEdits } = require("./review-state.js");

/**
 * @param {string} root repo root
 * @param {(file: string) => string | undefined} [currentText] open-editor text, else read from disk
 * @returns {{rows: Array<{file: string, n: number, t: string, session?: string, tool?: string, prompt?: string, added: number, removed: number, lane: number}>,
 *            lanes: Array<{session: string, first: number, last: number}>}}
 */
function graphRows(root, currentText = () => undefined) {
  const dir = path.join(root, HISTORY_DIR);
  if (!fs.existsSync(dir)) return { rows: [], lanes: [] };
  /** @type {ReturnType<typeof graphRows>["rows"]} */
  const rows = [];
  for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const log = path.join(ent.parentPath, ent.name);
    const file = path.relative(dir, log).slice(0, -".jsonl".length);
    const abs = path.join(root, file);
    const current = currentText(abs) ?? (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "");
    for (const e of historyEdits(log, current))
      rows.push({ file, n: e.n, t: e.t, session: e.session, tool: e.tool, prompt: e.prompt, added: e.added, removed: e.removed, lane: 0 });
  }
  rows.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
  /** @type {ReturnType<typeof graphRows>["lanes"]} */
  const lanes = [];
  rows.forEach((r, i) => {
    const key = r.session ?? "?";
    let lane = lanes.findIndex((l) => l.session === key);
    if (lane < 0) lane = lanes.push({ session: key, first: i, last: i }) - 1;
    lanes[lane].last = i;
    r.lane = lane;
  });
  return { rows, lanes };
}

module.exports = { graphRows };
