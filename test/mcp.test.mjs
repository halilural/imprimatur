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
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
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

  const got = json(await call(s, "task_get", { key: "#58" }));
  assert.deepEqual(got.records.map((r) => [r.kind, r.pointer]), [["todo", false], ["question", true], ["answer", false]]);

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
