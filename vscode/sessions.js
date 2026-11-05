// @ts-check
// Each session's numbers (#149): the status line hook gets the session's cost, time and lines
// from Claude Code on every update; this keeps the latest of them, one row per session, in the
// repo's data folder (sessions.jsonl), with the tokens summed from the transcript's usage fields.
// The transcript is read from where the last update stopped, so an update reads only what is new.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Updates closer than this, with the same cost and lines, write nothing. */
const QUIET_MS = 5000;
/** At most this much of a transcript is read per update; the rest waits for the next one. */
const READ_MAX = 8 << 20;

/** The repo's sessions file. @param {string} root */
const sessionsFile = (root) => require("./data-dir.js").dataPath(root, path.join(".claude", "imprimatur"), "sessions.jsonl");

/** Every session's row, oldest first. @param {string} root @returns {any[]} */
function readSessions(root) {
  let text = "";
  try {
    text = fs.readFileSync(sessionsFile(root), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

/**
 * The tokens of a transcript's new part, from where the last read stopped. A message's usage
 * repeats on each of its content lines: a message id counts once (it follows itself).
 * @param {string} file @param {{offset?: number, lastId?: string, tokens?: any}} prev
 */
function tokensSince(file, prev) {
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, ...(prev.tokens ?? {}) };
  let offset = Number(prev.offset ?? 0), lastId = prev.lastId ?? "";
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size < offset) return { tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, offset: 0, lastId: "", again: true };
    const len = Math.min(size - offset, READ_MAX);
    if (len <= 0) return { tokens, offset, lastId };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString("utf8");
    // Only whole lines: a line still being written is read next time.
    const end = text.lastIndexOf("\n");
    if (end < 0) return { tokens, offset, lastId };
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.includes('"usage"')) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const m = j?.message;
      if (j?.type !== "assistant" || !m?.usage) continue;
      const id = String(m.id ?? j.uuid ?? "");
      if (id && id === lastId) continue;
      lastId = id;
      tokens.input += Number(m.usage.input_tokens) || 0;
      tokens.output += Number(m.usage.output_tokens) || 0;
      tokens.cacheWrite += Number(m.usage.cache_creation_input_tokens) || 0;
      tokens.cacheRead += Number(m.usage.cache_read_input_tokens) || 0;
    }
    offset += Buffer.byteLength(text.slice(0, end + 1));
    return { tokens, offset, lastId };
  } catch {
    return { tokens, offset, lastId };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Keeps the session's latest numbers from one status line input (#149): its row replaced, not
 * added again. Returns the row, or undefined when nothing was written.
 * @param {string} root @param {any} input the status line's JSON @param {{now?: number}} [o]
 */
function recordSession(root, input, { now = Date.now() } = {}) {
  const session = typeof input?.session_id === "string" ? input.session_id : "";
  if (!/^[\w-]{1,100}$/.test(session)) return undefined;
  const c = input.cost ?? {};
  const rows = readSessions(root);
  const prev = rows.find((r) => r.session === session) ?? {};
  const num = (/** @type {unknown} */ v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cost = num(c.total_cost_usd), added = num(c.total_lines_added), removed = num(c.total_lines_removed);
  if (prev.at && now - prev.at < QUIET_MS && prev.cost === cost && prev.added === added && prev.removed === removed) return undefined;
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
  let t = transcript ? tokensSince(transcript, prev.transcript === transcript ? prev : {}) : { tokens: prev.tokens, offset: prev.offset, lastId: prev.lastId };
  // A transcript that got shorter (rewritten): counted again from its start.
  if (/** @type {any} */ (t).again) t = tokensSince(transcript, {});
  const row = {
    session, at: now, started: prev.started ?? now, cost, durationMs: num(c.total_duration_ms), apiMs: num(c.total_api_duration_ms), added, removed,
    model: String(input.model?.id ?? prev.model ?? ""), tokens: t.tokens, transcript, offset: t.offset, lastId: t.lastId,
  };
  const out = [...rows.filter((r) => r.session !== session), row].map((r) => JSON.stringify(r)).join("\n") + "\n";
  const file = sessionsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written whole and renamed: a reader never sees half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
  return row;
}

/**
 * A transcript's cost points (#149): Claude Code writes a "cost-state" line with the session's
 * running totals (cost, API time, lines, tokens per model) in the terminal and in VS Code alike,
 * where the status line does not run. Each point gets the time of the nearest line before it.
 * prompts: the user's own messages (not tool results or meta lines); a background agent
 * (`claude -p`, a plugin's review) has one.
 * @param {string} text a transcript's text
 * @returns {{prompts: number, points: Array<{t: number, session: string, started: number, cost: number, apiMs: number, added: number, removed: number, tokens: {input: number, output: number, cacheWrite: number, cacheRead: number}}>}}
 */
function transcriptCost(text) {
  const points = [];
  let prompts = 0;
  let t = 0;
  let from = 0;
  for (;;) {
    const end = text.indexOf("\n", from);
    const line = end < 0 ? text.slice(from) : text.slice(from, end);
    if (line.length > 20) {
      const ts = /"timestamp":"([^"]{10,40})"/.exec(line.slice(0, 2000));
      if (ts) t = Date.parse(ts[1]) || t;
      if (line.includes('"type":"user"') && !line.includes('"tool_result"') && !line.includes('"isMeta":true') && !line.includes('"isCompactSummary":true')) prompts++;
      if (line.startsWith('{"type":"cost-state"'))
        try {
          const j = JSON.parse(line);
          const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
          for (const m of Object.values(j.modelUsage ?? {})) {
            tokens.input += Number(/** @type {any} */ (m).inputTokens) || 0;
            tokens.output += Number(/** @type {any} */ (m).outputTokens) || 0;
            tokens.cacheWrite += Number(/** @type {any} */ (m).cacheCreationInputTokens) || 0;
            tokens.cacheRead += Number(/** @type {any} */ (m).cacheReadInputTokens) || 0;
          }
          points.push({ t: t || Number(j.startTime) || 0, session: String(j.sessionId ?? ""), started: Number(j.startTime) || t, cost: Number(j.totalCostUSD) || 0,
            apiMs: Number(j.totalAPIDuration) || 0, added: Number(j.totalLinesAdded) || 0, removed: Number(j.totalLinesRemoved) || 0, tokens });
        } catch {}
    }
    if (end < 0) break;
    from = end + 1;
  }
  return { prompts, points };
}

module.exports = { sessionsFile, readSessions, recordSession, tokensSince, transcriptCost, QUIET_MS };
