// @ts-check
// Archive (#52): what is older than N days (7 by default) leaves the graph and
// the waiting list, gzipped under .claude/imprimatur/archive/<date>/ in the same
// layout (read with zcat). The extension runs it once a day per repo.
// - An agent edit older than the limit counts as accepted (its lines go into
//   the review copy, as the graph's Accept does) and its history row moves to
//   the archive. A file whose edits are all old leaves review entirely (log
//   and copy archived). A file gone from the repo is archived whatever its age.
// - A session's waiting log is archived when nothing in it is open and its last
//   record is old. Open asks are never closed here: they are the user's to do.
// - calls.jsonl and descriptions.jsonl keep only what remaining rows use.
// Files are rewritten only if unchanged since read (a hook may be appending):
// a file that changed is left for the next run.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { BASELINE_DIR, HISTORY_DIR, historyEdits } = require("./review-state.js");
const { WAITING_DIR, readLog, itemsOf } = require("./waiting.js");
const { ACTIVITY_DIR } = require("./activity.js");
const { acceptEdit } = require("./graph.js");
const { CALLS } = require("./calls.js");

const ARCHIVE_DIR = path.join(".claude", "imprimatur", "archive");
const STATE = path.join(ARCHIVE_DIR, "state.json");
const DESCRIPTIONS = path.join(".claude", "imprimatur", "descriptions.jsonl");
const DAY = 86_400_000;

/** @param {string} f */
const stamp = (f) => {
  try {
    const st = fs.statSync(f);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
};

/** Lines of a file with their parsed record (undefined when not JSON). @param {string} f */
function lines(f) {
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return { line, r: JSON.parse(line) };
      } catch {
        return { line, r: undefined };
      }
    });
}

/**
 * Replace a file's text if it is still as read (`was`: its stamp then); an
 * empty text removes it. @param {string} f @param {string} text @param {string} was
 * @returns {boolean} written
 */
function rewrite(f, text, was) {
  if (stamp(f) !== was) return false;
  if (!text) {
    fs.rmSync(f, { force: true });
    return true;
  }
  const tmp = `${f}.archiving`;
  fs.writeFileSync(tmp, text);
  // Again just before the swap: a hook may have written while the new text was.
  if (stamp(f) !== was) {
    fs.rmSync(tmp, { force: true });
    return false;
  }
  fs.renameSync(tmp, f);
  return true;
}

/** Add text to a gzipped archive file (one gzip member per run: zcat reads them all). @param {string} f @param {string} text */
function stash(f, text) {
  if (!text) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(`${f}.gz`, zlib.gzipSync(text));
}

/**
 * Archive what is older than `days` in one repo.
 * @param {string} root @param {{days?: number, now?: number}} [opts]
 * @returns {{edits: number, files: number, sessions: number, calls: number, descriptions: number}}
 */
function archiveRepo(root, opts = {}) {
  const none = { edits: 0, files: 0, sessions: 0, calls: 0, descriptions: 0 };
  // Not while git is changing the files (a checkout, rebase or merge), nor twice at once (two windows).
  const git = path.join(root, ".git");
  if (["index.lock", "rebase-merge", "rebase-apply", "MERGE_HEAD"].some((f) => fs.existsSync(path.join(git, f)))) return none;
  const lock = path.join(root, ARCHIVE_DIR, ".lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    // Held by another run; one left by a crash goes after 10 minutes.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < 600_000) return none;
      fs.writeFileSync(lock, String(process.pid));
    } catch {
      return none;
    }
  }
  try {
    return archiveUnlocked(root, opts);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** @param {string} root @param {{days?: number, now?: number}} opts */
function archiveUnlocked(root, { days = 7, now = Date.now() }) {
  const out = { edits: 0, files: 0, sessions: 0, calls: 0, descriptions: 0, activity: 0 };
  const cutoff = now - days * DAY;
  const dest = path.join(root, ARCHIVE_DIR, new Date(now).toISOString().slice(0, 10));
  const history = path.join(root, HISTORY_DIR);
  /** Tool calls and older rows' keys still used by rows left in review. */
  const keptIds = new Set();
  const keptRows = new Set();
  /** file → how many of its (counted) edits left: "#n" descriptions shift by it; null: all left. */
  /** @type {Map<string, number | null>} */
  const shifted = new Map();
  const logs = fs.existsSync(history)
    ? fs.readdirSync(history, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    : [];
  for (const ent of logs) {
    const log = path.join(ent.parentPath, ent.name);
    const file = path.relative(history, log).slice(0, -".jsonl".length);
    const abs = path.join(root, file);
    const copy = path.join(root, BASELINE_DIR, file);
    const was = stamp(log);
    const rows = lines(log);
    const keep = (rs) => {
      for (const { r } of rs) {
        if (r?.toolUseId) keptIds.add(r.toolUseId);
        if (r?.t) keptRows.add(`${file}\t${r.t}`);
      }
    };
    // Rows are appended in time order: the old ones are a prefix.
    let k = 0;
    while (k < rows.length && Date.parse(rows[k].r?.t ?? "") < cutoff) k++;
    // A file missing now may only be on another branch: like any other, it waits until its edits are old.
    const gone = !fs.existsSync(abs);
    if (k === 0 || (gone && k < rows.length)) {
      keep(rows);
      continue;
    }
    if (gone || k === rows.length) {
      // The whole file leaves review: archived first, then removed.
      const baseline = fs.existsSync(copy) ? fs.readFileSync(copy, "utf8") : undefined;
      stash(path.join(dest, "history", `${file}.jsonl`), rows.map((x) => x.line).join("\n") + "\n");
      if (baseline !== undefined) stash(path.join(dest, "baseline", file), baseline);
      if (!rewrite(log, "", was)) {
        keep(rows);
        continue;
      }
      if (baseline !== undefined) fs.rmSync(copy, { force: true });
      out.files++;
      out.edits += rows.length;
      shifted.set(file, null);
      continue;
    }
    // Some edits are old: they count as accepted, then leave the log.
    const current = fs.readFileSync(abs, "utf8");
    // The edits of exactly the rows that leave (the prefix), oldest first.
    const leaving = new Set(rows.slice(0, k).map((x) => x.r?.t));
    const old = historyEdits(log, current).filter((e) => leaving.has(e.t)).reverse();
    stash(path.join(dest, "history", `${file}.jsonl`), rows.slice(0, k).map((x) => x.line).join("\n") + "\n");
    if (fs.existsSync(copy)) {
      const before = stamp(copy);
      let text = fs.readFileSync(copy, "utf8");
      for (const e of old) text = acceptEdit(text, e, current);
      if (!rewrite(copy, text, before)) {
        keep(rows);
        continue;
      }
    }
    if (!rewrite(log, rows.slice(k).map((x) => x.line).join("\n") + "\n", was)) {
      keep(rows);
      continue;
    }
    keep(rows.slice(k));
    out.edits += k;
    // "#n" descriptions count the log's readable rows (hooks/describe.mjs editTexts).
    shifted.set(file, rows.slice(0, k).filter((x) => x.r).length);
  }
  // Rows from before tool calls were recorded hold theirs through a kept link.
  const callsFile = path.join(root, CALLS);
  if (fs.existsSync(callsFile)) {
    const was = stamp(callsFile);
    const all = lines(callsFile);
    for (const { r } of all) if (r?.row && keptRows.has(r.row) && r.toolUseId) keptIds.add(r.toolUseId);
    const used = (r) => (r?.row ? keptRows.has(r.row) : !r?.toolUseId || keptIds.has(r.toolUseId));
    const stay = all.filter((x) => used(x.r));
    if (stay.length < all.length) {
      stash(path.join(dest, "calls.jsonl"), all.filter((x) => !used(x.r)).map((x) => x.line).join("\n") + "\n");
      if (rewrite(callsFile, stay.map((x) => x.line).join("\n") + (stay.length ? "\n" : ""), was)) out.calls += all.length - stay.length;
    }
  }
  // Descriptions: by tool call; older ones by the file's edit number ("#n"), which shifts.
  const descFile = path.join(root, DESCRIPTIONS);
  if (fs.existsSync(descFile)) {
    const was = stamp(descFile);
    const all = lines(descFile);
    /** @type {string[]} */
    const stay = [];
    /** @type {string[]} */
    const left = [];
    for (const { line, r } of all) {
      const n = /^#(\d+)$/.exec(r?.toolUseId ?? "")?.[1];
      if (n !== undefined && r.file && shifted.has(r.file)) {
        const by = shifted.get(r.file);
        if (by === null || Number(n) <= (by ?? 0)) left.push(line);
        else stay.push(JSON.stringify({ ...r, toolUseId: `#${Number(n) - (by ?? 0)}` }));
      } else if (n === undefined && r?.toolUseId && !keptIds.has(r.toolUseId)) left.push(line);
      else stay.push(line);
    }
    if (left.length || stay.some((l, i) => l !== all[i]?.line)) {
      stash(path.join(dest, "descriptions.jsonl"), left.join("\n") + (left.length ? "\n" : ""));
      if (rewrite(descFile, stay.join("\n") + (stay.length ? "\n" : ""), was)) out.descriptions += left.length;
    }
  }
  // Waiting logs: nothing open and nothing new.
  const waiting = path.join(root, WAITING_DIR);
  if (fs.existsSync(waiting))
    for (const name of fs.readdirSync(waiting).filter((n) => n.endsWith(".jsonl"))) {
      const log = path.join(waiting, name);
      const was = stamp(log);
      const records = readLog(log);
      const last = Math.max(0, ...records.map((r) => Date.parse(r.t) || 0));
      // Empty or being written (no record read yet), new, or still asking: left alone.
      if (!records.length || last >= cutoff || fs.statSync(log).mtimeMs >= cutoff || itemsOf(records, name.slice(0, -".jsonl".length)).some((it) => it.open)) continue;
      stash(path.join(dest, "waiting", name), fs.readFileSync(log, "utf8"));
      if (rewrite(log, "", was)) out.sessions++;
    }
  // Activity logs (#55): a session's whole log once its last call is old.
  const activity = path.join(root, ACTIVITY_DIR);
  if (fs.existsSync(activity))
    for (const name of fs.readdirSync(activity).filter((n) => n.endsWith(".jsonl"))) {
      const log = path.join(activity, name);
      const was = stamp(log);
      const text = fs.readFileSync(log, "utf8");
      const last = Math.max(0, ...text.split("\n").map((l) => Date.parse(/"t":"([^"]+)"/.exec(l)?.[1] ?? "") || 0));
      if (!text || last >= cutoff || fs.statSync(log).mtimeMs >= cutoff) continue;
      stash(path.join(dest, "activity", name), text);
      if (rewrite(log, "", was)) out.activity++;
    }
  fs.mkdirSync(path.dirname(path.join(root, STATE)), { recursive: true });
  fs.writeFileSync(path.join(root, STATE), JSON.stringify({ at: new Date(now).toISOString(), days, ...out }, null, 2) + "\n");
  return out;
}

/** Has the repo's archive not run in the last day? @param {string} root @param {number} [now] */
function archiveDue(root, now = Date.now()) {
  try {
    return now - Date.parse(JSON.parse(fs.readFileSync(path.join(root, STATE), "utf8")).at) >= DAY;
  } catch {
    return true;
  }
}

module.exports = { ARCHIVE_DIR, archiveRepo, archiveDue };
