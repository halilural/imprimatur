// Imprimatur's own database (#57).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const DB_JS = req.resolve("../vscode/db.js");
const { openDb, dbPath, onWindowsDrive, VERSION } = req(DB_JS);

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-57-")), "imprimatur.db");
const agent = { kind: "agent", id: "s1" };

test("dbPath: env override, then the platform's data folder", () => {
  assert.equal(dbPath({ IMPRIMATUR_DB: "/x/y.db" }, "linux", "/h"), "/x/y.db");
  assert.equal(dbPath({}, "linux", "/h"), "/h/.local/share/imprimatur/imprimatur.db");
  assert.equal(dbPath({ XDG_DATA_HOME: "/d" }, "linux", "/h"), "/d/imprimatur/imprimatur.db");
  assert.equal(dbPath({}, "darwin", "/h"), "/h/Library/Application Support/imprimatur/imprimatur.db");
  assert.match(dbPath({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\h"), /imprimatur[\\/]imprimatur\.db$/);
});

test("a database on a Windows drive under WSL is refused", () => {
  assert.equal(onWindowsDrive("/mnt/c/Users/x/i.db", "linux"), true);
  assert.equal(onWindowsDrive("/home/x/i.db", "linux"), false);
  assert.throws(() => openDb({ path: "/mnt/c/imprimatur-test/i.db" }), /Windows drive/);
});

test("opens with WAL and the current schema; reopening keeps it", () => {
  const file = tmpDb();
  const db = openDb({ path: file });
  assert.equal(db.sqlite.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.sqlite.prepare("PRAGMA user_version").get().user_version, VERSION);
  db.close();
  const again = openDb({ path: file });
  assert.equal(again.version, VERSION);
  again.close();
});

test("a newer database is read-only here", () => {
  const file = tmpDb();
  const db = openDb({ path: file });
  db.sqlite.exec(`PRAGMA user_version = ${VERSION + 1}`);
  db.close();
  const old = openDb({ path: file });
  assert.deepEqual(old.tasksOf(1), []);
  assert.throws(() => old.repoOf("/r"), /newer than this code/);
  old.close();
});

test("records: create, update, versions; nothing is deleted", () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r", { origin: "git@github.com:u/r.git" });
  assert.equal(db.repoOf("/r").id, repo.id);
  const task = db.upsertTask(repo.id, "#57", { title: "DB" });
  assert.equal(db.upsertTask(repo.id, "#57", { summary: "Sürüyor" }).title, "DB");

  const a = db.addRecord(task.id, { kind: "todo", owner: "C", title: "db.js", links: { issue: 57 } }, agent);
  const b = db.addRecord(task.id, { kind: "question", owner: "K", title: "Şema?" }, agent);
  assert.deepEqual([a.position, b.position], [1, 2]);
  assert.deepEqual(a.links, { issue: 57 });

  const same = db.updateRecord(a.id, { title: "db.js" }, agent);
  assert.equal(same.updated_at, a.updated_at);
  db.updateRecord(b.id, { status: "dropped" }, { kind: "user" });
  db.updateRecord(a.id, { status: "done", body: "yazıldı" }, agent);

  const v = db.versionsOf(a.id);
  assert.deepEqual(v.map((x) => x.op), ["create", "update"]);
  assert.equal(v[0].after.title, "db.js");
  assert.deepEqual(v[1].before, { status: "open", body: null });
  assert.deepEqual(v[1].after, { status: "done", body: "yazıldı" });
  assert.equal(v[1].actor, "s1");

  assert.deepEqual(db.recordsOf(task.id).map((r) => r.title), ["db.js"]);
  assert.equal(db.recordsOf(task.id, { dropped: true }).length, 2);
  assert.throws(() => db.updateRecord(a.id, { task_id: 9 }, agent), /not editable/);
  assert.throws(() => db.addRecord(task.id, { kind: "wish", title: "x" }, agent), /CHECK/);
  assert.throws(() => db.addRecord(task.id, { kind: "note", title: "x" }, { kind: "robot" }), /actor kind/);
  assert.equal(db.recordsOf(task.id, { dropped: true }).length, 2, "a failed write leaves nothing behind");
  const ans = db.addRecord(task.id, { kind: "answer", title: "evet", parent_id: b.id }, { kind: "user" });
  assert.equal(ans.parent_id, b.id);
  const other = db.upsertTask(repo.id, "#58");
  assert.throws(() => db.addRecord(other.id, { kind: "answer", title: "x", parent_id: b.id }, agent), /not another record/);
  assert.throws(() => db.updateRecord(ans.id, { parent_id: ans.id }, agent), /not another record/);
  db.close();
});

test("one 👉 per task; it moves, and leaves a record that is no longer open", () => {
  const db = openDb({ path: tmpDb() });
  const task = db.upsertTask(db.repoOf("/r").id, "#57");
  const a = db.addRecord(task.id, { kind: "todo", title: "a", pointer: true }, agent);
  const b = db.addRecord(task.id, { kind: "todo", title: "b" }, agent);
  assert.equal(db.record(a.id).pointer, true);
  db.setPointer(b.id, agent);
  assert.deepEqual(db.recordsOf(task.id).map((r) => r.pointer), [false, true]);
  assert.throws(() => db.sqlite.prepare("UPDATE records SET pointer = 1 WHERE id = ?").run(a.id), /UNIQUE/);
  db.updateRecord(b.id, { status: "done" }, agent);
  assert.equal(db.record(b.id).pointer, false);
  assert.throws(() => db.setPointer(b.id, agent), /open record/);
  db.close();
});

test("open asks: the user's open todos and questions across repos", () => {
  const db = openDb({ path: tmpDb() });
  const t1 = db.upsertTask(db.repoOf("/a").id, "#1");
  const t2 = db.upsertTask(db.repoOf("/b").id, "LATD-1");
  db.addRecord(t1.id, { kind: "todo", owner: "K", title: "pull" }, agent);
  db.addRecord(t1.id, { kind: "todo", owner: "C", title: "mine" }, agent);
  db.addRecord(t2.id, { kind: "question", owner: "K", title: "ok?" }, agent);
  db.addRecord(t2.id, { kind: "decision", owner: "K", title: "decided" }, agent);
  assert.deepEqual(db.openAsks().map((r) => `${r.task_key} ${r.title}`).sort(), ["#1 pull", "LATD-1 ok?"]);
  assert.deepEqual(db.openAsks({ repoId: t2.repo_id }).map((r) => r.title), ["ok?"]);
  db.close();
});

test("12 processes open a new database at once: WAL switch and migration race", { timeout: 30_000 }, async () => {
  const file = tmpDb();
  const script = `require(${JSON.stringify(DB_JS)}).openDb({ path: ${JSON.stringify(file)} }).close();`;
  const results = await Promise.all(Array.from({ length: 12 }, () => run(script)));
  for (const r of results) assert.deepEqual(r, { code: 0, err: "" });
  const db = openDb({ path: file });
  assert.equal(db.version, VERSION);
  db.close();
});

/** Runs a CommonJS snippet in its own process, killed after 20 s. */
const run = (script, ...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["-e", script, ...args], { stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => resolve({ code, err }));
});

test("12 processes write at once: nothing lost, no SQLITE_BUSY", { timeout: 30_000 }, async () => {
  const file = tmpDb();
  const db = openDb({ path: file });
  const task = db.upsertTask(db.repoOf("/r").id, "#57");
  db.close();
  const WRITERS = 12;
  const EACH = 40;
  const script = `
    const db = require(${JSON.stringify(DB_JS)}).openDb({ path: ${JSON.stringify(file)} });
    const w = process.argv[1];
    for (let i = 0; i < ${EACH}; i++) {
      const r = db.addRecord(${task.id}, { kind: "note", title: w + ":" + i }, { kind: "hook", id: w });
      db.updateRecord(r.id, { body: "x" }, { kind: "hook", id: w });
      if (i % 10 === 0) db.setPointer(r.id, { kind: "hook", id: w });
    }
    db.close();
  `;
  const results = await Promise.all(Array.from({ length: WRITERS }, (_, w) => run(script, String(w))));
  for (const r of results) assert.deepEqual(r, { code: 0, err: "" });

  const check = openDb({ path: file });
  const rows = check.recordsOf(task.id);
  assert.equal(rows.length, WRITERS * EACH);
  assert.equal(new Set(rows.map((r) => r.title)).size, WRITERS * EACH);
  assert.equal(rows.filter((r) => r.pointer).length, 1);
  assert.equal(check.sqlite.prepare("SELECT count(*) AS n FROM record_versions WHERE op = 'create'").get().n, WRITERS * EACH);
  check.close();
});

test("speed: 10k records, panel queries < 1 ms, open < 5 ms", () => {
  const file = tmpDb();
  const db = openDb({ path: file });
  const repo = db.repoOf("/r");
  const tasks = Array.from({ length: 100 }, (_, i) => db.upsertTask(repo.id, `#${i}`));
  db.tx(() => {
    const ins = db.sqlite.prepare(`INSERT INTO records (uid, task_id, kind, owner, status, title, position, created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 10_000; i++) {
      ins.run(`u${i}`, tasks[i % 100].id, i % 3 ? "todo" : "question", i % 2 ? "K" : "C", i % 5 ? "done" : "open", `r${i}`, i, i, i);
    }
  });
  db.sqlite.exec("ANALYZE");
  const median = (fn, n = 50) => {
    const t = [];
    for (let i = 0; i < n; i++) {
      const s = process.hrtime.bigint();
      fn();
      t.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    return t.sort((a, b) => a - b)[n >> 1];
  };
  const recordsMs = median(() => db.recordsOf(tasks[42].id));
  const asksMs = median(() => db.openAsks({ limit: 50 }));
  const tasksMs = median(() => db.tasksOf(repo.id, { status: "open" }));
  db.close();
  const openMs = median(() => openDb({ path: file }).close(), 20);
  const report = { recordsMs, asksMs, tasksMs, openMs };
  // The targets (1 ms, 5 ms) under IMPRIMATUR_PERF=1; a loaded machine gets 5x room.
  const strict = Boolean(process.env.IMPRIMATUR_PERF);
  if (strict) console.log(report);
  const k = strict ? 1 : 5;
  assert.ok(recordsMs < k && asksMs < k && tasksMs < k, JSON.stringify(report));
  assert.ok(openMs < 5 * k, JSON.stringify(report));
});
