// Sync between machines (#61): two databases through the Worker's handler, D1 faked with node:sqlite.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { handle, MAX_CHANGES, MAX_VALUE, MAX_KEY } from "../cloud/src/worker.js";

const req = createRequire(import.meta.url);
const { openDb, normOrigin } = req("../vscode/db.js");
const sync = req("../vscode/sync.js");
const { syncOnce, syncLoop, readConfig, writeConfig, configPath } = sync;
const { DatabaseSync } = req("node:sqlite");

const MIGRATION = fs.readFileSync(new URL("../cloud/migrations/0001_changes.sql", import.meta.url), "utf8");
const TOKEN = "s3cret-token";
const URL_ = "https://sync.example";
const user = { kind: "user", id: "u" };

/** D1's binding API over node:sqlite: prepare/bind/all/first/run and batch (one transaction). */
class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(MIGRATION);
  }
  prepare(sql) {
    const db = this.db;
    const make = (args) => ({
      bind: (...a) => make(a),
      exec: () => ({ results: db.prepare(sql).all(...args) }),
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      first: async () => db.prepare(sql).get(...args) ?? null,
      run: async () => ({ meta: db.prepare(sql).run(...args) }),
    });
    return make([]);
  }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.exec());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

const server = () => {
  const env = { DB: new FakeD1(), SYNC_TOKEN: TOKEN };
  return { env, fetch: (url, init) => handle(new Request(url, init), env) };
};
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-61-")), "imprimatur.db");
const machine = (root, origin, { sync = true } = {}) => {
  const db = openDb({ path: tmpDb() });
  const repo = root ? db.repoOf(root, { origin }) : undefined;
  if (sync) db.enableSync();
  return { db, repo };
};
const cfg = { url: URL_, token: TOKEN };
const run = (m, s) => syncOnce(m.db, cfg, { fetch: s.fetch });
const taskOn = (m, key) => {
  const r = m.db.repos().find((x) => x.origin && normOrigin(x.origin) === "github.com/u/proj");
  return r && m.db.taskByKey(r.id, key);
};

test("normOrigin: ssh, https, .git and case of the host are one remote", () => {
  assert.equal(normOrigin("git@github.com:u/proj.git"), "github.com/u/proj");
  assert.equal(normOrigin("https://github.com/u/proj"), "github.com/u/proj");
  assert.equal(normOrigin("https://user:pw@GitHub.com/u/proj.git/"), "github.com/u/proj");
  assert.equal(normOrigin("ssh://git@host:2222/u/proj.git"), "host:2222/u/proj");
});

test("sync off: writes queue nothing; turning it on queues what is there, once", () => {
  const { db, repo } = machine("/a/proj", "git@github.com:u/proj.git", { sync: false });
  const t = db.upsertTask(repo.id, "#1", { title: "One" });
  db.addRecord(t.id, { kind: "todo", title: "x" }, user);
  assert.equal(db.outboxCount(), 0);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM clock").get().n, 0);
  const n = db.enableSync();
  assert.ok(n >= 1 + 4 + 11, `seeded ${n}`);
  assert.equal(db.outboxCount(), n);
  assert.equal(db.enableSync(), 0, "seeded once");
  // Repos without an origin are not synced.
  const local = db.repoOf("/a/local");
  db.addRecord(db.upsertTask(local.id, "#9").id, { kind: "note", title: "local only" }, user);
  assert.equal(db.outboxCount(), n);
});

test("a task made on A shows up on B under the same origin; B's own clone adopts it", async () => {
  const s = server();
  const a = machine("/home/a/proj", "git@github.com:u/proj.git");
  const b = machine(undefined);
  const t = a.db.upsertTask(a.repo.id, "#7", { title: "Seven", summary: "where we are" });
  const rec = a.db.addRecord(t.id, { kind: "todo", title: "do it", owner: "K", links: { issue: 7 } }, user);
  const pushed = await run(a, s);
  assert.ok(pushed.pushed > 0);
  assert.equal(a.db.outboxCount(), 0, "acked rows are gone");
  const got = await run(b, s);
  assert.ok(got.applied > 0);
  assert.equal(b.db.outboxCount(), 0, "applying pulled changes queues nothing (no loop)");
  const bt = taskOn(b, "#7");
  assert.equal(bt.title, "Seven");
  assert.equal(bt.summary, "where we are");
  const placeholder = b.db.taskById(bt.id).repo_id;
  assert.match(b.db.repos().find((r) => r.id === placeholder).root, /^origin:github\.com\/u\/proj$/);
  const br = b.db.recordByUid(rec.uid);
  assert.equal(br.title, "do it");
  assert.equal(br.owner, "K");
  assert.deepEqual(br.links, { issue: 7 });
  const v = b.db.versionsOf(br.id);
  assert.equal(v[0].actor_kind, "import");
  assert.equal(v[0].actor, `sync:${a.db.deviceId()}`);
  assert.equal(v[0].op, "create");
  // B opens its own clone (https spelling): the placeholder becomes it, no second repo.
  const mine = b.db.repoOf("/home/b/work/proj", { origin: "https://github.com/u/proj" });
  assert.equal(mine.id, placeholder);
  assert.equal(mine.root, "/home/b/work/proj");
  assert.equal(b.db.repos().length, 1);
  assert.equal(b.db.taskByKey(mine.id, "#7").title, "Seven");
});

test("field-level last writer wins: different fields both stay; the same field goes to the newer", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const b = machine("/b/proj", "https://github.com/u/proj.git");
  const rec = a.db.addRecord(a.db.upsertTask(a.repo.id, "#1").id, { kind: "todo", title: "first" }, user);
  await run(a, s);
  await run(b, s);
  const brec = b.db.recordByUid(rec.uid);
  // A changes status, B changes title, neither has seen the other.
  a.db.updateRecord(rec.id, { status: "done" }, user);
  b.db.updateRecord(brec.id, { title: "renamed on B" }, user);
  await run(a, s);
  await run(b, s);
  await run(a, s);
  for (const r of [a.db.recordByUid(rec.uid), b.db.recordByUid(rec.uid)]) {
    assert.equal(r.status, "done");
    assert.equal(r.title, "renamed on B");
  }
  // The same field: B writes after A (its clock has seen A's), B wins on both.
  a.db.updateRecord(rec.id, { body: "A's body" }, user);
  await run(a, s);
  await run(b, s);
  b.db.updateRecord(brec.id, { body: "B's body" }, user);
  await run(b, s);
  await run(a, s);
  assert.equal(a.db.recordByUid(rec.uid).body, "B's body");
  assert.equal(b.db.recordByUid(rec.uid).body, "B's body");
  // Task fields too: A's status, B's title.
  a.db.upsertTask(a.repo.id, "#1", { status: "active" });
  b.db.upsertTask(b.repo.id, "#1", { title: "Task one" });
  await run(a, s);
  await run(b, s);
  await run(a, s);
  for (const m of [a, b]) {
    const t = m.db.taskByKey(m.repo.id, "#1");
    assert.equal(t.status, "active");
    assert.equal(t.title, "Task one");
  }
});

test("a tie (same at) goes to the larger device id, in either order; older changes lose", () => {
  const { db } = machine("/a/proj", "git@github.com:u/proj.git");
  const key = "github.com/u/proj\t#2";
  const ch = (value, at, device) => ({ entity: "task", key, field: "title", value: JSON.stringify(value), at, device });
  db.applyRemote([ch("from z", 1000, "zzz"), ch("from a", 1000, "aaa")]);
  assert.equal(taskOn({ db }, "#2").title, "from z");
  db.applyRemote([ch("older", 999, "zzzz")]);
  assert.equal(taskOn({ db }, "#2").title, "from z");
  const other = machine("/a/proj", "git@github.com:u/proj.git").db;
  other.applyRemote([ch("from a", 1000, "aaa")]);
  other.applyRemote([ch("from z", 1000, "zzz")]);
  assert.equal(taskOn({ db: other }, "#2").title, "from z");
  // Bad values are refused, not applied.
  db.applyRemote([{ entity: "task", key, field: "status", value: JSON.stringify("bogus"), at: 5000, device: "x" }]);
  assert.equal(taskOn({ db }, "#2").status, "open");
});

test("the 👉 moves on the other machine too, and only one record holds it", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#3");
  const r1 = a.db.addRecord(t.id, { kind: "todo", title: "one", pointer: true }, user);
  const r2 = a.db.addRecord(t.id, { kind: "todo", title: "two" }, user);
  await run(a, s);
  await run(b, s);
  assert.equal(b.db.recordByUid(r1.uid).pointer, true);
  a.db.setPointer(r2.id, user);
  await run(a, s);
  await run(b, s);
  assert.equal(b.db.recordByUid(r1.uid).pointer, false);
  assert.equal(b.db.recordByUid(r2.uid).pointer, true);
  // B moves it back; A follows.
  b.db.setPointer(b.db.recordByUid(r1.uid).id, user);
  await run(b, s);
  await run(a, s);
  assert.equal(a.db.record(r1.id).pointer, true);
  assert.equal(a.db.record(r2.id).pointer, false);
});

test("an answer keeps its question as parent, even when the answer arrives first", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#4");
  const q = a.db.addRecord(t.id, { kind: "question", title: "which?", owner: "K" }, user);
  const ans = a.db.addRecord(t.id, { kind: "answer", title: "that one", parent_id: q.id }, user);
  await run(a, s);
  await run(b, s);
  assert.equal(b.db.recordByUid(ans.uid).parent_id, b.db.recordByUid(q.uid).id);
  // Out of order: the answer's changes come first, the question's in a later pull.
  const c = machine(undefined).db;
  const rows = a.db.sqlite.prepare("SELECT * FROM clock WHERE entity = 'record'").all();
  const changes = (uid) => rows.filter((r) => r.key === uid).map((r) => ({
    entity: "record", key: r.key, field: r.field, at: r.at, device: r.device,
    value: JSON.stringify(a.db.syncValue_("record", a.db.recordByUid(uid), r.field)),
  })).sort((x, y) => (x.field === "task" ? -1 : y.field === "task" ? 1 : 0));
  const first = c.applyRemote(changes(ans.uid));
  assert.equal(first.pending, 1, "parent waits");
  assert.equal(c.recordByUid(ans.uid).parent_id, null);
  const second = c.applyRemote(changes(q.uid));
  assert.equal(second.pending, 0);
  assert.equal(c.recordByUid(ans.uid).parent_id, c.recordByUid(q.uid).id);
});

test("pulling everything again changes nothing", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#5", { title: "Five" });
  for (let i = 0; i < 5; i++) a.db.addRecord(t.id, { kind: "note", title: `n${i}`, pointer: i === 3 }, user);
  await run(a, s);
  await run(b, s);
  const snapshot = () => JSON.stringify([
    b.db.sqlite.prepare("SELECT uid, kind, status, pointer, title, position FROM records ORDER BY uid").all(),
    b.db.sqlite.prepare("SELECT count(*) AS n FROM record_versions").get(),
    b.db.sqlite.prepare("SELECT count(*) AS n FROM tasks").get(),
  ]);
  const before = snapshot();
  b.db.setMeta("pull_seq", 0);
  const again = await run(b, s);
  assert.ok(again.pulled > 0);
  assert.equal(snapshot(), before);
  assert.equal(b.db.outboxCount(), 0);
});

test("pull pages until there is no more; the caller's own changes are not sent back", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#6");
  for (let i = 0; i < 100; i++) a.db.addRecord(t.id, { kind: "note", title: `n${i}` }, user);
  const r = await run(a, s);
  assert.ok(r.pushed > MAX_CHANGES, `pushed ${r.pushed} in batches`);
  const own = await (await s.fetch(`${URL_}/v1/pull?since=0&device=${a.db.deviceId()}&limit=1000`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(own.changes.length, 0);
  assert.equal(own.more, true);
  assert.equal(own.last, 1000);
  const b = machine(undefined);
  const got = await run(b, s);
  assert.equal(got.pulled, r.pushed);
  assert.equal(b.db.sqlite.prepare("SELECT count(*) AS n FROM records").get().n, 100);
});

test("the Worker: 401 without the token, 400 on bad changes, 413 over the limits", async () => {
  const s = server();
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (body, headers = auth) => s.fetch(`${URL_}/v1/push`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const good = { entity: "task", key: "github.com/u/p\t#1", field: "title", value: "\"t\"", at: 1 };
  assert.equal((await post({ device: "d1", changes: [good] }, { "content-type": "application/json" })).status, 401);
  assert.equal((await post({ device: "d1", changes: [good] }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await handle(new Request(`${URL_}/v1/pull?since=0&device=d`, { headers: auth }), { DB: s.env.DB })).status, 401, "no secret, no entry");
  assert.equal((await s.fetch(`${URL_}/v1/pull?since=0&device=d`)).status, 401);
  assert.equal((await post({ device: "d1", changes: Array(MAX_CHANGES + 1).fill(good) })).status, 413);
  assert.equal((await post("x".repeat(1_000_001))).status, 413);
  assert.equal((await post({ device: "d1", changes: [{ ...good, entity: "user" }] })).status, 400);
  assert.equal((await post({ device: "d1", changes: [{ ...good, at: "now" }] })).status, 400);
  assert.equal((await post({ device: "d1", changes: [{ ...good, value: 5 }] })).status, 400);
  assert.equal((await post({ device: "bad device!", changes: [good] })).status, 400);
  assert.equal((await post("{not json")).status, 400);
  const ok = await post({ device: "d1", changes: [good, { ...good, value: null }] });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { last: 2 });
  const pulled = await (await s.fetch(`${URL_}/v1/pull?since=0&device=d2`, { headers: auth })).json();
  assert.deepEqual(pulled.changes.map((c) => [c.seq, c.device, c.value]), [[1, "d1", "\"t\""], [2, "d1", null]]);
  assert.equal(pulled.more, false);
  assert.equal((await s.fetch(`${URL_}/v1/pull?since=-1&device=d2`, { headers: auth })).status, 400);
  assert.equal((await s.fetch(`${URL_}/v1/nope`, { headers: auth })).status, 404);
});

test("seeding: what was there before sync reaches the other machine", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git", { sync: false });
  const t = a.db.upsertTask(a.repo.id, "#8", { title: "Old" });
  const epic = a.db.upsertTask(a.repo.id, "#80", { title: "Epic" });
  a.db.upsertTask(a.repo.id, "#8", { epicId: epic.id });
  const r = a.db.addRecord(t.id, { kind: "decision", title: "decided" }, user);
  a.db.enableSync();
  await run(a, s);
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  await run(b, s);
  const bt = b.db.taskByKey(b.repo.id, "#8");
  assert.equal(bt.title, "Old");
  assert.equal(b.db.taskById(bt.epic_id).key, "#80");
  assert.equal(b.db.recordByUid(r.uid).title, "decided");
});

test("a repo that learns its origin later is queued then", () => {
  const { db } = machine(undefined);
  const repo = db.repoOf("/a/late");
  db.addRecord(db.upsertTask(repo.id, "#1").id, { kind: "todo", title: "x" }, user);
  assert.equal(db.outboxCount(), 0);
  db.repoOf("/a/late", { origin: "git@github.com:u/late.git" });
  assert.ok(db.outboxCount() > 0);
  assert.ok(db.outbox(1000).some((c) => c.entity === "record" && c.key === db.recordsOf(db.taskByKey(repo.id, "#1").id)[0].uid));
});

test("config.json sits next to the database, readable only by its owner", () => {
  const file = tmpDb();
  assert.equal(readConfig(file), undefined);
  writeConfig(file, { url: `${URL_}/`, token: TOKEN });
  assert.deepEqual(readConfig(file), { url: URL_, token: TOKEN });
  assert.equal(configPath(file), path.join(path.dirname(file), "config.json"));
  if (process.platform !== "win32") assert.equal(fs.statSync(configPath(file)).mode & 0o777, 0o600);
});

test("syncLoop: kick is debounced, runs never overlap", async () => {
  let runs = 0;
  let active = 0;
  let overlap = false;
  const loop = syncLoop(async () => {
    active++;
    if (active > 1) overlap = true;
    runs++;
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return "ok";
  }, () => {}, { intervalMs: 10_000, debounceMs: 5 });
  loop.kick();
  loop.kick();
  loop.kick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 1);
  const first = loop.now();
  const second = loop.now();
  assert.equal(loop.now(), second, "one queued run however often it is asked for");
  await first;
  assert.deepEqual(await second, { line: "ok" }, "Sync Now waits for its own run");
  await new Promise((r) => setTimeout(r, 40));
  loop.dispose();
  assert.equal(overlap, false);
  assert.equal(runs, 3, "a run asked for during a run comes after it");
});

// ---- Review fixes ----

test("client and Worker agree on the limits", () => {
  assert.equal(sync.MAX_VALUE, MAX_VALUE);
  assert.equal(sync.MAX_KEY, MAX_KEY);
});

test("an over-long value is cut before the push (text ends in …, an object becomes {truncated}); here it stays whole", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  const big = "ş".repeat(MAX_VALUE + 10);
  const r = a.db.addRecord(a.db.upsertTask(a.repo.id, "#1").id, { kind: "note", title: "big", body: big, links: { blob: "x".repeat(MAX_VALUE) } }, user);
  const out = await run(a, s);
  assert.equal(out.dropped, 0);
  assert.equal(a.db.outboxCount(), 0);
  await run(b, s);
  const got = b.db.recordByUid(r.uid);
  assert.ok(got.body.endsWith("…") && got.body.length < big.length && big.startsWith(got.body.slice(0, -1)));
  assert.deepEqual(got.links, { truncated: true });
  assert.equal(got.title, "big");
  assert.equal(a.db.record(r.id).body, big);
});

test("a change the Worker refuses is found by halving the batch and dropped; the rest goes through", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#1");
  for (let i = 0; i < 9; i++) a.db.addRecord(t.id, { kind: "note", title: i === 6 ? "POISON" : `n${i}` }, user);
  const refusing = async (url, init) => {
    if (init?.body && init.body.includes("POISON")) return new Response(JSON.stringify({ error: "nope" }), { status: 400 });
    return s.fetch(url, init);
  };
  const lines = [];
  const out = await syncOnce(a.db, cfg, { fetch: refusing, log: (l) => lines.push(l) });
  assert.equal(out.dropped, 1);
  assert.equal(a.db.outboxCount(), 0, "nothing stuck");
  assert.match(lines.join("\n"), /dropped a change the server refused \(record .* title\)/);
  const b = machine(undefined);
  await run(b, s);
  const titles = b.db.sqlite.prepare("SELECT title FROM records ORDER BY title").all().map((x) => x.title);
  assert.equal(titles.length, 9);
  assert.ok(!titles.includes("POISON"));
});

test("a failed push does not stop the pull", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  a.db.upsertTask(a.repo.id, "#1", { title: "from A" });
  await run(a, s);
  b.db.upsertTask(b.repo.id, "#2", { title: "B's" });
  const down = async (url, init) => (init?.method === "POST" ? new Response("busy", { status: 503 }) : s.fetch(url, init));
  await assert.rejects(syncOnce(b.db, cfg, { fetch: down }), /HTTP 503.*pull went on: sync: pushed 0, pulled [1-9]/);
  assert.equal(b.db.taskByKey(b.repo.id, "#1").title, "from A");
  assert.ok(b.db.outboxCount() > 0, "B's change waits for the next push");
});

test("two syncs at once: each acks only what it pushed, a change queued meanwhile survives", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#1");
  a.db.addRecord(t.id, { kind: "note", title: "first" }, user);
  let late;
  let inner = false;
  const overlapping = async (url, init) => {
    if (init?.method === "POST" && !inner) {
      inner = true;
      // Another window syncs the same rows meanwhile, then a new change is queued.
      await syncOnce(a.db, cfg, { fetch: s.fetch });
      late = a.db.addRecord(t.id, { kind: "note", title: "queued meanwhile" }, user);
    }
    return s.fetch(url, init);
  };
  await syncOnce(a.db, cfg, { fetch: overlapping });
  // Acking by "id <= the last pushed" with reused ids would have deleted it unsent.
  const b = machine(undefined);
  await run(b, s);
  assert.equal(b.db.recordByUid(late.uid).title, "queued meanwhile");
});

test("the 👉 set on different records on two machines ends on the same one on both", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#3");
  const r1 = a.db.addRecord(t.id, { kind: "todo", title: "one" }, user);
  const r2 = a.db.addRecord(t.id, { kind: "todo", title: "two" }, user);
  await run(a, s);
  await run(b, s);
  a.db.setPointer(r1.id, user);
  b.db.setPointer(b.db.recordByUid(r2.uid).id, user);
  await run(a, s);
  await run(b, s);
  await run(a, s);
  const pointed = (m) => m.db.sqlite.prepare("SELECT uid FROM records WHERE pointer = 1").all().map((x) => x.uid);
  assert.deepEqual(pointed(a), pointed(b));
  assert.equal(pointed(a).length, 1);
  // Clearing it travels too.
  const held = a.db.recordByUid(pointed(a)[0]);
  a.db.clearPointer(held.id, user);
  await run(a, s);
  await run(b, s);
  assert.deepEqual(pointed(b), []);
});

test("a repo that learns its origin merges the placeholder's same-key task, then the placeholder goes", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  const t = a.db.upsertTask(a.repo.id, "#1", { title: "Title from A" });
  const fromA = a.db.addRecord(t.id, { kind: "todo", title: "A's todo", pointer: true }, user);
  await run(a, s);
  const b = machine(undefined);
  const local = b.db.repoOf("/b/proj");
  const bt = b.db.upsertTask(local.id, "#1", { summary: "B's summary" });
  const fromB = b.db.addRecord(bt.id, { kind: "note", title: "B's note" }, user);
  await run(b, s);
  assert.equal(b.db.repos().length, 2, "placeholder next to the origin-less repo");
  b.db.repoOf("/b/proj", { origin: "https://github.com/u/proj" });
  assert.deepEqual(b.db.repos().map((r) => r.root), ["/b/proj"]);
  const merged = b.db.taskByKey(local.id, "#1");
  assert.equal(merged.title, "Title from A");
  assert.equal(merged.summary, "B's summary");
  const recs = b.db.recordsOf(merged.id);
  assert.deepEqual(recs.map((r) => r.uid).sort(), [fromA.uid, fromB.uid].sort());
  assert.equal(recs.find((r) => r.uid === fromA.uid).pointer, true);
  // B's own fields now sync back to A.
  await run(b, s);
  await run(a, s);
  assert.equal(a.db.taskByKey(a.repo.id, "#1").summary, "B's summary");
  assert.equal(a.db.recordByUid(fromB.uid).title, "B's note");
});

test("two clones of one origin: the first syncs, the second does not", () => {
  const { db, repo } = machine("/a/one", "git@github.com:u/proj.git");
  const second = db.repoOf("/a/two", { origin: "https://github.com/u/proj" });
  assert.deepEqual(db.unsyncedClones().map((r) => r.id), [second.id]);
  const before = db.outboxCount();
  db.addRecord(db.upsertTask(second.id, "#1").id, { kind: "note", title: "x" }, user);
  assert.equal(db.outboxCount(), before);
  db.addRecord(db.upsertTask(repo.id, "#1").id, { kind: "note", title: "y" }, user);
  assert.ok(db.outboxCount() > before);
});

test("sync off then on again: edits made while off are queued", async () => {
  const s = server();
  const a = machine("/a/proj", "git@github.com:u/proj.git");
  a.db.upsertTask(a.repo.id, "#1", { title: "before" });
  await run(a, s);
  a.db.disableSync();
  a.db.upsertTask(a.repo.id, "#1", { title: "while off" });
  assert.equal(a.db.outboxCount(), 0);
  assert.ok(a.db.enableSync() > 0);
  await run(a, s);
  const b = machine("/b/proj", "git@github.com:u/proj.git");
  await run(b, s);
  assert.equal(b.db.taskByKey(b.repo.id, "#1").title, "while off");
});

test("the Worker counts bytes, not chars: 413, not 500", async () => {
  const s = server();
  const body = JSON.stringify({ device: "d1", changes: [{ entity: "task", key: "k\t#1", field: "title", value: JSON.stringify("ş".repeat(600_000)), at: 1 }] });
  assert.ok(body.length < 1_000_000);
  const res = await s.fetch(`${URL_}/v1/push`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body });
  assert.equal(res.status, 413);
});

test("changes that wait for a record that never comes are dropped after 3 pulls", () => {
  const { db } = machine(undefined);
  const orphan = { entity: "record", key: "uid-x", field: "title", value: JSON.stringify("t"), at: 5, device: "d" };
  const bad = { entity: "record", key: "uid-x", field: "task", value: JSON.stringify("no tab here"), at: 5, device: "d" };
  assert.equal(db.applyRemote([bad, orphan]).pending, 1);
  assert.equal(db.applyRemote([]).pending, 1);
  assert.equal(db.applyRemote([]).pending, 1);
  assert.equal(db.applyRemote([]).pending, 1);
  const last = db.applyRemote([]);
  assert.equal(last.pending, 0);
  assert.equal(last.dropped, 1);
});

test("npm run sync -- --setup: the token comes from the environment, never argv", () => {
  const file = tmpDb();
  const script = new URL("../scripts/sync.mjs", import.meta.url).pathname;
  const env = { ...process.env, IMPRIMATUR_DB: file };
  const refused = spawnSync(process.execPath, [script, "--setup", "http://127.0.0.1:9", "tok"], { env, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not go on the command line/);
  assert.equal(readConfig(file), undefined);
  const ok = spawnSync(process.execPath, [script, "--setup", "http://127.0.0.1:9"], { env: { ...env, IMPRIMATUR_SYNC_TOKEN: "from-env" }, encoding: "utf8", timeout: 20_000 });
  assert.deepEqual(readConfig(file), { url: "http://127.0.0.1:9", token: "from-env" });
  assert.match(ok.stdout, /sync on/);
  assert.equal(ok.status, 1, "nothing listens there: the sync itself fails");
});
