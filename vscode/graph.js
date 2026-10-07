// @ts-check
// Agent Change Graph: every agent edit in a repo, newest first, one lane per
// task (like branches in a git graph; #39: a session can do several tasks). An edit is accepted when none
// of its lines still left in the file is an open change under review.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { BASELINE_DIR, HISTORY_DIR, historyEdits, latestBefore } = require("./review-state.js");
const { diff, review, acceptLines } = require("./diff.js");
const { narrationOf, toolCallOf } = require("./narration.js");
const { taskKeyIn } = require("./tasks.js");

const DESCRIPTIONS = path.join(".claude", "imprimatur", "descriptions.jsonl");

/** What the graph says for a change that is not the agent's recorded edit. */
const OUTSIDE = "Outside change: not in the agent's recorded edit (by hand, git, a hook, or a failed command)";

/**
 * A small model's one-sentence description per edit (hooks/describe.mjs),
 * keyed "<toolUseId> <file>". @param {string} root @returns {Map<string, string>}
 */
function descriptionsOf(root) {
  const f = path.join(root, DESCRIPTIONS);
  const out = new Map();
  if (!fs.existsSync(f)) return out;
  for (const l of fs.readFileSync(f, "utf8").split("\n")) {
    try {
      const d = l && JSON.parse(l);
      if (d?.toolUseId && d.file && d.text) out.set(`${d.toolUseId} ${d.file}`, d.text);
    } catch {
      // a line being written
    }
  }
  return out;
}

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
 * rewrote belong to that edit and are left out: a line counts only where it
 * still reads as this edit wrote it (a position alone can be another edit's
 * line put where this one's was deleted).
 * @param {{before: string, after: string}} e @param {string} current @returns {Array<[number, number]>}
 */
function spotsOf(e, current) {
  const later = diff(e.after, current);
  const wrote = e.after.split(/\r?\n/);
  const now = current.split(/\r?\n/);
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const h of diff(e.before, e.after)) {
    const spots = Array.from({ length: h.newEnd - h.newStart }, (_, k) => [h.newStart + k, h.newStart + k + 1]);
    // More lines gone than written: the rest is a deletion after the last one.
    if (h.oldEnd - h.oldStart > h.newEnd - h.newStart) spots.push([h.newEnd, h.newEnd]);
    for (const [s, t] of spots) {
      const [ms, mt] = [mapBoundary(s, later), mapBoundary(t, later)];
      if (ms === undefined || mt === undefined || (t > s && (mt - ms !== t - s || now[ms] !== wrote[s]))) continue;
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

/** The task a file under todos/<key>/ belongs to: todos/37/… → #37, todos/LATD-12/… → LATD-12. @param {string} file */
function taskOfFile(file) {
  const [top, dir, ...rest] = file.split(/[\\/]/);
  if (top !== "todos" || !dir || !rest.length) return undefined;
  return /^\d+$/.test(dir) ? `#${dir}` : taskKeyIn(dir);
}

/** The task a branch names: <type>/<n>-name → #n, else a Jira key in it. @param {string} [branch] */
function taskOfBranch(branch) {
  if (!branch) return undefined;
  const n = /^[\w.-]+\/(\d+)(?:-|$)/.exec(branch);
  // A Jira key in a branch is followed by its name: feature/LATD-13937-sync.
  return n ? `#${n[1]}` : /(?:^|[/_])([A-Z][A-Z0-9]{1,9}-\d+)(?=$|[-_/])/.exec(branch)?.[1];
}

/**
 * Each edit's task, from its own clues, never from its session alone (one
 * session can work on several tasks): (1) its file is under todos/<key>/;
 * (2) the branch it was made on; (3) the task whose todos/ the same turn
 * (session + request) edited most; (4) a key the request or the Bash
 * description names. None: undefined (the "No task" lane).
 * @param {Array<{file: string, session?: string, prompt?: string, branch?: string, said?: string}>} rows
 * @returns {Array<string | undefined>}
 */
function tasksOf(rows) {
  // A turn needs both: without them, unrelated edits would share one.
  const turn = (r) => (r.session && r.prompt ? `${r.session}\n${r.prompt}` : undefined);
  /** @type {Map<string, Map<string, number>>} */
  const turns = new Map();
  for (const r of rows) {
    const k = taskOfFile(r.file);
    if (!k || !turn(r)) continue;
    const counts = turns.get(turn(r)) ?? new Map();
    counts.set(k, (counts.get(k) ?? 0) + 1);
    turns.set(turn(r), counts);
  }
  const most = (counts) => counts && [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return rows.map((r) => taskOfFile(r.file) ?? taskOfBranch(r.branch) ?? most(turns.get(turn(r) ?? "")) ?? taskKeyIn(r.prompt) ?? taskKeyIn(r.said));
}

/** A task's title: its TODO.md heading without the key ("# #39 · Lanes" → "Lanes"). @param {string} root @param {string} task */
function taskTitle(root, task) {
  const todo = path.join(root, "todos", task.replace(/^#/, ""), "TODO.md");
  if (!fs.existsSync(todo)) return undefined;
  const head = /^#\s+(.+)$/m.exec(fs.readFileSync(todo, "utf8"))?.[1];
  return head?.replace(task, "").replace(/^[\s·:–—-]+/, "").trim() || undefined;
}

/**
 * @param {string} root repo root
 * @param {(file: string) => string | undefined} [currentText] open-editor text, else read from disk
 * @returns {{rows: Array<{file: string, n: number, t: string, session?: string, tool?: string, prompt?: string, intent?: string, summary: string, title?: string, added: number, removed: number, accepted: boolean, gone: boolean, preview?: Array<[string, string]>, task?: string, lane: number, outside?: boolean}>,
 *            lanes: Array<{task?: string, title?: string, first: number, last: number}>,
 *            sessions: Array<{session: string, title?: string}>}}
 */
function graphRows(root, currentText = () => undefined) {
  const dir = path.join(root, HISTORY_DIR);
  if (!fs.existsSync(dir)) return { rows: [], lanes: [], sessions: [] };
  /** @type {ReturnType<typeof graphRows>["rows"]} */
  const rows = [];
  /** The clues tasksOf reads that the rows do not keep (the branch, the Bash description). */
  const clues = new Map();
  const described = descriptionsOf(root);
  for (const ent of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const log = path.join(ent.parentPath, ent.name);
    const file = path.relative(dir, log).slice(0, -".jsonl".length);
    const abs = path.join(root, file);
    const open = currentText(abs);
    // A file gone from the repo (deleted, renamed) has nothing left to review.
    if (open === undefined && !fs.existsSync(abs)) continue;
    const current = open ?? fs.readFileSync(abs, "utf8");
    const copy = path.join(root, BASELINE_DIR, file);
    const edits = historyEdits(log, current, { toolCall: toolCallOf });
    const accepted = acceptedOf(edits, fs.existsSync(copy) ? fs.readFileSync(copy, "utf8") : undefined, latestBefore(log), current);
    for (const e of edits) {
      // An edit that changed nothing (an Edit call denied, a Bash command that left the text) is no row.
      if (!e.added && !e.removed) continue;
      const ok = accepted(e);
      // Nothing of it left in the file (later edits replaced it all): neither open nor accepted.
      const gone = spotsOf(e, current).length === 0;
      const intent = e.outside ? OUTSIDE : (e.toolUseId && described.get(`${e.toolUseId} ${file}`)) ?? described.get(`#${e.n} ${file}`) ?? e.intent ?? narrationOf(e.transcript, e.toolUseId);
      rows.push({ file, n: e.n, t: e.t, session: e.session, tool: e.tool, prompt: e.prompt, intent, summary: summaryOf(e.before, e.after),
        title: e.title, added: e.added, removed: e.removed, accepted: ok, gone, preview: ok ? undefined : previewOf(e.before, e.after), lane: 0, ...(e.outside && { outside: true }) });
      // An outside change goes in its edit's lane: the edit's own clues.
      const own = e.outside ? edits.find((x) => x.n === e.n - 0.5) : e;
      clues.set(rows.at(-1), { branch: own?.branch, said: own?.intent, ...(e.outside && { session: own?.session, prompt: own?.prompt }) });
    }
  }
  rows.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
  const tasks = tasksOf(rows.map((r) => ({ ...r, ...clues.get(r) })));
  /** @type {ReturnType<typeof graphRows>["lanes"]} */
  const lanes = [];
  /** @type {ReturnType<typeof graphRows>["sessions"]} */
  const sessions = [];
  rows.forEach((r, i) => {
    const task = tasks[i];
    if (task) r.task = task;
    let lane = lanes.findIndex((l) => l.task === task);
    if (lane < 0) lane = lanes.push({ ...(task && { task, title: taskTitle(root, task) }), first: i, last: i }) - 1;
    lanes[lane].last = i;
    r.lane = lane;
    // Rows are newest first: the first title seen is the session's latest.
    const s = r.session ?? "?";
    const known = sessions.find((x) => x.session === s);
    if (!known) sessions.push({ session: s, title: r.title });
    else known.title ??= r.title;
  });
  return { rows, lanes, sessions };
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

module.exports = { graphRows, tasksOf, taskOfBranch, acceptedOf, acceptEdit, spotsOf, previewOf, summaryOf };
