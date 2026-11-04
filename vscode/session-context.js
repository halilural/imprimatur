// @ts-check
// What the agent saw in its last session in a repo (#139): Claude Code writes it into the
// session's transcript as attachments: the instruction files it loaded, each hook's output
// (and how long it took), the MCP servers' instructions, the tools, skills and agents it
// was told about, the model and the mode. Read from the newest transcript of the repo's
// project folder; a growing transcript is read from where the last read stopped.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {{instructions: Map<string, {type: string, chars: number}>,
 *   hooks: Map<string, {event: string, script: string, abs: string, runs: number, ms: number, chars: number, first: string}>,
 *   mcp: Map<string, number>, tools: Map<string, Set<string>>, failed: Map<string, string>, needsAuth: Set<string>,
 *   skills: {names: Set<string>, chars: number}, agents: Set<string>, model: string, mode: Record<string, unknown>, context: Map<string, number>}} SessionState
 */

/** @returns {SessionState} */
const empty = () => ({
  instructions: new Map(), hooks: new Map(), mcp: new Map(), tools: new Map(), failed: new Map(), needsAuth: new Set(),
  skills: { names: new Set(), chars: 0 }, agents: new Set(), model: "", mode: {}, context: new Map(),
});

/** What a hook's run put into the session: its additionalContext / systemMessage, else plain stdout. @param {any} a */
function injected(a) {
  const out = String(a.stdout ?? "").trim();
  if (!out) return "";
  try {
    const j = JSON.parse(out);
    return String(j?.hookSpecificOutput?.additionalContext ?? j?.systemMessage ?? "");
  } catch {
    // Plain stdout reaches the model only from SessionStart and UserPromptSubmit.
    return /^(SessionStart|UserPromptSubmit)$/.test(a.hookEvent) ? out : "";
  }
}

/** A hook command's script and its path; a plugin's script is named with its plugin. @param {string} cmd */
function hookScript(cmd) {
  const abs = /(\/[^\s"']+\.(?:sh|mjs|js|cjs|py|ts))\b/.exec(cmd)?.[1] ?? "";
  const plugin = /\/plugins\/cache\/[^/]+\/([^/]+)\//.exec(abs)?.[1];
  // No script: Claude Code logged the hook's status message ("Loading ponytail mode...") instead.
  const base = abs ? path.basename(abs) : cmd.trim().replace(/\.{3}$/, "").slice(0, 40);
  return { abs, script: plugin ? `${plugin}: ${base}` : base };
}

/** Folds one transcript line into the state; lines that are not attachments are skipped cheaply. @param {SessionState} s @param {string} line */
function fold(s, line) {
  if (!line.includes('"attachment"')) return;
  let a;
  try {
    a = JSON.parse(line).attachment;
  } catch {
    return;
  }
  if (!a || typeof a !== "object") return;
  switch (a.type) {
    case "instructions":
      for (const f of a.files ?? []) s.instructions.set(String(f.path), { type: String(f.type ?? ""), chars: String(f.content ?? "").length });
      break;
    case "hook_success": {
      const { abs, script } = hookScript(String(a.command ?? ""));
      const key = `${a.hookEvent} ${script}`;
      const h = s.hooks.get(key) ?? { event: String(a.hookEvent), script, abs, runs: 0, ms: 0, chars: 0, first: "" };
      // Claude Code may log a hook's status message as its command and its output as content.
      const text = injected(a) || String(a.content ?? "");
      h.runs++;
      h.ms += Number(a.durationMs) || 0;
      if (text) Object.assign(h, { chars: text.length, first: text.split("\n", 1)[0].slice(0, 120) });
      s.hooks.set(key, h);
      break;
    }
    case "mcp_instructions_delta":
      for (const n of a.removedNames ?? []) s.mcp.delete(n);
      (a.addedNames ?? []).forEach((/** @type {string} */ n, /** @type {number} */ i) => s.mcp.set(n, String(a.addedBlocks?.[i] ?? "").length));
      break;
    case "deferred_tools_delta":
      for (const n of [...(a.addedNames ?? []), ...(a.surfacedNames ?? [])]) {
        const server = n.startsWith("mcp__") ? n.split("__")[1] : "Claude Code";
        s.tools.set(server, (s.tools.get(server) ?? new Set()).add(n));
      }
      for (const n of a.removedNames ?? []) for (const set of s.tools.values()) set.delete(n);
      for (const f of a.failedMcpServers ?? []) s.failed.set(String(f.name), String(f.errorCode ?? f.error ?? "failed"));
      for (const n of a.needsAuthMcpServers ?? []) s.needsAuth.add(String(n));
      break;
    case "skill_listing":
      // The first listing is the whole list; later ones add to it.
      if (a.isInitial) s.skills = { names: new Set(), chars: 0 };
      for (const n of a.names ?? []) s.skills.names.add(String(n));
      s.skills.chars += String(a.content ?? "").length;
      break;
    case "agent_listing_delta":
      for (const t of a.removedTypes ?? []) s.agents.delete(t);
      for (const t of a.addedTypes ?? []) s.agents.add(t);
      break;
    case "model":
      s.model = String(a.identity?.marketingName ?? a.identity?.modelId ?? "");
      break;
    case "auto_mode":
      s.mode = { auto: true, ...a };
      delete s.mode.type;
      break;
    case "session_context":
      for (const [k, v] of Object.entries(a.context ?? {})) s.context.set(k, String(v).length);
      break;
  }
}

/** The newest transcript in a Claude Code project folder, or undefined. @param {string} dir */
function newestTranscript(dir) {
  let best;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith(".jsonl")) continue;
      const st = fs.statSync(path.join(dir, n));
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: path.join(dir, n), mtimeMs: st.mtimeMs };
    }
  } catch {
    return undefined;
  }
  return best?.file;
}

/** Per transcript: how far it was read, the unfinished last line, the state so far. @type {Map<string, {offset: number, rest: string, state: SessionState}>} */
const read = new Map();
/** Transcripts kept read at once: one per open repo is plenty. */
const KEEP = 8;

/**
 * The state of a transcript, reading only what was appended since the last call
 * (transcripts reach tens of MB). A file that shrank is read again from the start.
 * @param {string} file @returns {SessionState | undefined}
 */
function stateOf(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return undefined;
  }
  let r = read.get(file);
  if (!r || size < r.offset) r = { offset: 0, rest: "", state: empty() };
  if (size > r.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - r.offset);
      fs.readSync(fd, buf, 0, buf.length, r.offset);
      const lines = (r.rest + buf.toString("utf8")).split("\n");
      r.rest = /** @type {string} */ (lines.pop());
      for (const l of lines) fold(r.state, l);
      r.offset = size;
    } finally {
      fs.closeSync(fd);
    }
  }
  read.delete(file);
  read.set(file, r);
  if (read.size > KEEP) read.delete(/** @type {string} */ (read.keys().next().value));
  return r.state;
}

/** Servers and stores that hold memory across sessions (Nook, Notion memory, mem0, claude-mem, …). */
const MEMORY = /nook|notion|mem0|claude-mem|supermemory|memory|letta|zep|context-mode/i;

/** @param {number} n */
const chars = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k chars` : `${n} chars`);

/**
 * Agent setup rows for what the last session in this project saw (#139), tool "This session".
 * The hash is what the row says, so a change from one session to the next shows as "changed".
 * @param {string} projectDir ~/.claude/projects/<slug> @param {string} home
 * @returns {any[]} SetupItem rows; abs "" for a row with no file to open
 */
function sessionItems(projectDir, home) {
  const file = newestTranscript(projectDir);
  const s = file && stateOf(file);
  if (!s) return [];
  /** @type {any[]} */
  const out = [];
  /** @param {string} kind @param {string} label @param {string} summary @param {string} [abs] @param {string[]} [details] */
  const row = (kind, label, summary, abs = "", details = []) =>
    out.push({ rel: `session: ${kind}: ${label}`, abs, tool: "This session", kind, label, summary, details, hash: summary });
  const tilde = (/** @type {string} */ p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  for (const [p, f] of s.instructions) row("loaded instructions", tilde(p), `${f.type} · ${chars(f.chars)}`, p);
  for (const h of [...s.hooks.values()].sort((a, b) => b.ms - a.ms))
    row("hook output", `${h.event}: ${h.script}`, [`${h.runs} runs`, `${Math.round(h.ms / h.runs)} ms each`, h.chars && `adds ${chars(h.chars)}`].filter(Boolean).join(" · "), h.abs, h.first ? [h.first] : []);
  for (const [n, c] of s.mcp) row("MCP instructions", n, chars(c));
  for (const [server, set] of [...s.tools].sort((a, b) => b[1].size - a[1].size)) if (set.size) row("tools", server, `${set.size} tools`);
  for (const [n, why] of s.failed) row("tools", n, `failed to connect: ${why}`);
  for (const n of s.needsAuth) row("tools", n, "needs sign-in");
  // Data sources (#139, PDR 9345): listed, never read — their content is not vetted.
  // A connector is "claude_ai_Nook" in tool names and "claude.ai Nook" in its instructions.
  for (const n of new Set([...s.tools.keys(), ...s.mcp.keys()].map((k) => k.replace(/^claude_ai_/, "claude.ai ").replace(/_/g, " "))))
    if (MEMORY.test(n)) row("data sources", n, "memory connected in this session · what it returns reaches the agent unvetted");
  if (s.skills.names.size) row("listings", "skills", `${s.skills.names.size} skills · ${chars(s.skills.chars)}`);
  if (s.agents.size) row("listings", "agents", `${s.agents.size} agents: ${[...s.agents].join(", ")}`);
  if (s.model) row("model and mode", "model", s.model);
  if (s.mode.auto) row("model and mode", "auto mode", Object.entries(s.mode).filter(([k, v]) => k !== "auto" && v === true).map(([k]) => k).join(", ") || "on");
  for (const [k, c] of s.context) row("model and mode", `context: ${k}`, chars(c));
  return out;
}

module.exports = { MEMORY, sessionItems, stateOf, fold, empty, injected, hookScript, newestTranscript };
