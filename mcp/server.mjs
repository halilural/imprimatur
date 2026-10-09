#!/usr/bin/env node
// Imprimatur MCP server (#58): agents read and write tasks and their records
// (todos, questions, answers, decisions, notes, ADRs, PDRs) through these tools
// only; the database (vscode/db.js) is the source of truth. stdio, no
// dependencies: newline-delimited JSON-RPC, both protocol eras
// (2026-07-28 `server/discover` + per-request _meta, and the older
// `initialize` handshake). stdout carries MCP messages only; logs go to stderr.
// - Repo: the `repo` argument, else CLAUDE_PROJECT_DIR, else the cwd; its git root.
// - Who: a PreToolUse hook (hooks/mcp-session.mjs) adds `_session` to Claude
//   Code's calls; other clients are named by their clientInfo.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { openDb, KINDS } = require("../vscode/db.js");
const { repoRoot } = require("../vscode/review-state.js");

const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "imprimatur", version: "0.1.0" };
const META = "io.modelcontextprotocol/";

const repoArg = { type: "string", description: "Absolute path inside the repo; default: the project the agent runs in" };
const sessionArg = { type: "string", description: "Set by Imprimatur's hook; leave empty" };
const recordFields = {
  title: { type: "string", description: "One line, understandable a week later without the chat" },
  body: { type: "string", description: "Details, result, reasoning (Markdown)" },
  owner: { type: "string", enum: ["C", "K"], description: "C = the agent does it, K = the user does it" },
  status: { type: "string", enum: ["open", "done", "dropped"] },
  parent_id: { type: "integer", description: "For an answer: the question's record id" },
  links: { type: "object", description: "Related things, e.g. {issue: 58, files: [...], commit: \"abc123\"}" },
};

/** @type {Array<{name: string, description: string, inputSchema: any, readOnly?: boolean}>} */
const TOOLS = [
  {
    name: "where_we_left_off",
    description: "Unfinished tasks of the repo, each with its 👉 record (where work stopped) and how many records are open. Call at the start of a session.",
    inputSchema: { type: "object", properties: { repo: repoArg, _session: sessionArg } },
    readOnly: true,
  },
  {
    name: "task_list",
    description: "Tasks of the repo, most recently updated first.",
    inputSchema: {
      type: "object",
      properties: { repo: repoArg, status: { type: "string", enum: ["open", "active", "done", "dropped"] }, _session: sessionArg },
    },
    readOnly: true,
  },
  {
    name: "task_get",
    description: "A task and its records in order (todos, questions, answers, decisions, notes, ADRs, PDRs).",
    inputSchema: {
      type: "object",
      properties: { repo: repoArg, key: { type: "string", description: "\"#58\" or a Jira key" }, dropped: { type: "boolean" }, _session: sessionArg },
      required: ["key"],
    },
    readOnly: true,
  },
  {
    name: "task_upsert",
    description: "Creates the task or updates its title, status, summary (the one-line \"where we are\") or epic.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoArg,
        key: { type: "string", description: "\"#58\" or a Jira key" },
        title: { type: "string" },
        status: { type: "string", enum: ["open", "active", "done", "dropped"] },
        summary: { type: "string" },
        epic: { type: "string", description: "The epic's key, e.g. \"#53\"" },
        _session: sessionArg,
      },
      required: ["key"],
    },
  },
  {
    name: "record_add",
    description: "Adds a record to a task (created if missing): todo, question (to the user), answer, decision, note, fixme, adr (architecture), pdr (product), test. pointer=true moves the task's 👉 to it.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoArg,
        task: { type: "string", description: "Task key, e.g. \"#58\"" },
        kind: { type: "string", enum: KINDS },
        ...recordFields,
        pointer: { type: "boolean" },
        _session: sessionArg,
      },
      required: ["task", "kind", "title"],
    },
  },
  {
    name: "record_update",
    description: "Changes a record (e.g. status done with the result in body). Only the given fields change; every change is versioned.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" }, kind: { type: "string", enum: KINDS }, ...recordFields, position: { type: "number" }, _session: sessionArg },
      required: ["id"],
    },
  },
  {
    name: "pointer_set",
    description: "Moves the task's 👉 (where we left off) to this open record.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, _session: sessionArg }, required: ["id"] },
  },
  {
    name: "search",
    description: "Records whose title or body contains the text, newest first. repo \"*\" searches every repo.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, repo: repoArg, kind: { type: "string", enum: KINDS }, limit: { type: "integer" }, _session: sessionArg },
      required: ["text"],
    },
    readOnly: true,
  },
];

class ToolError extends Error {}

/** @param {any} db @param {string | undefined} repo */
function repoId(db, repo) {
  const start = repo || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = repoRoot(path.resolve(start));
  if (!root) throw new ToolError(`${start} is not inside a git repo; pass repo`);
  return db.repoOf(root).id;
}

/** @param {any} db @param {number} rid @param {string} key */
function taskOf(db, rid, key) {
  const task = db.taskByKey(rid, key);
  if (!task) throw new ToolError(`no task ${key} in this repo`);
  return task;
}

/** Checks the arguments the tools rely on; the schema is advisory to clients. @param {string} name @param {any} a */
function validate(name, a) {
  const id = (k) => {
    if (a[k] !== undefined && !Number.isSafeInteger(a[k])) throw new ToolError(`${k} must be an integer record id`);
  };
  if (["record_update", "pointer_set"].includes(name) && a.id === undefined) throw new ToolError("id is required");
  id("id");
  id("parent_id");
  for (const k of ["key", "task", "kind", "title", "text"]) {
    if (a[k] !== undefined && (typeof a[k] !== "string" || !a[k].trim())) throw new ToolError(`${k} must be a non-empty string`);
  }
  if (a.limit !== undefined) {
    if (!Number.isSafeInteger(a.limit)) throw new ToolError("limit must be an integer");
    a.limit = Math.min(Math.max(a.limit, 1), 100);
  }
  for (const k of ["key", "task", "epic"]) if (typeof a[k] === "string") a[k] = a[k].trim();
}

/** @param {Record<string, any>} a @param {string[]} keys */
const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

/**
 * Runs one tool. @param {any} db @param {string} name @param {any} a @param {{client: string}} ctx
 */
export function callTool(db, name, a, ctx = { client: "unknown" }) {
  if (!TOOLS.some((t) => t.name === name)) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  if (a == null) a = {};
  if (typeof a !== "object" || Array.isArray(a)) throw new ToolError("arguments must be an object");
  for (const t of TOOLS.find((t) => t.name === name).inputSchema.required ?? []) {
    if (a[t] === undefined) throw new ToolError(`${t} is required`);
  }
  validate(name, a);
  if (!db.sqlite) throw new ToolError(db.error);
  const actor = { kind: "agent", id: a._session ? `${ctx.client}:${a._session}` : ctx.client };
  switch (name) {
    case "where_we_left_off":
      return { tasks: db.whereWeLeftOff(repoId(db, a.repo)) };
    case "task_list":
      return { tasks: db.tasksOf(repoId(db, a.repo), { status: a.status }) };
    case "task_get": {
      const task = taskOf(db, repoId(db, a.repo), a.key);
      return { task, records: db.recordsOf(task.id, { dropped: a.dropped }) };
    }
    case "task_upsert": {
      const rid = repoId(db, a.repo);
      const fields = pick(a, ["title", "status", "summary"]);
      if (a.epic) fields.epicId = (db.taskByKey(rid, a.epic) ?? db.upsertTask(rid, a.epic)).id;
      return { task: db.upsertTask(rid, a.key, fields) };
    }
    case "record_add": {
      const rid = repoId(db, a.repo);
      const task = db.taskByKey(rid, a.task) ?? db.upsertTask(rid, a.task);
      return { record: db.addRecord(task.id, pick(a, ["kind", "title", "body", "owner", "status", "parent_id", "links", "pointer"]), actor) };
    }
    case "record_update":
      return { record: db.updateRecord(a.id, pick(a, ["kind", "title", "body", "owner", "status", "parent_id", "links", "position"]), actor) };
    case "pointer_set":
      return { record: db.setPointer(a.id, actor) };
    case "search":
      return { records: db.search(a.text, { repoId: a.repo === "*" ? undefined : repoId(db, a.repo), kind: a.kind, limit: a.limit }) };
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

const toolList = () =>
  TOOLS.map(({ readOnly, ...t }) => ({ ...t, annotations: { readOnlyHint: Boolean(readOnly), destructiveHint: false } }));

/**
 * Answers one JSON-RPC message; undefined for notifications.
 * @param {any} db @param {any} msg @param {{client: string, version?: string}} state
 */
export function handle(db, msg, state) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const { id, method } = msg;
  const params = msg.params ?? {};
  // Notifications, and responses to requests we never send, get no reply.
  if (id === undefined || id === null || typeof method !== "string") return undefined;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data && { data }) } });
  const meta = params._meta ?? {};
  const requested = meta[`${META}protocolVersion`];
  if (meta[`${META}clientInfo`]?.name) state.client = meta[`${META}clientInfo`].name;
  if (requested && requested !== MODERN && method !== "initialize") {
    return fail(-32022, "Unsupported protocol version", { supported: [MODERN], requested });
  }
  const modern = Boolean(requested);
  const done = (result) => ok(modern ? { resultType: "complete", ...result } : result);
  try {
    switch (method) {
      case "server/discover":
        return done({ supportedVersions: [MODERN], capabilities: { tools: {} }, _meta: { [`${META}serverInfo`]: SERVER } });
      case "initialize": {
        if (params.clientInfo?.name) state.client = params.clientInfo.name;
        const v = LEGACY.includes(params.protocolVersion) ? params.protocolVersion : LEGACY[0];
        state.version = v;
        return ok({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: SERVER });
      }
      case "ping":
        return done({});
      case "tools/list":
        // 2026-07-28 list results carry caching hints, which modern clients require. The tools
        // are the same for everyone and change only with a new server version.
        return done({ tools: toolList(), ...(modern && { ttlMs: 3_600_000, cacheScope: "public" }) });
      case "tools/call": {
        try {
          const out = callTool(db, params.name, params.arguments, state);
          return done({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
        } catch (e) {
          if (/** @type {any} */ (e).code === -32602) return fail(-32602, /** @type {Error} */ (e).message);
          // A tool's own failure goes back to the model, which can correct the call.
          return done({ content: [{ type: "text", text: `Error: ${/** @type {Error} */ (e).message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return fail(-32603, /** @type {Error} */ (e).message);
  }
}

/** The database, or a stand-in whose tools answer with why it could not open. */
function open() {
  try {
    return openDb();
  } catch (e) {
    const error = `Imprimatur database could not open: ${/** @type {Error} */ (e).message}`;
    process.stderr.write(error + "\n");
    return { error, close() {} };
  }
}

function main() {
  const db = open();
  const state = { client: "unknown" };
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    if (Array.isArray(msg)) {
      // JSON-RPC batch (older clients): one array back, none for all-notifications.
      const replies = msg.length
        ? msg.map((m) => handle(db, m, state)).filter(Boolean)
        : { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
      if (!Array.isArray(replies) || replies.length) process.stdout.write(JSON.stringify(replies) + "\n");
      return;
    }
    const reply = handle(db, msg, state);
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  });
  rl.on("close", () => {
    db.close();
    process.exit(0);
  });
}

/** @param {string} f */
const real = (f) => {
  try {
    return fs.realpathSync(f);
  } catch {
    return path.resolve(f);
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
