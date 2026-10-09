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


// What a client hands the model once, before any tool (#64): how the tools fit together.
export const INSTRUCTIONS = [
  "Imprimatur holds this repo's tasks and their records; it is the source of truth for where work stands.",
  "Call where_we_left_off first in every session.",
  "Tasks are keyed \"#58\" (a GitHub issue) or a Jira key such as \"PROJ-12\"; record_add creates a missing task.",
  "Record kinds: todo, question (to the user), answer (parent_id = the question's id), decision, note, fixme, adr (architecture), pdr (product), test.",
  "owner: C = the agent does it, K = the user does it.",
  "👉 is the task's pointer, where work stopped: pointer_set moves it (open records only), or record_add with pointer:true.",
  "Keep the task_upsert summary a one-line \"where we are\".",
  "When work is done, record_update that record with status \"done\" and the result in body.",
  "task_get returns open records by default; status \"all\", kind, limit/offset and full:true give more.",
  "search with repo \"*\" looks in every repo.",
  "Leave _session empty: Imprimatur's hook fills it.",
].join(" ");

const TASK_STATUS = ["open", "active", "done", "dropped"];
const RECORD_STATUS = ["open", "done", "dropped"];
const GET_STATUS = ["open", "done", "dropped", "all"];
const MAX_TITLE = 300;
const MAX_BODY = 20_000;
const BODY_CUT = 500;

const repoArg = { type: "string", description: "Absolute path inside the repo; default: the project the agent runs in" };
const sessionArg = { type: "string", description: "Set by Imprimatur's hook; leave empty" };
const keyArg = { type: "string", description: "\"#58\" or a Jira key" };
const recordFields = {
  title: { type: "string", maxLength: MAX_TITLE, description: "One line, understandable a week later without the chat" },
  body: { type: "string", maxLength: MAX_BODY, description: "Details, result, reasoning (Markdown)" },
  owner: { type: "string", enum: ["C", "K"], description: "C = the agent does it, K = the user does it" },
  status: { type: "string", enum: RECORD_STATUS },
  parent_id: { type: "integer", description: "For an answer: the question's record id" },
  links: { type: "object", description: "Related things, e.g. {issue: 58, files: [...], commit: \"abc123\"}" },
};

/** An input schema: unknown arguments are refused; `_session` is always allowed (the hook adds it). */
const input = (properties, required) => ({
  type: "object", properties: { ...properties, _session: sessionArg }, ...(required && { required }), additionalProperties: false,
});

// Output schemas describe structuredContent; the records and tasks are the database's rows.
const str = { type: "string" };
const int = { type: "integer" };
const orNull = (type) => ({ type: [type, "null"] });
const RECORD = {
  type: "object",
  properties: {
    id: int, uid: str, task_id: int, kind: { type: "string", enum: KINDS }, owner: orNull("string"),
    status: { type: "string", enum: RECORD_STATUS }, pointer: { type: "boolean" }, title: str, body: orNull("string"),
    position: { type: "number" }, parent_id: orNull("integer"), links: orNull("object"), created_at: int, updated_at: int,
    task_key: { type: "string", description: "search only" },
    body_truncated: { type: "boolean", description: "task_get: body cut to 500 chars; full:true gives all of it" },
  },
  required: ["id", "task_id", "kind", "status", "pointer", "title", "position", "created_at", "updated_at"],
};
const TASK = {
  type: "object",
  properties: {
    id: int, uid: str, repo_id: int, key: str, title: str, status: { type: "string", enum: TASK_STATUS },
    epic_id: orNull("integer"), summary: orNull("string"), created_at: int, updated_at: int,
  },
  required: ["id", "key", "title", "status", "created_at", "updated_at"],
};
const LEFT_OFF = {
  type: "object",
  properties: {
    key: str, title: str, status: str, summary: orNull("string"), pointer_id: orNull("integer"), pointer_kind: orNull("string"),
    pointer_owner: orNull("string"), pointer_title: orNull("string"), open_records: int,
  },
  required: ["key", "title", "status", "open_records"],
};
const output = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required });
const RECORD_OUT = output({ record: RECORD });

/**
 * @type {Array<{name: string, title: string, description: string, inputSchema: any, outputSchema: any,
 *   readOnly?: boolean, idempotent?: boolean}>}
 */
const TOOLS = [
  {
    name: "where_we_left_off",
    title: "Where we left off",
    description: "Unfinished tasks of the repo, each with its 👉 record (where work stopped) and how many records are open. Call at the start of a session.",
    inputSchema: input({ repo: repoArg }),
    outputSchema: output({ tasks: { type: "array", items: LEFT_OFF } }),
    readOnly: true,
  },
  {
    name: "task_list",
    title: "List tasks",
    description: "Tasks of the repo, most recently updated first.",
    inputSchema: input({ repo: repoArg, status: { type: "string", enum: TASK_STATUS } }),
    outputSchema: output({ tasks: { type: "array", items: TASK } }),
    readOnly: true,
  },
  {
    name: "task_get",
    title: "Get a task and its records",
    description: "A task and its records in order (todos, questions, answers, decisions, notes, ADRs, PDRs). By default the open records plus the 👉 one, 50 at a time, bodies cut to 500 chars.",
    inputSchema: input({
      repo: repoArg,
      key: keyArg,
      status: { type: "string", enum: GET_STATUS, default: "open", description: "Which records; \"all\" includes done and dropped ones" },
      kind: { type: "string", enum: KINDS },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      offset: { type: "integer", minimum: 0, default: 0, description: "Skip this many records (next_offset of the previous call)" },
      full: { type: "boolean", default: false, description: "Whole bodies instead of the first 500 chars" },
      dropped: { type: "boolean", description: "Deprecated: same as status \"all\"" },
    }, ["key"]),
    outputSchema: output({
      task: TASK, records: { type: "array", items: RECORD }, total: int, returned: int,
      next_offset: { type: "integer", description: "Present when more records match: pass it as offset" },
      hint: { type: "string" },
    }, ["task", "records", "total", "returned"]),
    readOnly: true,
  },
  {
    name: "task_upsert",
    title: "Create or update a task",
    description: "Creates the task or updates its title, status, summary (the one-line \"where we are\") or epic.",
    inputSchema: input({
      repo: repoArg,
      key: keyArg,
      title: { type: "string", maxLength: MAX_TITLE },
      status: { type: "string", enum: TASK_STATUS },
      summary: { type: "string", description: "One line: where we are" },
      epic: { type: "string", description: "The epic's key, e.g. \"#53\"" },
    }, ["key"]),
    outputSchema: output({ task: TASK }),
    idempotent: true,
  },
  {
    name: "record_add",
    title: "Add a record to a task",
    description: "Adds a record to a task (created if missing): todo, question (to the user), answer, decision, note, fixme, adr (architecture), pdr (product), test. pointer=true moves the task's 👉 to it.",
    inputSchema: input({
      repo: repoArg,
      task: { type: "string", description: "Task key, e.g. \"#58\"" },
      kind: { type: "string", enum: KINDS },
      ...recordFields,
      pointer: { type: "boolean", description: "Move the task's 👉 to this record (it must be open)" },
    }, ["task", "kind", "title"]),
    outputSchema: RECORD_OUT,
    idempotent: false,
  },
  {
    name: "record_update",
    title: "Update a record",
    description: "Changes a record (e.g. status done with the result in body). Only the given fields change; every change is versioned.",
    inputSchema: input({ id: int, kind: { type: "string", enum: KINDS }, ...recordFields, position: { type: "number" } }, ["id"]),
    outputSchema: RECORD_OUT,
    idempotent: true,
  },
  {
    name: "pointer_set",
    title: "Move the task's 👉",
    description: "Moves the task's 👉 (where we left off) to this open record.",
    inputSchema: input({ id: int }, ["id"]),
    outputSchema: RECORD_OUT,
    idempotent: true,
  },
  {
    name: "search",
    title: "Search records",
    description: "Records whose title or body contains the text, newest first. repo \"*\" searches every repo.",
    inputSchema: input({
      text: str, repo: repoArg, kind: { type: "string", enum: KINDS }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    }, ["text"]),
    outputSchema: output({ records: { type: "array", items: RECORD } }),
    readOnly: true,
  },
];

class ToolError extends Error {}

/** The repo's id and git root. @param {any} db @param {string | undefined} repo */
function repoOf(db, repo) {
  const start = repo || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = repoRoot(path.resolve(start));
  if (!root) throw new ToolError(`${start} is not inside a git repo; pass repo (an absolute path inside the repo)`);
  return { id: db.repoOf(root).id, root };
}

/** Up to 5 keys nearest to a mistyped one: same prefix first, then by number, then the most recent. @param {string[]} keys @param {string} key */
export function closestKeys(keys, key) {
  const num = (k) => {
    const m = /\d+/.exec(k);
    return m ? Number(m[0]) : undefined;
  };
  const low = key.toLowerCase();
  const n = num(key);
  const score = (k) => {
    const l = k.toLowerCase();
    if (l.startsWith(low) || low.startsWith(l)) return 0;
    const m = num(k);
    return n !== undefined && m !== undefined ? 1 + Math.abs(n - m) : Infinity;
  };
  return keys.map((k, i) => ({ k, s: score(k), i })).sort((a, b) => a.s - b.s || a.i - b.i).slice(0, 5).map((x) => x.k);
}

/** @param {any} db @param {{id: number, root: string}} repo @param {string} key */
function taskOf(db, repo, key) {
  const task = db.taskByKey(repo.id, key);
  if (task) return task;
  const near = closestKeys(db.taskKeys(repo.id), key);
  throw new ToolError(
    `no task ${key} in repo ${repo.root}. ${near.length ? `Closest keys: ${near.join(", ")}.` : "This repo has no tasks yet."} ` +
    `record_add (or task_upsert) with this key creates the task.`,
  );
}

/** A record that must exist. @param {any} db @param {number} id @param {string} [arg] */
function recordOf(db, id, arg = "id") {
  const rec = db.record(id);
  if (!rec) throw new ToolError(`no record ${id} (${arg}); use task_get (by task key) or search (by text) to find record ids`);
  return rec;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TYPES = {
  string: (v) => typeof v === "string",
  integer: Number.isSafeInteger,
  number: Number.isFinite,
  boolean: (v) => typeof v === "boolean",
  object: isObject,
};

/** Checks the arguments the tools rely on; the schema is advisory to clients. @param {any} tool @param {any} a */
function validate(tool, a) {
  const props = tool.inputSchema.properties;
  const valid = Object.keys(props).filter((k) => k !== "_session");
  for (const k of Object.keys(a)) {
    if (!(k in props)) throw new ToolError(`unknown argument "${k}" for ${tool.name}; valid arguments: ${valid.join(", ")}`);
  }
  for (const [k, p] of Object.entries(props)) {
    if (a[k] === undefined || TYPES[p.type]?.(a[k]) !== false) continue;
    const what = { integer: ["id", "parent_id"].includes(k) ? "an integer record id" : "an integer", object: "an object" }[p.type] ?? `a ${p.type}`;
    throw new ToolError(`${k} must be ${what}`);
  }
  for (const k of ["key", "task", "kind", "title", "text"]) {
    if (a[k] !== undefined && !a[k].trim()) throw new ToolError(`${k} must be a non-empty string`);
  }
  for (const k of ["key", "task", "epic"]) if (typeof a[k] === "string") a[k] = a[k].trim();
  for (const [k, p] of Object.entries(props)) {
    if (p.enum && a[k] !== undefined && !p.enum.includes(a[k])) {
      throw new ToolError(`${k} must be one of: ${p.enum.join(", ")} (got ${JSON.stringify(a[k])})`);
    }
  }
  if (a.title !== undefined && a.title.length > MAX_TITLE) {
    throw new ToolError(`title is ${a.title.length} chars; the limit is ${MAX_TITLE}. Keep it to one line and put the rest in body.`);
  }
  if (a.body !== undefined && a.body.length > MAX_BODY) {
    throw new ToolError(`body is ${a.body.length} chars; the limit is ${MAX_BODY}. Split it across records or link a file.`);
  }
  if (a.limit !== undefined) a.limit = Math.min(Math.max(a.limit, 1), 100);
  if (a.offset !== undefined && a.offset < 0) throw new ToolError("offset must be 0 or more");
}

/** @param {Record<string, any>} a @param {string[]} keys */
const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

/** A task's records as task_get pages them. @param {any} db @param {any} task @param {any} a */
function taskRecords(db, task, a) {
  const status = a.status ?? (a.dropped ? "all" : "open");
  const all = db.recordsOf(task.id, { dropped: true });
  const matching = all.filter((r) =>
    (status === "all" || r.status === status || (status === "open" && r.pointer)) && (!a.kind || r.kind === a.kind));
  const offset = a.offset ?? 0;
  const limit = a.limit ?? 50;
  let cut = 0;
  const records = matching.slice(offset, offset + limit).map((r) => {
    if (a.full || !r.body || r.body.length <= BODY_CUT) return r;
    cut++;
    return { ...r, body: r.body.slice(0, BODY_CUT) + "…", body_truncated: true };
  });
  /** @type {any} */
  const out = { task, records, total: matching.length, returned: records.length };
  const hints = [];
  if (offset + records.length < matching.length) {
    out.next_offset = offset + records.length;
    hints.push(`${matching.length - out.next_offset} more: call again with offset ${out.next_offset}`);
  }
  if (cut) hints.push(`${cut} bod${cut === 1 ? "y" : "ies"} cut to ${BODY_CUT} chars: full:true gives the whole text`);
  const hidden = status === "open" && !a.kind ? all.filter((r) => r.status !== "open" && !r.pointer).length : 0;
  if (hidden) hints.push(`${hidden} done/dropped record${hidden === 1 ? "" : "s"} not shown: status "all" shows them`);
  if (hints.length) out.hint = hints.join("; ");
  return out;
}

/**
 * Runs one tool. @param {any} db @param {string} name @param {any} a @param {{client: string}} ctx
 */
export function callTool(db, name, a, ctx = { client: "unknown" }) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  if (a == null) a = {};
  if (!isObject(a)) throw new ToolError("arguments must be an object");
  for (const t of tool.inputSchema.required ?? []) {
    if (a[t] === undefined) throw new ToolError(`${t} is required`);
  }
  validate(tool, a);
  if (!db.sqlite) throw new ToolError(db.error);
  const actor = { kind: "agent", id: a._session ? `${ctx.client}:${a._session}` : ctx.client };
  switch (name) {
    case "where_we_left_off":
      return { tasks: db.whereWeLeftOff(repoOf(db, a.repo).id) };
    case "task_list":
      return { tasks: db.tasksOf(repoOf(db, a.repo).id, { status: a.status }) };
    case "task_get":
      return taskRecords(db, taskOf(db, repoOf(db, a.repo), a.key), a);
    case "task_upsert": {
      const rid = repoOf(db, a.repo).id;
      const fields = pick(a, ["title", "status", "summary"]);
      if (a.epic) fields.epicId = (db.taskByKey(rid, a.epic) ?? db.upsertTask(rid, a.epic)).id;
      return { task: db.upsertTask(rid, a.key, fields) };
    }
    case "record_add": {
      if (a.pointer && a.status && a.status !== "open") {
        throw new ToolError(`👉 goes only on an open record; leave pointer out or add the record with status "open"`);
      }
      if (a.parent_id !== undefined) recordOf(db, a.parent_id, "parent_id");
      const rid = repoOf(db, a.repo).id;
      const task = db.taskByKey(rid, a.task) ?? db.upsertTask(rid, a.task);
      return { record: db.addRecord(task.id, pick(a, ["kind", "title", "body", "owner", "status", "parent_id", "links", "pointer"]), actor) };
    }
    case "record_update":
      recordOf(db, a.id);
      if (a.parent_id !== undefined) recordOf(db, a.parent_id, "parent_id");
      return { record: db.updateRecord(a.id, pick(a, ["kind", "title", "body", "owner", "status", "parent_id", "links", "position"]), actor) };
    case "pointer_set": {
      const rec = recordOf(db, a.id);
      if (rec.status !== "open") {
        throw new ToolError(
          `record ${a.id} is ${rec.status}; 👉 goes only on an open record. ` +
          `Reopen it first with record_update {id: ${a.id}, status: "open"}, then pointer_set, or point at another open record.`,
        );
      }
      return { record: db.setPointer(a.id, actor) };
    }
    case "search":
      return { records: db.search(a.text, { repoId: a.repo === "*" ? undefined : repoOf(db, a.repo).id, kind: a.kind, limit: a.limit }) };
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Whitespace folded, cut to n chars. @param {string} s @param {number} n */
const oneLine = (s, n) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const taskLine = (t) => `${t.key}${t.title ? ` ${t.title}` : ""} [${t.status}]${t.summary ? ` — ${t.summary}` : ""}`;
const recordLine = (r) =>
  `[${r.id}] ${r.kind}/${r.status} ${r.owner ?? "-"} ${r.title}${r.pointer ? " 👉" : ""}${r.parent_id ? ` (answers [${r.parent_id}])` : ""}`;

/**
 * The model-facing text of a result (#64): a short digest; structuredContent keeps the full data.
 * @param {string} name @param {any} out @param {any} [a]
 */
export function digest(name, out, a = {}) {
  switch (name) {
    case "where_we_left_off":
      if (!out.tasks.length) return "No unfinished tasks in this repo.";
      return [`${plural(out.tasks.length, "unfinished task")}:`, ...out.tasks.map((t) =>
        `- ${t.key}${t.title ? ` ${t.title}` : ""} [${t.status}] ${t.pointer_id ? `👉 [${t.pointer_id}] ${t.pointer_title}` : "no 👉"} (${t.open_records} open)` +
        (t.summary ? `\n  where we are: ${t.summary}` : ""))].join("\n");
    case "task_list":
      if (!out.tasks.length) return "No tasks.";
      return [`${plural(out.tasks.length, "task")}:`, ...out.tasks.map((t) => `- ${taskLine(t)}`)].join("\n");
    case "task_get": {
      const lines = [taskLine(out.task)];
      for (const r of out.records) {
        lines.push(recordLine(r));
        if (r.body) lines.push(a.full ? r.body.replace(/^/gm, "    ") : `    ${oneLine(r.body, 200)}`);
      }
      const status = a.status ?? (a.dropped ? "all" : "open");
      lines.push(`${out.returned} of ${out.total} records (status ${status}${a.kind ? `, kind ${a.kind}` : ""}).${out.hint ? ` ${out.hint}.` : ""}`);
      return lines.join("\n");
    }
    case "task_upsert":
      return `Saved task ${taskLine(out.task)}`;
    case "record_add":
      return `Added ${recordLine(out.record)}`;
    case "record_update":
      return `Updated ${recordLine(out.record)}`;
    case "pointer_set":
      return `👉 now on ${recordLine(out.record)}`;
    case "search":
      if (!out.records.length) return `No records match ${JSON.stringify(a.text ?? "")}.`;
      return [`${plural(out.records.length, "record")}:`, ...out.records.map((r) =>
        `- ${r.task_key} ${recordLine(r)}${r.body ? `\n    ${oneLine(r.body, 120)}` : ""}`)].join("\n");
    default:
      return JSON.stringify(out);
  }
}

const toolList = () =>
  TOOLS.map(({ readOnly, idempotent, ...t }) => ({
    ...t,
    annotations: {
      title: t.title, readOnlyHint: Boolean(readOnly), destructiveHint: false,
      idempotentHint: Boolean(readOnly || idempotent), openWorldHint: false,
    },
  }));

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
        // Like tools/list: the same for everyone, changes only with a new server version.
        return done({
          supportedVersions: [MODERN], capabilities: { tools: {} }, instructions: INSTRUCTIONS,
          ttlMs: 3_600_000, cacheScope: "public", _meta: { [`${META}serverInfo`]: SERVER },
        });
      case "initialize": {
        if (params.clientInfo?.name) state.client = params.clientInfo.name;
        const v = LEGACY.includes(params.protocolVersion) ? params.protocolVersion : LEGACY[0];
        state.version = v;
        return ok({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS });
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
          return done({ content: [{ type: "text", text: digest(params.name, out, params.arguments ?? {}) }], structuredContent: out });
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
