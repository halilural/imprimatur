// Imprimatur MCP server (#58), over a real stdio session.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mergeCodex, mergeCursor } from "../scripts/setup.mjs";

const SERVER = new URL("../mcp/server.mjs", import.meta.url).pathname;
const HOOK = new URL("../hooks/mcp-session.mjs", import.meta.url).pathname;
const META = "io.modelcontextprotocol/";

function gitRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-58-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const children = new Set();
// A failed assertion must not leave a server holding the test run open.
after(() => children.forEach((p) => p.kill()));

/** A stdio session: send(method, params) resolves with the reply to that id. */
function session({ cwd, env = {} } = {}) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-58-db-")), "i.db");
  const p = spawn(process.execPath, [SERVER], {
    cwd, env: { ...process.env, IMPRIMATUR_DB: db, CLAUDE_PROJECT_DIR: "", ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(p);
  p.on("close", () => children.delete(p));
  const waiting = new Map();
  const lines = [];
  let stderr = "";
  p.stderr.on("data", (d) => (stderr += d));
  readline.createInterface({ input: p.stdout }).on("line", (l) => {
    lines.push(l);
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let next = 1;
  return {
    db,
    lines,
    stderr: () => stderr,
    raw: (text) => p.stdin.write(text + "\n"),
    send(method, params = {}) {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify: (method) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"),
    close: () => new Promise((resolve) => {
      p.on("close", resolve);
      p.stdin.end();
    }),
  };
}

const modern = (extra = {}) => ({
  _meta: { [`${META}protocolVersion`]: "2026-07-28", [`${META}clientInfo`]: { name: "test-client", version: "1" } }, ...extra,
});
const call = async (s, name, args) => {
  const r = await s.send("tools/call", modern({ name, arguments: args }));
  return r.result;
};

test("legacy handshake: initialize, initialized, tools/list", async () => {
  const s = session({ cwd: gitRepo() });
  const init = await s.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.serverInfo.name, "imprimatur");
  s.notify("notifications/initialized");
  const unknown = await s.send("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.result.protocolVersion, "2025-11-25", "an unknown version gets our latest legacy one");
  const list = await s.send("tools/list");
  assert.equal(list.result.resultType, undefined);
  assert.equal(list.result.ttlMs, undefined, "legacy results stay as they were");
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ["pointer_set", "record_add", "record_update", "search", "task_get", "task_list", "task_upsert", "where_we_left_off"]);
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(typeof t.annotations.readOnlyHint, "boolean");
  }
  await s.close();
  assert.equal(s.lines.length, 3, "a notification gets no reply");
  assert.equal(s.stderr(), "", "no experimental warning on stderr");
});

test("modern era: server/discover, resultType, unsupported version, unknown method, parse error", async () => {
  const s = session({ cwd: gitRepo() });
  const d = await s.send("server/discover", modern());
  assert.equal(d.result.resultType, "complete");
  assert.deepEqual(d.result.supportedVersions, ["2026-07-28"]);
  assert.equal(d.result._meta[`${META}serverInfo`].name, "imprimatur");
  // 2026-07-28 clients reject a list without caching hints ("ttlMs: expected number").
  const tools = await s.send("tools/list", modern());
  assert.equal(typeof tools.result.ttlMs, "number");
  assert.ok(["public", "private"].includes(tools.result.cacheScope));
  const bad = await s.send("tools/list", { _meta: { [`${META}protocolVersion`]: "2030-01-01" } });
  assert.equal(bad.error.code, -32022);
  assert.deepEqual(bad.error.data, { supported: ["2026-07-28"], requested: "2030-01-01" });
  assert.equal((await s.send("nope", modern())).error.code, -32601);
  assert.equal((await s.send("tools/call", modern({ name: "nope", arguments: {} }))).error.code, -32602);
  s.raw("{not json");
  await s.send("ping", modern());
  assert.ok(s.lines.some((l) => JSON.parse(l).error?.code === -32700));
  await s.close();
});

test("every tool: a task, its records, 👉, versions with the session, search, where we left off", async () => {
  const root = gitRepo();
  const s = session({ cwd: root });
  const json = (r) => {
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    // The text is a digest for the model; structuredContent carries the data (#64).
    assert.equal(typeof r.content[0].text, "string");
    assert.ok(r.content[0].text.length > 0);
    assert.equal(typeof r.structuredContent, "object");
    return r.structuredContent;
  };
  const { task } = json(await call(s, "task_upsert", { key: "#58", title: "MCP", status: "active", epic: "#53", _session: "S1" }));
  assert.equal(task.key, "#58");
  assert.ok(task.epic_id);

  const { record: todo } = json(await call(s, "record_add", { task: "#58", kind: "todo", owner: "C", title: "server.mjs", pointer: true, links: { issue: 58 }, _session: "S1" }));
  const { record: q } = json(await call(s, "record_add", { task: "#58", kind: "question", owner: "K", title: "Araçlar genel mi?" }));
  json(await call(s, "record_add", { task: "#58", kind: "answer", owner: "K", title: "Genel", parent_id: q.id }));
  const { record: dec } = json(await call(s, "record_add", { task: "#59", kind: "decision", title: "dev-workflow v3 #59'da" }));
  assert.equal(dec.kind, "decision", "a missing task is created");

  const { record: doneTodo } = json(await call(s, "record_update", { id: todo.id, status: "done", body: "yazıldı", _session: "S2" }));
  assert.equal(doneTodo.status, "done");
  assert.equal(doneTodo.pointer, false, "a done record loses the 👉");
  json(await call(s, "pointer_set", { id: q.id }));

  const got = json(await call(s, "task_get", { key: "#58", status: "all" }));
  assert.deepEqual(got.records.map((r) => [r.kind, r.pointer]), [["todo", false], ["question", true], ["answer", false]]);
  const openOnly = json(await call(s, "task_get", { key: "#58" }));
  assert.deepEqual(openOnly.records.map((r) => r.kind), ["question", "answer"], "by default: open records only");
  assert.deepEqual(json(await call(s, "task_get", { key: "#58", dropped: true })).records.length, 3, "dropped: true still works (status all)");

  const left = json(await call(s, "where_we_left_off", {}));
  const t58 = left.tasks.find((t) => t.key === "#58");
  assert.equal(t58.pointer_title, "Araçlar genel mi?");
  assert.equal(t58.open_records, 2);

  assert.deepEqual(json(await call(s, "task_list", { status: "active" })).tasks.map((t) => t.key), ["#58"]);
  assert.deepEqual(json(await call(s, "search", { text: "GENEL" })).records.map((r) => r.title).sort(), ["Araçlar genel mi?", "Genel"]);
  assert.deepEqual(json(await call(s, "search", { text: "v3", kind: "decision", repo: "*" })).records.length, 1);
  assert.deepEqual(json(await call(s, "search", { text: "100%_" })).records, [], "LIKE wildcards are literal");

  const err = await call(s, "pointer_set", { id: todo.id });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /open record/);
  assert.equal((await call(s, "task_get", { key: "#999" })).isError, true);
  assert.equal((await call(s, "task_get", { key: "#58", repo: "/" })).isError, true, "not a git repo");
  await s.close();

  // Who did what: the client's name and the session the hook added.
  const req = (await import("node:module")).createRequire(import.meta.url);
  const db = req("../vscode/db.js").openDb({ path: s.db });
  // create and its 👉; in another session: done, which also takes the 👉 off
  assert.deepEqual(db.versionsOf(todo.id).map((v) => v.actor), ["test-client:S1", "test-client:S1", "test-client:S2", "test-client:S2"]);
  assert.equal(db.versionsOf(q.id)[0].actor, "test-client");
  assert.equal(db.repoOf(root).root, root);
  db.close();
});

test("repo: CLAUDE_PROJECT_DIR before the cwd, the repo argument before both", async () => {
  const a = gitRepo();
  const b = gitRepo();
  const s = session({ cwd: os.tmpdir(), env: { CLAUDE_PROJECT_DIR: path.join(a) } });
  await call(s, "task_upsert", { key: "#1" });
  await call(s, "task_upsert", { key: "#2", repo: b });
  assert.deepEqual((await call(s, "task_list", {})).structuredContent.tasks.map((t) => t.key), ["#1"]);
  assert.deepEqual((await call(s, "task_list", { repo: b })).structuredContent.tasks.map((t) => t.key), ["#2"]);
  await s.close();
});

test("hook: adds the session to Imprimatur's tool input, leaves other tools alone", () => {
  const run = (input) => execFileSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8" });
  const out = JSON.parse(run({ session_id: "S9", tool_name: "mcp__imprimatur__record_add", tool_input: { task: "#58", kind: "note", title: "x" } }));
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { task: "#58", kind: "note", title: "x", _session: "S9" });
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  const plugin = JSON.parse(run({ session_id: "S9", tool_name: "mcp__plugin_imprimatur_imprimatur__task_get", tool_input: { key: "#67" } }));
  assert.deepEqual(plugin.hookSpecificOutput.updatedInput, { key: "#67", _session: "S9" }); // the plugin's server (#67)
  assert.equal(run({ session_id: "S9", tool_name: "mcp__other__x", tool_input: {} }), "");
  assert.equal(execFileSync(process.execPath, [HOOK], { input: "garbage", encoding: "utf8" }), "");
});

test("setup: Cursor's mcp.json gets the server once, other servers kept", () => {
  const first = mergeCursor({ mcpServers: { other: { command: "x" } } }, { root: "/r" });
  assert.deepEqual(first.config.mcpServers.imprimatur, { type: "stdio", command: "node", args: ["/r/mcp/server.mjs"] });
  assert.deepEqual(first.config.mcpServers.other, { command: "x" });
  assert.equal(mergeCursor(first.config, { root: "/r" }).change, undefined);
  const moved = mergeCursor({ mcpServers: { imprimatur: { command: "node", args: ["/old/mcp/server.mjs"], env: { K: "v" } } } }, { root: "/r" });
  assert.match(moved.change, /updated/);
  assert.deepEqual(moved.config.mcpServers.imprimatur.env, { K: "v" });
});

test("setup: Codex's config.toml gets one [mcp_servers.imprimatur] table, the rest byte for byte", () => {
  const added = mergeCodex("model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"a\"\n", { root: "/r" });
  assert.equal(added.toml, "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"a\"\n\n[mcp_servers.imprimatur]\ncommand = \"node\"\nargs = [\"/r/mcp/server.mjs\"]\n");
  assert.equal(mergeCodex(added.toml, { root: "/r" }).change, undefined);
  const old = added.toml.replace("/r/", "/old/") + "\n[mcp_servers.imprimatur.env]\nK = \"v\"\n\n[z]\nq = 1\n";
  const moved = mergeCodex(old, { root: "/r" });
  assert.match(moved.change, /updated/);
  assert.equal(moved.toml, added.toml + "\n[z]\nq = 1\n");
});

test("starts from a path with a space and non-ASCII letters", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur 58 ")), "çalışma alanı");
  const repo = path.join(new URL("..", import.meta.url).pathname);
  fs.mkdirSync(path.join(dir, "mcp"), { recursive: true });
  fs.copyFileSync(SERVER, path.join(dir, "mcp", "server.mjs"));
  fs.symlinkSync(path.join(repo, "vscode"), path.join(dir, "vscode"));
  const out = execFileSync(process.execPath, [path.join(dir, "mcp", "server.mjs")], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n",
    env: { ...process.env, IMPRIMATUR_DB: path.join(dir, "i.db") },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(out), { jsonrpc: "2.0", id: 1, result: {} });
});

test("a database that cannot open: the tools say why, the server stays up", async () => {
  const s = session({ cwd: gitRepo(), env: { IMPRIMATUR_DB: "/mnt/c/imprimatur-test/i.db" } });
  const r = await call(s, "task_list", {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /could not open.*Windows drive/);
  assert.equal((await s.send("ping", modern())).result.resultType, "complete");
  await s.close();
});

test("arguments are checked before the database sees them", async () => {
  const s = session({ cwd: gitRepo() });
  const err = async (name, args) => {
    const r = await call(s, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    return r.content[0].text;
  };
  assert.match(await err("record_update", { title: "x" }), /id is required/);
  assert.match(await err("pointer_set", { id: "3" }), /integer/);
  assert.match(await err("record_update", { id: 1.5 }), /integer/);
  assert.match(await err("task_upsert", { key: "  " }), /non-empty/);
  assert.match(await err("record_add", { task: "#1", kind: "todo" }), /title is required/);
  assert.match(await err("search", { text: "x", limit: "all" }), /integer/);
  const nullArgs = await s.send("tools/call", modern({ name: "task_list", arguments: null }));
  assert.equal(nullArgs.result.isError, undefined);
  assert.match(await err("task_list", []), /object/);
  await call(s, "task_upsert", { key: " #7 " });
  assert.deepEqual((await call(s, "task_list", {})).structuredContent.tasks.map((t) => t.key), ["#7"]);
  for (let i = 0; i < 3; i++) await call(s, "record_add", { task: "#7", kind: "note", title: `n${i}` });
  assert.equal((await call(s, "search", { text: "n", limit: -1 })).structuredContent.records.length, 1, "limit is clamped to 1..100");
  await s.close();
});

test("framing: invalid requests, client responses, batches", async () => {
  const s = session({ cwd: gitRepo() });
  s.raw("42");
  s.raw(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }));
  s.raw("[]");
  s.raw(JSON.stringify([{ jsonrpc: "2.0", id: 50, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]));
  await s.send("ping", modern());
  const replies = s.lines.map((l) => JSON.parse(l));
  assert.deepEqual(replies[0], { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  assert.equal(replies[1].error.code, -32600, "an empty batch is invalid");
  assert.deepEqual(replies[2], [{ jsonrpc: "2.0", id: 50, result: {} }]);
  assert.equal(replies.length, 4, "a client's response gets no reply");
  await s.close();
});

test("setup: Codex edge cases: quoted header, multi-line array, strings, CRLF", () => {
  const old = "[ mcp_servers.\"imprimatur\" ]\ncommand = \"old\"\nargs = [\n  \"a\",\n  [\"b\"]\n]\n\n[z]\ns = \"\"\"\n[not a table]\n\"\"\"\n";
  const r = mergeCodex(old, { root: "/r" });
  assert.equal(r.toml, "[mcp_servers.imprimatur]\ncommand = \"node\"\nargs = [\"/r/mcp/server.mjs\"]\n\n[z]\ns = \"\"\"\n[not a table]\n\"\"\"\n");
  const crlf = mergeCodex("x = 1\r\n", { root: "/r" }).toml;
  assert.equal(crlf, "x = 1\r\n\r\n[mcp_servers.imprimatur]\r\ncommand = \"node\"\r\nargs = [\"/r/mcp/server.mjs\"]\r\n");
  assert.equal(mergeCodex(crlf, { root: "/r" }).change, undefined);
  const twice = mergeCodex("[mcp_servers.imprimatur]\ncommand = \"node\"\nargs = [\"/r/mcp/server.mjs\"]\n[other]\n[mcp_servers.imprimatur.env]\nK = \"v\"\n", { root: "/r" });
  assert.equal(twice.toml.match(/mcp_servers\.imprimatur/g).length, 1, "a scattered subtable is removed too");
});

// #64: MCP spec 2026-07-28 and "Writing effective tools for agents".

test("discover and initialize carry the instructions; discover has caching hints", async () => {
  const s = session({ cwd: gitRepo() });
  const d = (await s.send("server/discover", modern())).result;
  assert.equal(d.ttlMs, 3_600_000);
  assert.equal(d.cacheScope, "public");
  assert.equal(typeof d.instructions, "string");
  assert.ok(d.instructions.length <= 1500, `${d.instructions.length} chars`);
  for (const w of ["where_we_left_off", "#58", "Jira", "parent_id", "C = the agent", "K = the user", "👉", "pointer_set", "pointer:true",
    "summary", "record_update", "\"done\"", "repo \"*\"", "_session"]) {
    assert.ok(d.instructions.includes(w), `instructions mention ${w}`);
  }
  const init = (await s.send("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "old" } })).result;
  assert.equal(init.instructions, d.instructions);
  await s.close();
});

test("tools: title, annotations, closed input schemas that still take _session, output schemas", async () => {
  const s = session({ cwd: gitRepo() });
  const { tools } = (await s.send("tools/list", modern())).result;
  const idempotent = { record_add: false };
  for (const t of tools) {
    assert.equal(typeof t.title, "string", t.name);
    assert.ok(t.title.length > 0);
    assert.equal(t.annotations.openWorldHint, false, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(t.annotations.idempotentHint, idempotent[t.name] ?? true, t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.inputSchema.properties._session, `${t.name} takes _session`);
    assert.equal(t.outputSchema.type, "object", t.name);
    assert.ok(t.outputSchema.required.length > 0, t.name);
  }
  const ro = Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]));
  assert.deepEqual(ro, {
    where_we_left_off: true, task_list: true, task_get: true, search: true,
    task_upsert: false, record_add: false, record_update: false, pointer_set: false,
  });
  // The hook's _session passes the closed schema.
  assert.equal((await call(s, "task_list", { _session: "S1" })).isError, undefined);
  await s.close();
});

/** A light JSON Schema check: types, enums, required keys, nested properties and items. */
function conforms(schema, v, at = "$") {
  const types = [].concat(schema.type ?? []);
  if (types.length) {
    const is = (t) => (t === "null" ? v === null : t === "array" ? Array.isArray(v)
      : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t);
    assert.ok(types.some(is), `${at}: ${JSON.stringify(v)} is not ${types.join("|")}`);
  }
  if (schema.enum && v !== null) assert.ok(schema.enum.includes(v), `${at}: ${v} not in ${schema.enum}`);
  if (Array.isArray(v)) v.forEach((x, i) => schema.items && conforms(schema.items, x, `${at}[${i}]`));
  else if (v && typeof v === "object") {
    for (const k of schema.required ?? []) assert.ok(k in v, `${at}.${k} is missing`);
    for (const [k, p] of Object.entries(schema.properties ?? {})) if (v[k] !== undefined) conforms(p, v[k], `${at}.${k}`);
  }
}

test("every tool's structuredContent matches its outputSchema", async () => {
  const s = session({ cwd: gitRepo() });
  const schemas = Object.fromEntries((await s.send("tools/list", modern())).result.tools.map((t) => [t.name, t.outputSchema]));
  const seen = new Set();
  const ok = async (name, args) => {
    const r = await call(s, name, args);
    assert.equal(r.isError, undefined, r.content[0].text);
    conforms(schemas[name], r.structuredContent, name);
    seen.add(name);
    return r.structuredContent;
  };
  await ok("where_we_left_off", {});
  await ok("task_upsert", { key: "#1", title: "One", status: "active", summary: "half way", epic: "#0" });
  const { record: q } = await ok("record_add", { task: "#1", kind: "question", owner: "K", title: "Q?", body: "x".repeat(900), pointer: true, links: { issue: 1 } });
  await ok("record_add", { task: "#1", kind: "answer", title: "A", parent_id: q.id });
  const { record: n } = await ok("record_add", { task: "#1", kind: "note", title: "N" });
  await ok("record_update", { id: n.id, status: "done", body: "result" });
  await ok("pointer_set", { id: q.id });
  await ok("task_list", {});
  await ok("task_get", { key: "#1" });
  await ok("task_get", { key: "#1", status: "all", limit: 1 });
  await ok("search", { text: "x", repo: "*" });
  await ok("where_we_left_off", {});
  assert.equal(seen.size, Object.keys(schemas).length, "every tool was checked");
  await s.close();
});

test("task_get: open records and the 👉 by default, kind, paging, bodies cut unless full", async () => {
  const s = session({ cwd: gitRepo() });
  const long = "y".repeat(800);
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const args = { task: "#7", kind: i % 2 ? "note" : "todo", title: `r${i}`, ...(i === 0 && { body: long }) };
    ids.push((await call(s, "record_add", args)).structuredContent.record.id);
  }
  await call(s, "record_update", { id: ids[1], status: "done" });
  await call(s, "record_update", { id: ids[3], status: "dropped" });

  const first = await call(s, "task_get", { key: "#7" });
  const p1 = first.structuredContent;
  assert.equal(p1.total, 58, "done and dropped left out");
  assert.equal(p1.returned, 50);
  assert.equal(p1.records.length, 50);
  assert.equal(p1.next_offset, 50);
  assert.equal(p1.records[0].body.length, 501, "500 chars and an ellipsis");
  assert.equal(p1.records[0].body_truncated, true);
  assert.match(first.content[0].text, /offset 50/);
  assert.match(first.content[0].text, /full:true/);
  assert.match(first.content[0].text, /status "all"/);

  const p2 = (await call(s, "task_get", { key: "#7", offset: 50 })).structuredContent;
  assert.equal(p2.returned, 8);
  assert.equal(p2.next_offset, undefined);
  assert.equal(p2.records[0].title, "r52");

  const full = (await call(s, "task_get", { key: "#7", full: true, limit: 1 })).structuredContent;
  assert.equal(full.records[0].body, long);
  assert.equal(full.records[0].body_truncated, undefined);
  assert.equal(full.next_offset, 1);

  assert.equal((await call(s, "task_get", { key: "#7", limit: 500 })).structuredContent.returned, 58, "limit clamped, not refused");
  assert.equal((await call(s, "task_get", { key: "#7", status: "all" })).structuredContent.total, 60);
  assert.deepEqual((await call(s, "task_get", { key: "#7", status: "done" })).structuredContent.records.map((r) => r.title), ["r1"]);
  assert.deepEqual((await call(s, "task_get", { key: "#7", status: "dropped" })).structuredContent.records.map((r) => r.title), ["r3"]);
  assert.equal((await call(s, "task_get", { key: "#7", kind: "note" })).structuredContent.total, 28);
  await s.close();
});

test("digests: compact text for the model", async () => {
  const s = session({ cwd: gitRepo() });
  await call(s, "task_upsert", { key: "#58", title: "MCP", status: "active", summary: "server written" });
  const add = { task: "#58", kind: "todo", owner: "C", title: "server.mjs", pointer: true, body: "line one\nline two" };
  const { record: todo } = (await call(s, "record_add", add)).structuredContent;
  await call(s, "record_add", { task: "#58", kind: "question", owner: "K", title: "Genel mi?" });
  const text = async (name, args) => (await call(s, name, args)).content[0].text;

  assert.equal(await text("where_we_left_off", {}), `1 unfinished task:\n- #58 MCP [active] 👉 [${todo.id}] server.mjs (2 open)\n  where we are: server written`);
  const got = await text("task_get", { key: "#58" });
  assert.equal(got.split("\n")[0], "#58 MCP [active] — server written");
  assert.ok(got.includes(`[${todo.id}] todo/open C server.mjs 👉\n    line one line two`), got);
  assert.ok(got.includes(`[${todo.id + 1}] question/open K Genel mi?`), got);
  assert.match(got, /2 of 2 records \(status open\)/);
  assert.equal(await text("task_list", {}), "1 task:\n- #58 MCP [active] — server written");
  assert.match(await text("search", { text: "genel" }), /^1 record:\n- #58 \[\d+\] question\/open K Genel mi\?$/);
  assert.equal(await text("search", { text: "zzz" }), "No records match \"zzz\".");
  assert.match(await text("record_update", { id: todo.id, status: "done" }), /^Updated \[\d+\] todo\/done C server\.mjs$/);
  assert.match(await text("record_add", { task: "#58", kind: "note", title: "n" }), /^Added \[\d+\] note\/open - n$/);
  assert.match(await text("pointer_set", { id: todo.id + 1 }), /^👉 now on \[\d+\] question\/open K Genel mi\? 👉$/);
  assert.match(await text("task_upsert", { key: "#58" }), /^Saved task #58 MCP/);
  await s.close();
});

test("errors tell the model how to recover", async () => {
  const root = gitRepo();
  const s = session({ cwd: root });
  const err = async (name, args) => {
    const r = await call(s, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    return r.content[0].text;
  };
  assert.match(await err("task_get", { key: "#1" }), /no tasks yet.*record_add/);
  for (const k of ["#50", "#57", "#58", "#59", "#60", "#61", "#100", "PROJ-5"]) await call(s, "task_upsert", { key: k });
  const unknown = await err("task_get", { key: "#580" });
  assert.ok(unknown.includes(root), "names the repo root");
  assert.match(unknown, /Closest keys: #58, /);
  assert.equal(unknown.match(/Closest keys: ([^.]*)\./)[1].split(", ").length, 5);
  assert.match(unknown, /record_add.*creates/);
  assert.match(await err("task_get", { key: "#62" }), /Closest keys: #61, #60, #59, #58, #57\./);

  assert.match(await err("task_list", { status: "closed" }), /status must be one of: open, active, done, dropped/);
  assert.match(await err("task_get", { key: "#58", status: "active" }), /one of: open, done, dropped, all/);
  assert.match(await err("record_add", { task: "#58", kind: "bug", title: "x" }), /kind must be one of: todo, question, answer/);
  assert.match(await err("record_add", { task: "#58", kind: "todo", title: "x", owner: "me" }), /owner must be one of: C, K/);
  assert.match(await err("task_list", { stauts: "open" }), /unknown argument "stauts".*valid arguments: repo, status/);
  assert.match(await err("record_add", { task: "#58", kind: "note", title: "t".repeat(301) }), /title is 301 chars; the limit is 300/);
  assert.match(await err("record_add", { task: "#58", kind: "note", title: "t", body: "b".repeat(20_001) }), /body is 20001 chars; the limit is 20000/);
  assert.match(await err("task_get", { key: "#58", offset: -1 }), /offset/);
  assert.match(await err("task_get", { key: "#58", full: "yes" }), /full must be a boolean/);

  const { record } = (await call(s, "record_add", { task: "#58", kind: "todo", title: "t", status: "done" })).structuredContent;
  assert.match(await err("pointer_set", { id: record.id }), /is done.*Reopen it first with record_update.*status: "open"/);
  assert.match(await err("record_add", { task: "#58", kind: "todo", title: "t", status: "done", pointer: true }), /only on an open record/);
  assert.match(await err("pointer_set", { id: 9999 }), /no record 9999.*task_get.*search/);
  assert.match(await err("record_update", { id: 9999, status: "done" }), /no record 9999.*task_get.*search/);
  assert.match(await err("record_add", { task: "#58", kind: "answer", title: "a", parent_id: 9999 }), /no record 9999 \(parent_id\)/);
  await s.close();
});
