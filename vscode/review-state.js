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
 * The branch an edit belongs to. A Bash command can switch branches around its
 * edit (`git switch -c feat/1-x && sed …`, `sed … && git commit && git switch main`):
 * when the branch before and after differ, the one that is not the default
 * (both task branches: the one after).
 * @param {string | undefined} before @param {string | undefined} after
 */
function editBranch(before, after) {
  if (!before || before === after) return after;
  const main = (b) => !b || ["main", "master"].includes(b);
  // Two task branches: the command moved to the second one for its work.
  return main(after) ? before : after;
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
 * The text an Edit or Write call left, from what it asked for: undefined when
 * that cannot be told (no call, its old text not in `before`).
 * @param {string} before @param {{name: string, input: any, failed: boolean} | undefined} call
 */
function toolResult(before, call) {
  if (!call) return undefined;
  if (call.failed) return before;
  const { input } = call;
  if (call.name === "Write") return typeof input?.content === "string" ? input.content : undefined;
  const { old_string: o, new_string: n, replace_all: all } = input ?? {};
  if (typeof o !== "string" || typeof n !== "string" || !o || !before.includes(o)) return undefined;
  return all ? before.split(o).join(n) : before.replace(o, () => n);
}

/** Same text but for line ends, trailing spaces and blank lines. @param {string} a @param {string} b */
const same = (a, b) => {
  const norm = (s) => s.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n").trim();
  return a === b || norm(a) === norm(b);
};

/**
 * The agent's edits to one file, newest first, like a commit log. Each edit's
 * "after" is the next edit's "before", or the current text for the latest one.
 * With `toolCall` (the transcript's Edit / Write calls, narration.js), an edit's
 * "after" is what the call itself wrote; what changed besides (by hand, git, a
 * failed Bash command) becomes an edit of its own: `outside`, numbered n + 0.5.
 * @param {string} log path of the .jsonl history @param {string} current current text
 * With `link` (calls.js), a row from before tool calls were recorded gets its call (transcript, toolUseId).
 * @param {{toolCall?: (transcript: string | undefined, toolUseId: string | undefined) => {name: string, input: any, failed: boolean} | undefined,
 *          link?: (row: any) => {toolUseId: string, transcript: string} | undefined}} [opts]
 * @returns {Array<{n: number, t: string, session?: string, tool?: string, prompt?: string, intent?: string, title?: string, transcript?: string, toolUseId?: string, branch?: string, before: string, after: string, added: number, removed: number, outside?: boolean}>}
 */
function historyEdits(log, current, opts = {}) {
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
  const counted = (e) => {
    let added = 0;
    let removed = 0;
    for (const h of diff(e.before, e.after)) {
      added += h.newEnd - h.newStart;
      removed += h.oldEnd - h.oldStart;
    }
    return { ...e, added, removed };
  };
  const out = [];
  rows.forEach((row, i) => {
    const linked = opts.link?.(row);
    // Only what the row lacks: its own transcript and title stay.
    const r = linked ? { ...row, toolUseId: linked.toolUseId, transcript: row.transcript ?? linked.transcript, title: row.title ?? linked.title } : row;
    const next = i + 1 < rows.length ? rows[i + 1].before : current;
    const edit = { n: i + 1, t: r.t, session: r.session, tool: r.tool, prompt: r.prompt, intent: r.intent, title: r.title, transcript: r.transcript, toolUseId: r.toolUseId, branch: r.branch, before: r.before };
    const wrote = opts.toolCall && (r.tool === "Edit" || r.tool === "Write") ? toolResult(r.before, opts.toolCall(r.transcript, r.toolUseId)) : undefined;
    // Only a difference in line ends or trailing spaces (the editor's or the tool's own) is no outside change.
    if (wrote === undefined || same(wrote, next)) {
      out.push(counted({ ...edit, after: next }));
      return;
    }
    out.push(counted({ ...edit, after: wrote }));
    const t = new Date(Date.parse(r.t) + 1).toISOString();
    out.push(counted({ n: i + 1.5, t, tool: "outside", outside: true, branch: r.branch, before: wrote, after: next }));
  });
  return out.reverse();
}

module.exports = { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore, historyEdits, editBranch };
