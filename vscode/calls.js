// @ts-check
// What the graph needs from an agent's tool call, kept in the repo
// (.claude/imprimatur/calls.jsonl, one line per call): the branch it was made
// on, and for Edit / Write what it asked for and whether it failed. Read from
// the transcript the first time the graph sees a finished call, then from
// here: Claude Code deletes transcripts (cleanupPeriodDays, 30 days by
// default), and the graph keeps telling the agent's change from the rest.
// Rows from before the hook recorded tool calls (no toolUseId) are matched to
// their call in the session's transcript, by file and time; the match is kept
// here too ({row: "<file>\t<t>", toolUseId, transcript}).
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { callInfo, usesOf, titleOf } = require("./narration.js");

const TRANSCRIPTS = path.join(os.homedir(), ".claude", "projects");

const CALLS = path.join(".claude", "imprimatur", "calls.jsonl");

/** A kept line's size limit (a Write holds its whole file). */
const MAX_LINE = 512 * 1024;

/** @typedef {{toolUseId: string, branch?: string, name?: string, input?: any, failed?: boolean, said?: string}} Call */

/** @typedef {{toolUseId: string, transcript: string, title?: string}} Link */
/** @type {Map<string, {size: number, calls: Map<string, Call>, links: Map<string, Link>}>} */
const cache = new Map();

/** The repo's kept calls (re-read when the file grew). @param {string} root */
function keptCalls(root) {
  return kept(root).calls;
}

/** The repo's kept matches of older rows to their calls. @param {string} root */
function keptLinks(root) {
  return kept(root).links;
}

/** @param {string} root */
function kept(root) {
  const f = path.join(root, CALLS);
  let size = 0;
  let text = "";
  try {
    size = fs.statSync(f).size;
    const c = cache.get(root);
    if (c && c.size === size) return c;
    text = fs.readFileSync(f, "utf8");
    size = Buffer.byteLength(text);
  } catch {
    // no file yet, or one being replaced: nothing kept
  }
  /** @type {Map<string, Call>} */
  const calls = new Map();
  /** @type {Map<string, {toolUseId: string, transcript: string}>} */
  const links = new Map();
  if (text)
    for (const l of text.split("\n")) {
      try {
        const r = l && JSON.parse(l);
        if (r?.row && r.toolUseId) links.set(r.row, { toolUseId: r.toolUseId, transcript: r.transcript, ...(r.title && { title: r.title }) });
        else if (r?.toolUseId) calls.set(r.toolUseId, r);
      } catch {
        // a line being written
      }
    }
  const c = { size, calls, links };
  cache.set(root, c);
  return c;
}

/**
 * A call as the graph needs it: kept, else from its transcript (and kept once
 * it has finished). undefined when neither knows it.
 * @param {string} root @param {string | undefined} transcript @param {string | undefined} toolUseId
 * @returns {Call | undefined}
 */
function callOf(root, transcript, toolUseId) {
  if (!toolUseId) return undefined;
  const known = keptCalls(root).get(toolUseId);
  if (known) return known;
  const info = callInfo(transcript, toolUseId);
  if (!info) return undefined;
  /** @type {Call} */
  // said: a Bash call's own description (older rows did not record it).
  const call = { toolUseId, branch: info.branch, ...(info.said && { said: info.said }), ...(info.name && { name: info.name, input: info.input, failed: info.failed }) };
  // Still running: its result (failed or not) is not known yet.
  if (!info.done) return call;
  let line = JSON.stringify(call) + "\n";
  // A huge Write is not kept: without it the edit reads as before (next edit's text).
  if (line.length > MAX_LINE) line = JSON.stringify({ toolUseId, branch: info.branch, said: info.said }) + "\n";
  keep(root, line);
  return call;
}

/** Append one line to the repo's calls, and to the cache (no re-read). @param {string} root @param {string} line */
function keep(root, line) {
  try {
    fs.mkdirSync(path.dirname(path.join(root, CALLS)), { recursive: true });
    fs.appendFileSync(path.join(root, CALLS), line);
    const c = cache.get(root);
    if (c) {
      const r = JSON.parse(line);
      if (r.row) c.links.set(r.row, { toolUseId: r.toolUseId, transcript: r.transcript, ...(r.title && { title: r.title }) });
      else c.calls.set(r.toolUseId, r);
      c.size += Buffer.byteLength(line);
    }
  } catch {
    // read-only repo: the transcript stays the source
  }
}

/** Where Claude Code keeps transcripts (IMPRIMATUR_TRANSCRIPTS: tests). */
const transcriptsDir = () => process.env.IMPRIMATUR_TRANSCRIPTS || TRANSCRIPTS;

/** @type {Map<string, {file?: string, at: number}>} session → its transcript, or when it was last not found */
const sessionFiles = new Map();
/** A session not found is looked for again after this (it may be being written). */
const MISS_MS = 5 * 60_000;

/** The transcript of a session: ~/.claude/projects/<any project>/<session>.jsonl. @param {string} session */
function transcriptOf(session) {
  const seen = sessionFiles.get(session);
  if (seen && (seen.file || Date.now() - seen.at < MISS_MS)) return seen.file;
  let found;
  try {
    const dir = transcriptsDir();
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, `${session}.jsonl`);
      if (fs.existsSync(f)) {
        found = f;
        break;
      }
    }
  } catch {
    // no Claude Code data on this machine
  }
  sessionFiles.set(session, { file: found, at: Date.now() });
  return found;
}

/** How long before its row a call can start: a Bash row is written when the command ends. */
const LINK_BEFORE_MS = 30 * 60_000;
const LINK_AFTER_MS = 5_000;

const win = process.platform === "win32";
/** Paths compared as the file system does (Windows ignores case). @param {string} p */
const fold = (p) => (win ? p.toLowerCase() : p);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches one file's older rows (no toolUseId) to their tool calls: the
 * session's latest Edit / Write naming the file, or Bash command naming it,
 * that started before the row was written. Each call goes to one row; with
 * the tool unknown, an Edit / Write beats a Bash command that only names it.
 * @param {string} root @param {string} file repo-relative
 * @returns {(row: {t: string, session?: string, tool?: string, toolUseId?: string}) => Link | undefined}
 */
function linkIn(root, file) {
  const abs = fold(path.join(root, file));
  const rel = file.split(path.sep).join("/");
  // A Bash command names the file by its path (not inside a longer one), its
  // absolute path, or its bare name run from the file's own directory.
  const byPath = new RegExp(`(^|[\\s"'=(])(\\./)?${esc(rel)}(?![\\w./-])`);
  const byName = new RegExp(`(^|[\\s"'=(])(\\./)?${esc(path.basename(file))}(?![\\w./-])`);
  const keyOf = (t) => `${fold(file)}\t${t}`;
  /** @type {Set<string>} the calls this file's rows already hold */
  const used = new Set();
  for (const [k, l] of keptLinks(root)) if (k.startsWith(`${fold(file)}\t`)) used.add(l.toolUseId);
  return (row) => {
    if (row.toolUseId || !row.session || !row.t) return undefined;
    const key = keyOf(row.t);
    const known = keptLinks(root).get(key);
    if (known) return known;
    const transcript = transcriptOf(row.session);
    if (!transcript) return undefined;
    const t = Date.parse(row.t);
    const names = (u) => {
      if (row.tool && u.name !== row.tool) return false;
      const cwd = u.cwd ?? root;
      if (u.name !== "Bash") return !!u.file && fold(path.resolve(cwd, u.file)) === abs;
      if (!u.command) return false;
      if (fold(u.command).includes(abs) || byPath.test(u.command)) return true;
      return byName.test(u.command) && fold(path.resolve(cwd, path.basename(file))) === abs;
    };
    const hit = usesOf(transcript)
      .filter((u) => !used.has(u.id) && u.at <= t + LINK_AFTER_MS && u.at >= t - LINK_BEFORE_MS && names(u))
      .sort((a, b) => (row.tool ? 0 : Number(a.name === "Bash") - Number(b.name === "Bash")) || b.at - a.at)[0];
    if (!hit) return undefined;
    used.add(hit.id);
    // The session's title too: older rows have none, and the transcript goes in time.
    const title = titleOf(transcript);
    const link = { toolUseId: hit.id, transcript, ...(title && { title }) };
    keep(root, JSON.stringify({ row: key, ...link }) + "\n");
    return link;
  };
}

/**
 * The tool-call reader historyEdits takes (review-state.js), for one repo.
 * @param {string} root
 */
const toolCallIn = (root) => (/** @type {string | undefined} */ transcript, /** @type {string | undefined} */ id) => {
  const c = callOf(root, transcript, id);
  return c?.name ? { name: c.name, input: c.input, failed: !!c.failed } : undefined;
};

module.exports = { CALLS, callOf, toolCallIn, keptCalls, keptLinks, linkIn };
