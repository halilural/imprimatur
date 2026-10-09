// @ts-check
// Everything the agent does (#55): an async PostToolUse / PostToolUseFailure
// hook (hooks/activity.mjs) writes one short row per tool call to
// .claude/imprimatur/activity/<session>.jsonl; the graph shows them in their
// task's lane, filtered by kind, a subagent's calls grouped under its Agent row.
// Rows keep summaries, not whole inputs or outputs: a Read's file, a Grep's
// pattern, a fetch's address, a subagent's description and how much it did.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ACTIVITY_DIR = path.join(".claude", "imprimatur", "activity");
const KINDS = ["edit", "bash", "read", "search", "web", "mcp", "agent", "skill", "other"];

/** @param {string} tool @returns {string} */
function kindOf(tool) {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return "edit";
  if (tool === "Bash" || tool === "BashOutput" || tool === "KillShell") return "bash";
  if (tool === "Read") return "read";
  if (/^(Grep|Glob|LS|ToolSearch)$/.test(tool)) return "search";
  if (/^Web(Fetch|Search)$/.test(tool)) return "web";
  if (tool.startsWith("mcp__")) return "mcp";
  if (tool === "Agent" || tool === "Task") return "agent";
  if (tool === "Skill") return "skill";
  return "other";
}

/** @param {any} v @param {number} n */
const cut = (v, n) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** A path relative to the repo when inside it. @param {string} root @param {any} p */
const rel = (root, p) => {
  if (typeof p !== "string" || !p) return "";
  const r = path.relative(root, path.resolve(root, p));
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
};

/** What the call asked for, in a line. @param {string} root @param {string} tool @param {any} i */
function whatOf(root, tool, i = {}) {
  switch (kindOf(tool)) {
    case "edit":
      return rel(root, i.file_path ?? i.notebook_path);
    case "bash":
      return i.description ? `${i.description} — ${i.command ?? ""}` : (i.command ?? i.bash_id ?? tool);
    case "read":
      return `${rel(root, i.file_path)}${i.offset ? ` @${i.offset}` : ""}`;
    case "search":
      return [i.pattern ?? i.query, i.path && rel(root, i.path), i.glob, i.type].filter(Boolean).join(" · ");
    case "web":
      return i.url ?? i.query ?? "";
    case "mcp": {
      const [, server, name] = /^mcp__(.+?)__(.+)$/.exec(tool) ?? [];
      const args = Object.entries(i).filter(([k]) => k !== "_session").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
      return `${server}: ${name}${args ? ` ${args}` : ""}`;
    }
    case "agent":
      return `${i.subagent_type ? `${i.subagent_type}: ` : ""}${i.description ?? i.prompt ?? ""}`;
    case "skill":
      return `${i.skill ?? i.name ?? i.command ?? ""}${i.args ? ` ${i.args}` : ""}`;
    default:
      return `${tool}${Object.keys(i).length ? ` ${JSON.stringify(i)}` : ""}`;
  }
}

/** What came back, in a line. @param {string} tool @param {any} r */
function outOf(tool, r) {
  if (r == null) return "";
  if (kindOf(tool) === "agent" && typeof r === "object") {
    const bits = [r.status, r.totalToolUseCount != null && `${r.totalToolUseCount} calls`, r.totalTokens != null && `${r.totalTokens} tokens`, r.totalDurationMs != null && `${Math.round(r.totalDurationMs / 1000)} s`];
    return bits.filter(Boolean).join(" · ");
  }
  if (typeof r === "string") return r;
  if (Array.isArray(r?.content)) return r.content.map((c) => c?.text ?? "").join(" ");
  if (typeof r?.stdout === "string") return r.stdout || r.stderr || "";
  if (r?.file?.numLines != null) return `${r.file.numLines} lines`;
  if (Array.isArray(r?.filenames)) return `${r.numFiles ?? r.filenames.length} files`;
  if (r?.result != null) return String(r.result);
  return JSON.stringify(r);
}

/**
 * The row for one finished (or failed) tool call, from the hook's input.
 * @param {string} root @param {any} input
 */
function rowOf(root, input) {
  const tool = String(input.tool_name ?? "");
  const r = input.tool_response;
  return {
    t: new Date().toISOString(),
    session: input.session_id,
    id: input.tool_use_id,
    tool,
    kind: kindOf(tool),
    what: cut(whatOf(root, tool, input.tool_input), 160),
    out: cut(input.error ?? outOf(tool, r), 240),
    ...(input.duration_ms != null && { ms: input.duration_ms }),
    ...(input.agent_id && { agent: input.agent_id, agentType: input.agent_type }),
    ...(kindOf(tool) === "agent" && r?.agentId && { agentId: r.agentId }),
    ...((input.hook_event_name === "PostToolUseFailure" || input.error) && { failed: true }),
  };
}

/** Appends a call's row to its session's log. @param {string} root @param {any} input */
function record(root, input) {
  if (!input?.tool_name || !/^[\w-]+$/.test(String(input.session_id ?? ""))) return;
  const dir = path.join(root, ACTIVITY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${input.session_id}.jsonl`), JSON.stringify(rowOf(root, input)) + "\n");
}

/** Parsed logs, read again only when a file changed. @type {Map<string, {key: string, rows: any[]}>} */
const cache = new Map();

/** Every activity row of a repo, oldest first. @param {string} root @returns {any[]} */
function activityOf(root) {
  const dir = path.join(root, ACTIVITY_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let key = "";
    try {
      const st = fs.statSync(file);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      continue;
    }
    let hit = cache.get(file);
    if (!hit || hit.key !== key) {
      const parsed = [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          parsed.push(JSON.parse(line));
        } catch {}
      }
      hit = { key, rows: parsed };
      cache.set(file, hit);
    }
    rows.push(...hit.rows);
  }
  return rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

module.exports = { ACTIVITY_DIR, KINDS, kindOf, whatOf, outOf, rowOf, record, activityOf };
