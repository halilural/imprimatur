// @ts-check
// Wasted edits (#212, #41): what the agent wrote and then threw away itself. From the Agent
// Change Graph's rows, over the last days: an edit whose lines are no longer in the file, replaced
// by a later edit of the same file in the same session (the agent undid its own work; a change by
// another session or by the user is not counted), and a file edited three or more times in a row in
// one session (a rewrite loop). Tokens are an estimate per line, said as such. No model call.
"use strict";

const DAYS = 7;
/** Edits in a row to one file, in one session, from which it counts as a rewrite. */
const REWRITE = 3;
/** Estimated tokens per written line (code averages about ten). */
const TOKENS_PER_LINE = 10;

/**
 * @param {Array<{file: string, t: string, session?: string, tool?: string, added: number, removed: number, gone: boolean, activity?: boolean, record?: number, outside?: boolean}>} rows graphRows(root).rows
 * @param {{now?: number, days?: number}} [o]
 * @returns {{edits: number, lines: number, tokens: number, rewrites: Array<{file: string, session: string, count: number}>, files: Array<{file: string, edits: number, lines: number, tokens: number}>}}
 */
function wastedEdits(rows, { now = Date.now(), days = DAYS } = {}) {
  const since = now - days * 86_400_000;
  const edits = rows
    .filter((r) => !r.activity && !r.record && !r.outside && r.tool !== "record" && r.session && Date.parse(r.t) >= since)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  /** @type {Map<string, typeof edits>} */
  const bySession = new Map();
  for (const e of edits) bySession.set(`${e.session}\0${e.file}`, [...(bySession.get(`${e.session}\0${e.file}`) ?? []), e]);
  // Every edit but the last of the file in its session that left nothing behind.
  const wasted = [...bySession.values()].flatMap((list) => list.slice(0, -1).filter((e) => e.gone));
  // Runs of edits that change a file's lines, to one file with no other file changed in between, per session.
  const rewrites = [];
  /** @type {Map<string, {file: string, count: number}>} */
  const run = new Map();
  const close = (/** @type {string} */ session) => {
    const r = run.get(session);
    if (r && r.count >= REWRITE) rewrites.push({ file: r.file, session, count: r.count });
  };
  for (const e of edits) {
    // Only an edit that changes what was there rewrites; appending (a changelog entry) does not.
    if (!e.removed) continue;
    const s = /** @type {string} */ (e.session);
    const r = run.get(s);
    if (r && r.file === e.file) r.count++;
    else {
      close(s);
      run.set(s, { file: e.file, count: 1 });
    }
  }
  for (const s of run.keys()) close(s);
  /** @type {Map<string, {file: string, edits: number, lines: number, tokens: number}>} */
  const files = new Map();
  for (const e of wasted) {
    const f = files.get(e.file) ?? { file: e.file, edits: 0, lines: 0, tokens: 0 };
    f.edits++;
    f.lines += e.added;
    f.tokens += e.added * TOKENS_PER_LINE;
    files.set(e.file, f);
  }
  const lines = wasted.reduce((n, e) => n + e.added, 0);
  return {
    edits: wasted.length, lines, tokens: lines * TOKENS_PER_LINE,
    rewrites: rewrites.sort((a, b) => b.count - a.count),
    files: [...files.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

module.exports = { wastedEdits, DAYS, REWRITE, TOKENS_PER_LINE };
