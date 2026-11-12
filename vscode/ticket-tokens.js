// @ts-check
// Tokens per ticket (#214, #41): Claude Code's transcripts of a repo, each assistant message's usage
// counted once (streamed blocks repeat it under one message id) and given to a ticket: the one its
// git branch names, else the one the session last named (an Imprimatur tool call's task or key, or
// a `git switch` to a ticket branch). An estimate, said as such. Transcripts are read incrementally:
// an unchanged file is skipped, a grown one read from where it stopped. No price: on a subscription
// tokens have none.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** @typedef {{written: number, cached: number, output: number, sessions: Set<string>}} Sum */
/** @typedef {{size: number, offset: number, current?: string, seen: Set<string>, sums: Map<string, Sum>}} FileState */
/** @type {Map<string, FileState>} */
const cache = new Map();

const TICKET = /^#\d+$|^[A-Z][A-Z0-9_]*-\d+$/;
/** The ticket a branch names: "feat/212-wasted" → #212, "dev/LATD-12-x" → LATD-12. @param {string} [b] */
function ticketOfBranch(b) {
  const m = /^[^/]+\/(?:(\d+)|([A-Z][A-Z0-9_]*-\d+))(?:-|$)/.exec(b ?? "");
  return m ? (m[1] ? `#${m[1]}` : m[2]) : undefined;
}

/** The ticket an assistant message's tool calls name, if any. @param {any} msg */
function namedIn(msg) {
  let got;
  for (const c of Array.isArray(msg?.content) ? msg.content : []) {
    if (c?.type !== "tool_use") continue;
    const i = c.input ?? {};
    if (/imprimatur__/.test(c.name ?? "")) {
      const k = [i.task, i.key].find((v) => typeof v === "string" && TICKET.test(v));
      if (k) got = k;
    }
    const sw = typeof i.command === "string" ? /git (?:switch|checkout)\s+(?:-q\s+)?(?:-[cb]\s+)?(\S+\/\S+)/.exec(i.command) : null;
    if (sw && ticketOfBranch(sw[1])) got = ticketOfBranch(sw[1]);
  }
  return got;
}

/** Reads what a file gained since last time into its state. @param {string} file @param {FileState} st */
function readNew(file, st) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < st.offset) Object.assign(st, { offset: 0, current: undefined, seen: new Set(), sums: new Map() }); // rewritten
    const buf = Buffer.alloc(size - st.offset);
    fs.readSync(fd, buf, 0, buf.length, st.offset);
    const text = buf.toString("utf8");
    // Only whole lines: a line still being written is read next time.
    const end = text.lastIndexOf("\n") + 1;
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.includes('"assistant"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "assistant") continue;
      st.current = namedIn(o.message) ?? st.current;
      const u = o.message?.usage;
      const id = o.message?.id;
      if (!u || !id || st.seen.has(id)) continue;
      st.seen.add(id);
      const key = ticketOfBranch(o.gitBranch) ?? st.current;
      if (!key) continue;
      const s = st.sums.get(key) ?? { written: 0, cached: 0, output: 0, sessions: new Set() };
      s.written += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      s.cached += u.cache_read_input_tokens ?? 0;
      s.output += u.output_tokens ?? 0;
      if (o.sessionId) s.sessions.add(o.sessionId);
      st.sums.set(key, s);
    }
    st.offset += Buffer.byteLength(text.slice(0, end), "utf8");
    st.size = size;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Tokens per ticket over a repo's transcript folder.
 * @param {string} projectDir ~/.claude/projects/<repo slug>
 * @returns {Map<string, {written: number, cached: number, output: number, sessions: number}>}
 */
function ticketTokens(projectDir) {
  let names = [];
  try {
    names = fs.readdirSync(projectDir).filter((n) => n.endsWith(".jsonl"));
  } catch {}
  /** @type {Map<string, Sum>} */
  const all = new Map();
  for (const n of names) {
    const file = path.join(projectDir, n);
    let st = cache.get(file);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (!st) cache.set(file, (st = { size: -1, offset: 0, seen: new Set(), sums: new Map() }));
    if (st.size !== size) {
      try {
        readNew(file, st);
      } catch {}
    }
    for (const [k, s] of st.sums) {
      const a = all.get(k) ?? { written: 0, cached: 0, output: 0, sessions: new Set() };
      a.written += s.written;
      a.cached += s.cached;
      a.output += s.output;
      for (const x of s.sessions) a.sessions.add(x);
      all.set(k, a);
    }
  }
  return new Map([...all].map(([k, s]) => [k, { written: s.written, cached: s.cached, output: s.output, sessions: s.sessions.size }]));
}

/** The repo's transcript folder, named the way Claude Code names it (agent-setup.js projectSlug). @param {string} root */
const projectDirOf = (root) => path.join(require("node:os").homedir(), ".claude", "projects", require("./agent-setup.js").projectSlug(root));

module.exports = { ticketTokens, ticketOfBranch, namedIn, projectDirOf };
