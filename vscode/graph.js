// @ts-check
// Agent Change Graph: every agent edit in a repo, newest first, one lane per
// Claude session (like branches in a git graph). An edit is accepted when none
// of its lines still left in the file is an open change under review.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { BASELINE_DIR, HISTORY_DIR, historyEdits, latestBefore } = require("./review-state.js");
const { diff, review, acceptLines } = require("./diff.js");
const { narrationOf } = require("./narration.js");

/**
 * Where a line boundary of `a` lands in `b` (hunks = diff(a, b)); undefined when
 * a later change replaced it. @param {number} p @param {import("./diff.js").Hunk[]} hunks
 */
function mapBoundary(p, hunks) {
  let delta = 0;
  for (const h of hunks) {
    if (p <= h.oldStart) break;
    if (p < h.oldEnd) return undefined;
    delta += h.newEnd - h.newStart - (h.oldEnd - h.oldStart);
  }
  return p + delta;
}

/**
 * Which of one file's edits are accepted: their changed lines that survive to
 * `current` touch no open review hunk (review copy ↔ current).
 * @param {ReturnType<typeof historyEdits>} edits @param {string | undefined} copy @param {string | undefined} staged @param {string} current
 * @returns {(e: ReturnType<typeof historyEdits>[number]) => boolean}
 */
function acceptedOf(edits, copy, staged, current) {
  // No copy: Accept all removed it, nothing is under review.
  const open = copy === undefined ? [] : review(copy, staged, current);
  if (!open.length) return () => true;
  return (e) =>
    spotsOf(e, current).every(([ms, mt]) => !open.some((o) => (mt > ms ? ms < o.newEnd && mt > o.newStart : ms >= o.newStart && ms <= o.newEnd)));
}

/**
 * The edit's lines in `current`, as [start, end) line ranges: lines it wrote
 * (one range each), or [p, p) where it deleted some. Lines a later edit
 * rewrote belong to that edit and are left out.
 * @param {{before: string, after: string}} e @param {string} current @returns {Array<[number, number]>}
 */
function spotsOf(e, current) {
  const later = diff(e.after, current);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const h of diff(e.before, e.after)) {
    const spots = Array.from({ length: h.newEnd - h.newStart }, (_, k) => [h.newStart + k, h.newStart + k + 1]);
    // More lines gone than written: the rest is a deletion after the last one.
    if (h.oldEnd - h.oldStart > h.newEnd - h.newStart) spots.push([h.newEnd, h.newEnd]);
    for (const [s, t] of spots) {
      const [ms, mt] = [mapBoundary(s, later), mapBoundary(t, later)];
      if (ms === undefined || mt === undefined || (t > s && mt - ms !== t - s)) continue;
      out.push([ms, mt]);
    }
  }
  return out;
}

/**
 * The review copy with one edit accepted: each of its surviving lines goes in
 * (acceptLines); a deletion goes with the line before it, as in the editor.
 * @param {string} copy @param {{before: string, after: string}} e @param {string} current
 */
function acceptEdit(copy, e, current) {
  let out = copy;
  for (const [s, t] of spotsOf(e, current))
    out = t > s ? acceptLines(out, current, s, t, "lines") : acceptLines(out, current, s - 1, s, "deletions");
  return out;
}

/**
 * @param {string} root repo root
 * @param {(file: string) => string | undefined} [currentText] open-editor text, else read from disk
 * @returns {{rows: Array<{file: string, n: number, t: string, session?: string, tool?: string, prompt?: string, intent?: string, summary: string, title?: string, added: number, removed: number, accepted: boolean, preview?: Array<[string, string]>, lane: number}>,
 *            lanes: Array<{session: string, title?: string, first: number, last: number}>}}
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
    const copy = path.join(root, BASELINE_DIR, file);
    const edits = historyEdits(log, current);
    const accepted = acceptedOf(edits, fs.existsSync(copy) ? fs.readFileSync(copy, "utf8") : undefined, latestBefore(log), current);
    for (const e of edits) {
      const ok = accepted(e);
      rows.push({ file, n: e.n, t: e.t, session: e.session, tool: e.tool, prompt: e.prompt, intent: e.intent ?? narrationOf(e.transcript, e.toolUseId), summary: summaryOf(e.before, e.after),
        title: e.title, added: e.added, removed: e.removed, accepted: ok, preview: ok ? undefined : previewOf(e.before, e.after), lane: 0 });
    }
  }
  rows.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
  /** @type {ReturnType<typeof graphRows>["lanes"]} */
  const lanes = [];
  rows.forEach((r, i) => {
    const key = r.session ?? "?";
    let lane = lanes.findIndex((l) => l.session === key);
    // Rows are newest first: the first title seen is the session's latest.
    if (lane < 0) lane = lanes.push({ session: key, title: r.title, first: i, last: i }) - 1;
    lanes[lane].title ??= r.title;
    lanes[lane].last = i;
    r.lane = lane;
  });
  return { rows, lanes };
}

/**
 * What an edit changed, from the text alone (for edits without the agent's
 * words): the nearest Markdown heading above the first change, and the first
 * changed line, list markers and emphasis stripped.
 * @param {string} before @param {string} after
 */
function summaryOf(before, after) {
  const h = diff(before, after)[0];
  if (!h) return "No change";
  const lines = after.split(/\r?\n/);
  const old = before.split(/\r?\n/);
  const clean = (s) => s.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim();
  const changed = h.newEnd > h.newStart ? lines.slice(h.newStart, h.newEnd) : old.slice(h.oldStart, h.oldEnd);
  const line = clean(changed.find((l) => l.trim()) ?? "");
  let heading;
  for (let i = Math.min(h.newStart, lines.length - 1); i >= 0 && !heading; i--) if (/^#{1,6}\s/.test(lines[i]) && i !== h.newStart) heading = lines[i].trim();
  const what = h.newEnd > h.newStart ? line : `Removed: ${line}`;
  const text = [heading, what].filter(Boolean).join(" · ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

const PREVIEW_LINES = 300;

/**
 * An edit's change as diff lines for the hover: ["-" | "+" | "…", text].
 * @param {string} before @param {string} after @returns {Array<[string, string]>}
 */
function previewOf(before, after) {
  const [a, b] = [before.split(/\r?\n/), after.split(/\r?\n/)];
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const h of diff(before, after)) {
    if (out.length) out.push(["…", ""]);
    for (let i = h.oldStart; i < h.oldEnd; i++) out.push(["-", a[i]]);
    for (let i = h.newStart; i < h.newEnd; i++) out.push(["+", b[i]]);
  }
  return out.length > PREVIEW_LINES ? [...out.slice(0, PREVIEW_LINES), ["…", `${out.length - PREVIEW_LINES} more lines`]] : out;
}

module.exports = { graphRows, acceptedOf, acceptEdit, spotsOf, previewOf, summaryOf };
