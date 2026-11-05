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
 *   hooks: Map<string, {event: string, script: string, abs: string, runs: number, ms: number, chars: number, total: number, adds: number, first: string, tools: Set<string>}>,
 *   mcp: Map<string, number>, tools: Map<string, Set<string>>, failed: Map<string, string>, needsAuth: Set<string>,
 *   skills: {names: Set<string>, chars: number}, agents: Set<string>, model: string, mode: Record<string, unknown>, context: Map<string, number>,
 *   used: Map<string, number>}} SessionState
 */

/** @returns {SessionState} */
const empty = () => ({
  instructions: new Map(), hooks: new Map(), mcp: new Map(), tools: new Map(), failed: new Map(), needsAuth: new Set(),
  skills: { names: new Set(), chars: 0 }, agents: new Set(), model: "", mode: {}, context: new Map(), used: new Map(),
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
  // The tools the agent called, by server (#29): an MCP server never called is a removal candidate.
  if (line.includes('"tool_use"') && line.includes('"assistant"')) {
    try {
      for (const p of JSON.parse(line).message?.content ?? [])
        if (p?.type === "tool_use" && typeof p.name === "string") {
          const server = p.name.startsWith("mcp__") ? p.name.split("__")[1] : "Claude Code";
          s.used.set(server, (s.used.get(server) ?? 0) + 1);
        }
    } catch {}
    return;
  }
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
      // Keyed by the script's path: two copies of one plugin (two scopes) stay two rows (#145).
      const key = `${a.hookEvent} ${abs || script}`;
      const h = s.hooks.get(key) ?? { event: String(a.hookEvent), script, abs, runs: 0, ms: 0, chars: 0, total: 0, adds: 0, first: "", tools: new Set() };
      // "PreToolUse:mcp__x__y": the tool it ran for, to name a hook Claude Code logged without its command.
      const tool = String(a.hookName ?? "").split(":").slice(1).join(":");
      if (tool) h.tools.add(tool);
      // Claude Code may log a hook's status message as its command and its output as content.
      const text = injected(a) || String(a.content ?? "");
      h.runs++;
      h.ms += Number(a.durationMs) || 0;
      if (text) Object.assign(h, { chars: text.length, total: h.total + text.length, adds: h.adds + 1, first: text.split("\n", 1)[0].slice(0, 120) });
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

/**
 * A hook Claude Code logged as "command hook": named by the configured hooks of its event
 * whose matcher fits the tools it ran for; unchanged when none fits. @param {{event: string, script: string, tools: Set<string>}} h @param {Array<{event: string, matcher: string, script: string}>} configured
 */
function nameOf(h, configured) {
  // No regex is compiled: a matcher comes from settings files a repo may hold (ReDoS). Exact
  // names split on "|", a trailing ".*" or "*" as a prefix; any other pattern may fit.
  const fits = (/** @type {string} */ m, /** @type {string} */ t) => {
    if (!m || m === "*" || m.length > 300) return true;
    return m.split("|").some((alt) => {
      const prefix = /^([\w.:-]*?)(?:\.\*|\*)$/.exec(alt);
      if (prefix) return t.startsWith(prefix[1]);
      return /^[\w:-]+$/.test(alt) ? alt === t : true;
    });
  };
  const tools = [...h.tools];
  const names = [...new Set(configured.filter((c) => c.event === h.event && (!tools.length || tools.some((t) => fits(c.matcher, t)))).map((c) => c.script))];
  if (!names.length) return h.script;
  return names.length === 1 ? names[0] : `one of ${names.join(", ")}`;
}

/** @param {number} ms */
const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
/** @param {string} p @param {string} home */
const tildeOf = (p, home) => (p && p.startsWith(home) ? `~${p.slice(home.length)}` : p || "?");

/** Characters shown as estimated tokens (#29). @param {number} n */
const chars = (n) => `~${tokensOf(n).toLocaleString("en-US")} tokens`;

/**
 * Agent setup rows for what the last session in this project saw (#139), tool "This session".
 * The hash is what the row says, so a change from one session to the next shows as "changed".
 * @param {string} projectDir ~/.claude/projects/<slug> @param {string} home
 * @param {Array<{event: string, matcher: string, script: string}>} [configured] the hooks the settings and plugins define, to name the ones logged without a command
 * @returns {any[]} SetupItem rows; abs "" for a row with no file to open
 */
function sessionItems(projectDir, home, configured = []) {
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
  const hooks = [...s.hooks.values()].map((h) => (h.abs || !/^command hook\b/.test(h.script) ? h : { ...h, script: nameOf(h, configured) }));
  // The same hook from more than one file: a plugin installed at two scopes runs twice.
  const copies = (/** @type {typeof hooks[number]} */ h) => hooks.filter((x) => x.event === h.event && x.script === h.script).length;
  for (const h of hooks.sort((a, b) => b.ms - a.ms)) {
    const twice = copies(h) > 1;
    row("hook output", `${h.event}: ${h.script}${twice ? " (copy)" : ""}`,
      [`${secs(h.ms)} in all`, `${h.runs} runs`, `${Math.round(h.ms / h.runs)} ms each`, h.total && `adds ${chars(h.total)}`, twice && `runs ${copies(h)} times: ${copies(h)} copies installed`].filter(Boolean).join(" · "),
      h.abs, [...(twice ? [`from ${tildeOf(h.abs, home)}`] : []), ...(h.first ? [h.first] : [])]);
  }
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

/**
 * Tokens from characters (#29): about 4 characters a token for English prose and code, the
 * rule of thumb Anthropic gives for Claude's tokenizer. An estimate, shown as "~"; Claude
 * Code's /context has the exact count. @param {number} chars
 */
const tokensOf = (chars) => Math.round(chars / 4);

/** Large enough to warn about (#29): an item that alone takes a noticeable part of every session. */
const LARGE = 5000;

/**
 * The context budget of the last session (#29): what was loaded into the model's context,
 * item by item, with estimated tokens, biggest first, and a suggestion for the big or unused
 * ones. Tool definitions are not in the transcript: they are counted as tools, not tokens.
 * @param {string} projectDir @param {string} home @param {Array<{event: string, matcher: string, script: string}>} [configured]
 * @returns {{total: number, rows: Array<{label: string, kind: string, tokens: number, detail: string, abs: string, suggestion: string}>, uncounted: string[]} | undefined}
 */
function sessionBudget(projectDir, home, configured = []) {
  const file = newestTranscript(projectDir);
  const s = file && stateOf(file);
  if (!s) return undefined;
  const tilde = (/** @type {string} */ p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  /** @type {Array<{label: string, kind: string, tokens: number, detail: string, abs: string, suggestion: string}>} */
  const rows = [];
  for (const [p, f] of s.instructions) {
    const t = tokensOf(f.chars);
    rows.push({ label: tilde(p), kind: "instructions", tokens: t, detail: `${f.type} · loaded every session`, abs: p,
      suggestion: t >= 2000 ? `Move the sections the agent needs only now and then into a skill or an on-demand file: halving it saves ~${Math.round(t / 2).toLocaleString("en-US")} tokens a session.` : "" });
  }
  for (const h of s.hooks.values()) {
    if (!h.total) continue;
    // What it added over the session: each run's text, not the last one times the runs.
    const t = tokensOf(h.total);
    const each = Math.round(t / h.adds);
    const name = h.abs || !/^command hook\b/.test(h.script) ? h.script : nameOf(h, configured);
    rows.push({ label: `${h.event}: ${name}`, kind: "hook output", tokens: t, detail: `~${each.toLocaleString("en-US")} tokens on ${h.adds} of ${h.runs} run${h.runs === 1 ? "" : "s"} · ${secs(h.ms)} in all`, abs: h.abs,
      suggestion: h.adds > 1 && each >= 100 ? `It adds ~${each.toLocaleString("en-US")} tokens each time: shorter output, or adding text only when something changed, saves most of ~${t.toLocaleString("en-US")}.` : t >= 1500 ? `A shorter summary saves part of ~${t.toLocaleString("en-US")} tokens a session.` : "" });
  }
  for (const [n, c] of s.mcp) {
    const t = tokensOf(c);
    const calls = s.used.get(n.replace(/^claude\.ai /, "claude_ai_").replace(/ /g, "_")) ?? s.used.get(n) ?? 0;
    rows.push({ label: n, kind: "MCP instructions", tokens: t, detail: `${calls} call${calls === 1 ? "" : "s"} this session`, abs: "",
      suggestion: calls ? "" : `Not called in the last session: turning this server off in repos that do not need it saves ~${t.toLocaleString("en-US")} tokens of instructions plus its tool definitions.` });
  }
  if (s.skills.chars) {
    const t = tokensOf(s.skills.chars);
    rows.push({ label: `${s.skills.names.size} skills listed`, kind: "listings", tokens: t, detail: "names and descriptions, every session", abs: "",
      suggestion: t >= 2000 ? `Each skill's description is listed every session: turning off plugins whose skills this repo never uses saves part of ~${t.toLocaleString("en-US")}.` : "" });
  }
  for (const [k, c] of s.context) rows.push({ label: `context: ${k}`, kind: "session context", tokens: tokensOf(c), detail: "added by Claude Code", abs: "", suggestion: "" });
  rows.sort((a, b) => b.tokens - a.tokens);
  const toolCount = [...s.tools.values()].reduce((n, set) => n + set.size, 0);
  const uncounted = [toolCount && `${toolCount} tool definitions (their schemas are not in the transcript; /context counts them)`, s.agents.size && `${s.agents.size} agent descriptions`].filter(Boolean).map(String);
  return { total: rows.reduce((n, r) => n + r.tokens, 0), rows, uncounted };
}

module.exports = { MEMORY, LARGE, tokensOf, sessionBudget, sessionItems, stateOf, fold, empty, injected, hookScript, newestTranscript };
