// Issue tracker sync (#70): the epic cascade (vscode/db.js) and GitHub / Jira push and pull
// (vscode/tracker.js), with a fake gh and a fake fetch.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb, refersTo } = req("../vscode/db.js");
const { trackerOnce, describe, trackerActive, githubSyncCovers, githubRepo, readJira, pickTransition, isTransient, MAX_TRIES, COMMENT } = req("../vscode/tracker.js");
const { dbPath } = req("../vscode/db.js");
const { check } = req("../vscode/process.js");
const { syncLoop } = req("../vscode/sync.js");

const agent = { kind: "agent", id: "claude:s1" };
const user = { kind: "user" };
const tracker = { kind: "import", id: "tracker:github" };
const ORIGIN = "git@github.com:halilural/imprimatur.git";
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-70-")), "imprimatur.db");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const later = () => new Date(Date.now() + 60_000).toISOString();
const OLD = "2020-01-01T00:00:00Z";

/** Epic #53 with the real line shapes: links in titles, a mid-title mention, the 👉 on #56's line. */
function epicSetup({ origin = ORIGIN } = {}) {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r", { origin });
  const epic = db.upsertTask(repo.id, "#53", { title: "Epic", status: "active" });
  const l55 = db.addRecord(epic.id, { kind: "todo", owner: "C", title: "[#55 Grafik](https://github.com/halilural/imprimatur/issues/55) — ajanın her işi" }, agent);
  const l56 = db.addRecord(epic.id, { kind: "todo", owner: "C", title: "[#56 Süreç hook'ları …](https://github.com/halilural/imprimatur/issues/56) — nerede kaldık, tur sonu", pointer: true }, agent);
  const mention = db.addRecord(epic.id, { kind: "note", title: "Bulut desteği #61, #56 bittikten sonra" }, agent);
  const l57 = db.addRecord(epic.id, { kind: "todo", title: "#57 veritabanı" }, agent);
  const t56 = db.upsertTask(repo.id, "#56", { title: "Süreç hook'ları", status: "active", epicId: epic.id }, agent);
  return { db, repo, epic, l55, l56, mention, l57, t56 };
}

test("refersTo: links.issue, or the key at the title's start; a key mid-title or a longer number does not count", () => {
  assert.ok(refersTo({ title: "[#56 Süreç hook'ları …](url) — …" }, "#56"));
  assert.ok(refersTo({ title: "#56 x" }, "#56"));
  assert.ok(refersTo({ title: "PROJ-12 a" }, "PROJ-12"));
  assert.ok(refersTo({ title: "[PROJ-12](u) a" }, "PROJ-12"));
  assert.ok(refersTo({ title: "x", links: { issue: 56 } }, "#56"));
  assert.ok(refersTo({ title: "x", links: { issue: "#56" } }, "#56"));
  assert.ok(refersTo({ title: "x", links: { issue: "PROJ-12" } }, "PROJ-12"));
  assert.ok(!refersTo({ title: "#560 x" }, "#56"));
  assert.ok(!refersTo({ title: "[PROJ-123 x" }, "PROJ-12"));
  assert.ok(!refersTo({ title: "after #56 is done" }, "#56"));
  assert.ok(!refersTo({ title: "x", links: { issue: 57 } }, "#56"));
});

test("cascade: a task set done closes its epic line in the same write, by the same actor; the 👉 moves on", () => {
  const { db, epic, l55, l56, mention, l57, t56 } = epicSetup();
  db.upsertTask(t56.repo_id, "#56", { status: "done" }, agent);
  const line = db.record(l56.id);
  assert.equal(line.status, "done");
  assert.equal(line.body, `#56 bitti (${today()})`);
  assert.equal(line.pointer, false);
  // The mid-title mention stays open and, next by position, takes the 👉.
  assert.equal(db.record(mention.id).status, "open");
  assert.equal(db.record(mention.id).pointer, true);
  assert.equal(db.record(l55.id).status, "open");
  assert.equal(db.record(l57.id).status, "open");
  // Version rows: the agent closed it, the agent moved the 👉.
  const v = db.versionsOf(l56.id);
  const closed = v.find((x) => x.after?.status === "done");
  assert.equal(closed.actor_kind, "agent");
  assert.equal(closed.actor, "claude:s1");
  assert.deepEqual(closed.after, { status: "done", body: `#56 bitti (${today()})` });
  assert.ok(db.versionsOf(mention.id).some((x) => x.after?.pointer === true && x.actor === "claude:s1"));
  assert.equal(db.taskById(epic.id).status, "active");
});

test("cascade: links.issue closes a line; its body keeps what it had; no next record clears the 👉", () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r");
  const epic = db.upsertTask(repo.id, "PROJ-1", { title: "Epic" });
  const a = db.addRecord(epic.id, { kind: "todo", title: "Hook işleri", body: "önce plan", links: { issue: "PROJ-12" }, pointer: true }, agent);
  const t = db.upsertTask(repo.id, "PROJ-12", { epicId: epic.id }, agent);
  db.upsertTask(repo.id, "PROJ-12", { status: "done" }, user);
  assert.equal(db.record(a.id).status, "done");
  assert.equal(db.record(a.id).body, `önce plan\n\nPROJ-12 bitti (${today()})`);
  assert.equal(db.record(a.id).pointer, false);
  assert.equal(db.recordsOf(epic.id).filter((r) => r.pointer).length, 0);
  assert.equal(db.versionsOf(a.id).at(-1).actor_kind, "user");
  assert.ok(t);
});

test("cascade: dropped closes the line too (noted as bırakıldı); reopening the task leaves it closed", () => {
  const { db, l56, t56 } = epicSetup();
  db.upsertTask(t56.repo_id, "#56", { status: "dropped" }, user);
  assert.equal(db.record(l56.id).status, "done");
  assert.equal(db.record(l56.id).body, `#56 bırakıldı (${today()})`);
  db.upsertTask(t56.repo_id, "#56", { status: "active" }, user);
  assert.equal(db.record(l56.id).status, "done");
  // Done again: the line is no longer open, nothing more is written to it.
  const n = db.versionsOf(l56.id).length;
  db.upsertTask(t56.repo_id, "#56", { status: "done" }, user);
  assert.equal(db.versionsOf(l56.id).length, n);
});

test("cascade: a task without an epic, or a status that is not closing, touches no record", () => {
  const { db, l56, t56, epic } = epicSetup();
  db.upsertTask(t56.repo_id, "#56", { summary: "sürüyor" }, user);
  db.upsertTask(t56.repo_id, "#56", { status: "open" }, user);
  assert.equal(db.record(l56.id).status, "open");
  db.upsertTask(t56.repo_id, "#99", { status: "done" }, user);
  assert.equal(db.recordsOf(epic.id).filter((r) => r.status === "done").length, 0);
});

test("cascade: applyRemote (another machine) does not cascade nor queue a tracker push", () => {
  const { db, l56, t56 } = epicSetup();
  db.enableSync();
  const before = db.trackerOutboxCount();
  const out = db.applyRemote([{ entity: "task", key: "github.com/halilural/imprimatur\t#56", field: "status", value: JSON.stringify("done"), at: Date.now() + 10_000, device: "zzz-other" }]);
  assert.equal(out.applied, 1);
  assert.equal(db.taskById(t56.id).status, "done");
  assert.equal(db.record(l56.id).status, "open");
  assert.equal(db.record(l56.id).pointer, true);
  assert.equal(db.trackerOutboxCount(), before);
});

test("cascade: with sync on, the closed line and the moved 👉 are queued for other machines", () => {
  const { db, l56, t56 } = epicSetup();
  db.enableSync();
  db.ackOutbox(db.outbox(10_000).map((r) => r.id));
  db.upsertTask(t56.repo_id, "#56", { status: "done" }, agent);
  const queued = db.outbox();
  assert.ok(queued.some((r) => r.entity === "record" && r.key === db.record(l56.id).uid && r.field === "status" && r.value === '"done"'));
  assert.ok(queued.some((r) => r.entity === "task" && r.key.endsWith("\t#53") && r.field === "pointer"));
});

test("tracker outbox: local status changes across open/closed are queued; the tracker's pull, imports and other keys are not", () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r", { origin: ORIGIN });
  db.upsertTask(repo.id, "#1", { title: "One", summary: "kod hazır" }, agent);
  assert.equal(db.trackerOutboxCount(), 0);
  db.upsertTask(repo.id, "#1", { status: "active" }, agent);
  assert.equal(db.trackerOutboxCount(), 0);
  db.upsertTask(repo.id, "#1", { status: "done" }, agent);
  let rows = db.trackerOutbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "close_done");
  assert.equal(rows[0].comment, null); // nothing of the task goes to the tracker
  // Dropped before the push: the waiting close changes its reason.
  db.upsertTask(repo.id, "#1", { status: "dropped" }, agent);
  rows = db.trackerOutbox();
  assert.deepEqual(rows.map((r) => r.action), ["close_dropped"]);
  // Reopened before the push: one reopen.
  db.upsertTask(repo.id, "#1", { status: "active" }, user);
  assert.deepEqual(db.trackerOutbox().map((r) => r.action), ["reopen"]);
  db.trackerDone(db.trackerOutbox()[0].id);
  db.upsertTask(repo.id, "#1", { status: "done" }, tracker);
  db.upsertTask(repo.id, "#2", { status: "active" }, user);
  db.upsertTask(repo.id, "#2", { status: "done" }, { kind: "import", id: "markdown" });
  db.upsertTask(repo.id, "misc", { status: "active" }, user);
  db.upsertTask(repo.id, "misc", { status: "done" }, user);
  assert.equal(db.trackerOutboxCount(), 0);
  db.upsertTask(repo.id, "PROJ-7", { status: "open" }, user);
  db.upsertTask(repo.id, "PROJ-7", { status: "done" }, user);
  assert.deepEqual(db.trackerOutbox().map((r) => [r.key, r.action]), [["PROJ-7", "close_done"]]);
});

/** A fake gh: answers by subcommand, records every call; fail[sub] throws (once when failOnce). */
function fakeGh({ issues = [], states = {}, fail = {}, auth = true, slowView } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const [a, b, n] = args;
    if (a === "auth") {
      if (!auth) throw new Error("gh auth status: not logged in");
      return "";
    }
    if (fail[b]) throw new Error(`gh issue ${b}: ${fail[b]}`);
    if (b === "list") return JSON.stringify(issues.map((i) => (states[i.number] && states[i.number] !== i.state ? { ...i, state: states[i.number] } : i)));
    if (b === "view") {
      if (slowView) await slowView;
      return JSON.stringify({ state: states[n] ?? "OPEN" });
    }
    if (b === "close") states[n] = "CLOSED";
    if (b === "reopen") states[n] = "OPEN";
    return "";
  };
  return { gh, calls, writes: () => calls.filter((c) => c[1] === "close" || c[1] === "reopen") };
}
const ghRepo = () => {
  const db = openDb({ path: tmpDb() });
  return { db, repo: db.repoOf("/r", { origin: ORIGIN }) };
};
/** Sets a task's status and queues its push, as an agent would. */
const flip = (db, repo, key, ...statuses) => {
  for (const status of statuses) db.upsertTask(repo.id, key, { status }, agent);
};

test("dbPath: under node --test without IMPRIMATUR_DB it is a temp file, never the real database; spawned hooks share it", () => {
  const home = os.homedir();
  const env = { NODE_TEST_CONTEXT: "child" };
  const p = dbPath(env, "linux", "/h");
  assert.ok(p.startsWith(os.tmpdir()) && !p.startsWith("/h/"));
  assert.equal(env.IMPRIMATUR_DB, p);
  assert.equal(dbPath({}, "linux", "/h"), "/h/.local/share/imprimatur/imprimatur.db");
  const saved = process.env.IMPRIMATUR_DB;
  delete process.env.IMPRIMATUR_DB;
  try {
    assert.ok(process.env.NODE_TEST_CONTEXT);
    const own = dbPath();
    assert.ok(own.startsWith(os.tmpdir()) && !own.startsWith(home));
    assert.equal(process.env.IMPRIMATUR_DB, own);
    // A child (a hook the test runs) sees the same file.
    const child = req("node:child_process").execFileSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(path.resolve("vscode/db.js"))}).dbPath())`], { encoding: "utf8" }).trim();
    assert.equal(child, own);
  } finally {
    if (saved === undefined) delete process.env.IMPRIMATUR_DB;
    else process.env.IMPRIMATUR_DB = saved;
  }
});

test("push github: fixed comments only; done closes as completed, dropped as not planned, reopen reopens", async () => {
  const { db, repo } = ghRepo();
  for (const k of ["#1", "#2", "#3"]) db.upsertTask(repo.id, k, { title: `gizli ${k}`, status: "active", summary: "özel not" }, agent);
  flip(db, repo, "#1", "done");
  flip(db, repo, "#2", "dropped");
  flip(db, repo, "#3", "done", "active");
  const f = fakeGh({ states: { 3: "CLOSED" } });
  const r = await trackerOnce(db, { gh: f.gh });
  assert.deepEqual(f.writes(), [
    ["issue", "close", "1", "-R", "halilural/imprimatur", "--reason", "completed", "--comment", "Imprimatur: tamamlandı"],
    ["issue", "close", "2", "-R", "halilural/imprimatur", "--reason", "not planned", "--comment", "Imprimatur: bırakıldı"],
    ["issue", "reopen", "3", "-R", "halilural/imprimatur", "--comment", "Imprimatur: yeniden açıldı"],
  ]);
  assert.ok(!JSON.stringify(f.calls).includes("gizli") && !JSON.stringify(f.calls).includes("özel"));
  assert.equal(r.pushed, 3);
  assert.equal(db.trackerOutboxCount(), 0);
  assert.equal(describe(r), "tracker github: pushed 3, pulled 0 changes, 0 new tasks");
  // Per provider: GitHub ran, Jira did not.
  assert.ok(trackerActive(db, "github"));
  assert.ok(!trackerActive(db, "jira"));
});

test("push: a row whose task changed status since is dropped unpushed; an issue already there is left alone", async () => {
  const { db, repo } = ghRepo();
  flip(db, repo, "#1", "active", "done");
  // The tracker's pull reopened it (queues nothing): the close is out of date.
  db.upsertTask(repo.id, "#1", { status: "active" }, tracker);
  flip(db, repo, "#2", "active", "done");
  const f = fakeGh({ states: { 2: "CLOSED" } });
  const r = await trackerOnce(db, { gh: f.gh });
  assert.deepEqual(f.writes(), []);
  assert.ok(!f.calls.some((c) => c[1] === "view" && c[2] === "1"));
  assert.equal(r.stale, 1);
  assert.equal(r.already, 1);
  assert.equal(db.trackerOutboxCount(), 0);
});

test("push: a failure that counts (4xx) uses a try; after MAX_TRIES the row goes, with a log line", async () => {
  const { db, repo } = ghRepo();
  flip(db, repo, "#5", "active", "done");
  const f = fakeGh({ fail: { close: "HTTP 422: Validation Failed" } });
  const lines = [];
  const r = await trackerOnce(db, { gh: f.gh, log: (l) => lines.push(l) });
  assert.equal(r.failed, 1);
  assert.equal(db.trackerOutbox()[0].tries, 1);
  assert.match(describe(r), /1 failed \(gh issue close: HTTP 422/);
  assert.ok(!trackerActive(db, "github"));
  for (let i = 1; i < MAX_TRIES; i++) await trackerOnce(db, { gh: f.gh, log: (l) => lines.push(l) });
  assert.equal(db.trackerOutboxCount(), 0);
  assert.ok(lines.some((l) => /gave up on close_done #5 after 5 tries/.test(l)));
});

test("push: transient failures (network, 5xx, 429, rate limit) never use a try; they wait with backoff", async () => {
  for (const msg of ["HTTP 502: Bad Gateway", "API rate limit exceeded", "dial tcp: lookup api.github.com: i/o timeout", "HTTP 429"]) assert.ok(isTransient(new Error(msg)), msg);
  assert.ok(!isTransient(new Error("HTTP 404: Not Found")));
  assert.ok(isTransient(Object.assign(new Error("x"), { transient: true })));
  const { db, repo } = ghRepo();
  flip(db, repo, "#5", "active", "done");
  const f = fakeGh({ fail: { close: "HTTP 503: Service Unavailable" } });
  let t = 1_000_000_000_000;
  const now = () => t;
  for (let i = 0; i < MAX_TRIES + 3; i++) {
    await trackerOnce(db, { gh: f.gh, now });
    const row = db.trackerOutbox()[0];
    assert.equal(row.tries, 0);
    assert.equal(row.fails, i + 1);
    assert.equal(row.next_at, t + Math.min(30_000 * 2 ** i, 1_800_000));
    // Before its time: not tried.
    const closes = f.writes().length;
    const r = await trackerOnce(db, { gh: f.gh, now });
    assert.equal(f.writes().length, closes);
    assert.equal(r.waiting, 1);
    t = row.next_at;
  }
  assert.equal(db.trackerOutboxCount(), 1);
});

test("push: a tracker that is not available keeps the row (no try); only a task that is gone, or a key no tracker takes, is dropped", async () => {
  const { db, repo } = ghRepo();
  const lab = db.repoOf("/lab", { origin: "git@gitlab.com:a/b.git" });
  flip(db, repo, "#6", "active", "done");
  flip(db, { id: lab.id }, "#7", "active", "done");
  flip(db, { id: lab.id }, "PROJ-1", "active", "done");
  db.sqlite.prepare("INSERT INTO tracker_outbox (task_id, action, at) VALUES (999999, 'close_done', 1)").run();
  const misc = db.upsertTask(lab.id, "misc", { status: "done" }, agent);
  db.sqlite.prepare("INSERT INTO tracker_outbox (task_id, action, at) VALUES (?, 'close_done', 1)").run(misc.id);
  const f = fakeGh({ auth: false });
  const r = await trackerOnce(db, { gh: f.gh, env: {} });
  assert.match(describe(r), /no issue tracker for these repos \(3 pushes waiting\)/);
  assert.deepEqual(db.trackerOutbox().map((x) => [x.key, x.tries, x.fails]), [["#6", 0, 0], ["#7", 0, 0], ["PROJ-1", 0, 0]]);
});

test("push: two windows at once close the issue once; a claim of a dead run is taken over after 2 minutes", async () => {
  const { db, repo } = ghRepo();
  flip(db, repo, "#1", "active", "done");
  let release;
  const slowView = new Promise((r) => (release = r));
  const f = fakeGh({ slowView });
  const both = Promise.all([trackerOnce(db, { gh: f.gh }), trackerOnce(db, { gh: f.gh })]);
  await new Promise((r) => setTimeout(r, 20));
  release();
  await both;
  assert.equal(f.writes().length, 1);
  assert.equal(db.trackerOutboxCount(), 0);
  flip(db, repo, "#1", "active", "done");
  const id = db.trackerOutbox()[0].id;
  assert.ok(db.trackerClaim(id, "dead-run", Date.now() - 3 * 60_000));
  assert.ok(!db.trackerClaim(id, "other", Date.now() - 4 * 60_000 + 60_000));
  const g = fakeGh();
  await trackerOnce(db, { gh: g.gh });
  assert.equal(g.writes().length, 1);
});

test("pull github: the first pull records issue states only; later pulls act on state changes, not on updatedAt", async () => {
  const { db, repo, l56, t56 } = epicSetup();
  db.upsertTask(repo.id, "#1", { title: "one", status: "active" }, agent);
  db.upsertTask(repo.id, "#7", { status: "open" }, agent);
  const issues = [
    { number: 56, title: "Süreç", state: "OPEN", stateReason: "", updatedAt: OLD },
    { number: 1, title: "one", state: "CLOSED", stateReason: "COMPLETED", updatedAt: later() },
    { number: 2, title: "Yeni iş", state: "OPEN", stateReason: "", updatedAt: later() },
    { number: 3, title: "Eski kapalı", state: "CLOSED", stateReason: "COMPLETED", updatedAt: later() },
    { number: 7, title: "Başlıksızdı", state: "OPEN", stateReason: "", updatedAt: OLD },
  ];
  const f = fakeGh({ issues });
  let r = await trackerOnce(db, { gh: f.gh, repos: [repo] });
  const st = (k) => db.taskByKey(repo.id, k);
  // Baseline: #1 closed there but active here stays; open #2 becomes a task, closed #3 does not.
  assert.equal(st("#1").status, "active");
  assert.equal(st("#2").status, "open");
  assert.equal(st("#3"), undefined);
  assert.equal(st("#7").title, "Başlıksızdı");
  assert.equal(r.created, 1);
  // A comment bumps updatedAt, the state stays: nothing changes.
  issues[1].updatedAt = later();
  r = await trackerOnce(db, { gh: f.gh, repos: [repo] });
  assert.equal(st("#1").status, "active");
  assert.equal(r.changes, 0);
  // #56 closed, #2 closed as not planned, #1 reopened (open again after closed).
  Object.assign(issues[0], { state: "CLOSED", stateReason: "COMPLETED" });
  Object.assign(issues[2], { state: "CLOSED", stateReason: "NOT_PLANNED" });
  Object.assign(issues[1], { state: "OPEN", stateReason: "REOPENED" });
  db.upsertTask(repo.id, "#1", { status: "done" }, tracker); // done here (by the tracker earlier)
  r = await trackerOnce(db, { gh: f.gh, repos: [repo] });
  assert.equal(st("#56").status, "done");
  assert.equal(st("#2").status, "dropped");
  assert.equal(st("#1").status, "active");
  assert.equal(r.changes, 3);
  // The epic line closed with #56, by the tracker; nothing queued to push back.
  assert.equal(db.record(l56.id).status, "done");
  assert.equal(db.versionsOf(l56.id).find((v) => v.after?.status === "done").actor, "tracker:github");
  assert.equal(db.trackerOutboxCount(), 0);
  assert.ok(t56);
});

test("pull github: a waiting push wins over the issue; dry run writes nothing", async () => {
  const { db, repo } = ghRepo();
  const issues = [{ number: 9, title: "nine", state: "OPEN", updatedAt: OLD }];
  db.upsertTask(repo.id, "#9", { title: "nine", status: "active" }, agent);
  await trackerOnce(db, { gh: fakeGh({ issues }).gh, repos: [repo] });
  flip(db, repo, "#9", "done");
  issues[0].state = "CLOSED";
  issues.push({ number: 10, title: "ten", state: "OPEN", updatedAt: OLD });
  const lines = [];
  const g = fakeGh({ issues, states: { 9: "OPEN" } });
  const r = await trackerOnce(db, { gh: g.gh, repos: [repo], dryRun: true, log: (l) => lines.push(l) });
  assert.equal(db.taskByKey(repo.id, "#10"), undefined);
  assert.equal(db.trackerOutboxCount(), 1);
  assert.equal(db.trackerOutbox()[0].claimed_at, null);
  assert.deepEqual(g.writes(), []);
  assert.equal(r.created, 1);
  assert.ok(lines.some((l) => /would close done #9/.test(l)));
  assert.ok(lines.some((l) => /would add halilural\/imprimatur#10 ten/.test(l)));
  // #9's push failing: the pull leaves it done although the issue is open.
  issues[0].state = "OPEN";
  await trackerOnce(db, { gh: fakeGh({ issues, fail: { close: "HTTP 422" } }).gh, repos: [repo] });
  assert.equal(db.taskByKey(repo.id, "#9").status, "done");
});

test("pull github: createTasks off makes no task; on, at most maxCreate a run, with a log line", async () => {
  const issues = [1, 2, 3, 4].map((n) => ({ number: n, title: `i${n}`, state: "OPEN", updatedAt: OLD }));
  const a = ghRepo();
  await trackerOnce(a.db, { gh: fakeGh({ issues }).gh, repos: [a.repo], createTasks: false });
  assert.equal(a.db.tasksOf(a.repo.id).length, 0);
  const b = ghRepo();
  const lines = [];
  const r = await trackerOnce(b.db, { gh: fakeGh({ issues }).gh, repos: [b.repo], maxCreate: 2, log: (l) => lines.push(l) });
  assert.equal(r.created, 2);
  assert.equal(b.db.tasksOf(b.repo.id).length, 2);
  assert.ok(lines.some((l) => /2 more open issues without a task; at most 2 tasks are made per run/.test(l)));
});

test("githubRepo: only github.com origins, any spelling", () => {
  assert.equal(githubRepo("git@github.com:a/b.git"), "a/b");
  assert.equal(githubRepo("https://github.com/a/b"), "a/b");
  assert.equal(githubRepo("https://gitlab.com/a/b"), undefined);
  assert.equal(githubRepo(null), undefined);
});

const TRANSITIONS = [
  { id: "11", name: "Back to do", to: { name: "To Do", statusCategory: { key: "new" } } },
  { id: "21", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
  { id: "41", name: "Give up", to: { name: "Won't Do", statusCategory: { key: "done" } } },
  { id: "31", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } } },
];

/** Jira's REST API, faked: issue statuses, transitions, what was posted; fail["KEY/route"] = status, once. */
function fakeJira(issues, { fail = {}, transitions = TRANSITIONS } = {}) {
  const posts = [];
  const res = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, "https://jira.invalid");
    assert.equal(init.headers.authorization, `Basic ${Buffer.from("me@x.com:tok").toString("base64")}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (u.pathname === "/rest/api/3/search/jql") {
      const keys = /key in \((.*)\)/.exec(body.jql)[1].split(",");
      if (keys.some((k) => !issues[k])) return res(400, { errorMessages: ["An issue with key does not exist"] });
      return res(200, { issues: keys.map((k) => ({ key: k, fields: issues[k] })) });
    }
    const m = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(u.pathname);
    const key = decodeURIComponent(m[1]);
    const failing = fail[`${key}${m[2] ?? ""}${body ? ":post" : ""}`];
    if (failing) {
      delete fail[`${key}${m[2] ?? ""}${body ? ":post" : ""}`];
      return res(failing, { errorMessages: ["fake failure"] });
    }
    if (!issues[key]) return res(404, { errorMessages: ["no"] });
    if (!m[2]) return res(200, { key, fields: issues[key] });
    if (m[2] === "/transitions" && !body) return res(200, { transitions });
    posts.push([key, m[2], m[2] === "/comment" ? body.body.content[0].content[0].text : body.transition.id]);
    if (m[2] === "/transitions") issues[key].status = { statusCategory: transitions.find((t) => t.id === body.transition.id).to.statusCategory };
    return res(m[2] === "/comment" ? 201 : 204);
  };
  return { fetch, posts };
}

function jiraDb({ mode = 0o600, token, baseUrl = "https://jira.invalid/" } = {}) {
  const file = tmpDb();
  const cfg = path.join(path.dirname(file), "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ tracker: { jira: { baseUrl, email: "me@x.com", ...(token && { token }) } } }), { mode });
  fs.chmodSync(cfg, mode);
  return openDb({ path: file });
}
const jiraEnv = { IMPRIMATUR_JIRA_TOKEN: "tok" };

test("readJira: https only (http for localhost); token from env or a 0600 plain file; symlinks and readable files refused", () => {
  const db = jiraDb({ token: "filetok" });
  assert.deepEqual(readJira(db.file, {}, "linux").jira, { baseUrl: "https://jira.invalid", email: "me@x.com", token: "filetok" });
  assert.equal(readJira(db.file, jiraEnv, "linux").jira.token, "tok");
  assert.match(readJira(jiraDb({ token: "t", mode: 0o644 }).file, {}, "linux").why, /readable by others/);
  assert.match(readJira(jiraDb().file, {}, "linux").why, /no token/);
  assert.match(readJira(jiraDb({ baseUrl: "http://jira.example.com" }).file, jiraEnv, "linux").why, /must be https/);
  assert.equal(readJira(jiraDb({ baseUrl: "http://localhost:8080" }).file, jiraEnv, "linux").jira.baseUrl, "http://localhost:8080");
  const real = jiraDb({ token: "t" });
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-70l-"));
  fs.symlinkSync(path.join(path.dirname(real.file), "config.json"), path.join(linkDir, "config.json"));
  assert.match(readJira(path.join(linkDir, "imprimatur.db"), jiraEnv, "linux").why, /symlink/);
  assert.deepEqual(readJira(tmpDb(), {}, "linux"), {});
});

test("pickTransition: by the target's name, else the first done status; reopen to in progress", () => {
  assert.equal(pickTransition(TRANSITIONS, "close_done").id, "31");
  assert.equal(pickTransition(TRANSITIONS, "close_dropped").id, "41");
  assert.equal(pickTransition(TRANSITIONS, "reopen").id, "21");
  const plain = [{ id: "5", to: { name: "Resolved-ish", statusCategory: { key: "done" } } }, { id: "6", to: { name: "Closed", statusCategory: { key: "done" } } }];
  assert.equal(pickTransition(plain, "close_done").id, "6");
  assert.equal(pickTransition(plain, "close_dropped").id, "5");
  assert.equal(pickTransition([{ id: "1", to: { statusCategory: { key: "new" } } }], "reopen").id, "1");
});

test("jira push: comment first (fixed text), then the transition by name; a retry does not comment twice", async () => {
  const db = jiraDb();
  const repo = db.repoOf("/j");
  const issues = {
    "PROJ-1": { summary: "one", status: { statusCategory: { key: "indeterminate" } } },
    "PROJ-2": { summary: "two", status: { statusCategory: { key: "indeterminate" } } },
    "PROJ-3": { summary: "three", status: { statusCategory: { key: "done" } } },
  };
  db.upsertTask(repo.id, "PROJ-1", { title: "gizli", summary: "özel", status: "active" }, agent);
  flip(db, repo, "PROJ-1", "done");
  flip(db, repo, "PROJ-2", "active", "dropped");
  flip(db, repo, "PROJ-3", "done", "active");
  const j = fakeJira(issues, { fail: { "PROJ-2/transitions:post": 409 } });
  const r = await trackerOnce(db, { env: jiraEnv, fetch: j.fetch, gh: async () => assert.fail("no gh for Jira") });
  assert.deepEqual(j.posts, [
    ["PROJ-1", "/comment", "Imprimatur: tamamlandı"], ["PROJ-1", "/transitions", "31"],
    ["PROJ-2", "/comment", "Imprimatur: bırakıldı"],
    ["PROJ-3", "/comment", "Imprimatur: yeniden açıldı"], ["PROJ-3", "/transitions", "21"],
  ]);
  assert.equal(r.failed, 1);
  const row = db.trackerOutbox()[0];
  assert.deepEqual([row.key, row.tries, row.commented], ["PROJ-2", 1, 1]);
  await trackerOnce(db, { env: jiraEnv, fetch: j.fetch });
  assert.deepEqual(j.posts.slice(5), [["PROJ-2", "/transitions", "41"]]);
  assert.equal(db.trackerOutboxCount(), 0);
  assert.ok(trackerActive(db, "jira"));
});

test("jira push: a retry finds the issue moved but its comment never went: the comment goes now; 5xx is transient", async () => {
  const db = jiraDb();
  const repo = db.repoOf("/j");
  const issues = { "PROJ-4": { status: { statusCategory: { key: "indeterminate" } } } };
  flip(db, repo, "PROJ-4", "active", "done");
  const j = fakeJira(issues, { fail: { "PROJ-4/comment:post": 400 } });
  await trackerOnce(db, { env: jiraEnv, fetch: j.fetch });
  assert.deepEqual([db.trackerOutbox()[0].tries, db.trackerOutbox()[0].commented], [1, 0]);
  issues["PROJ-4"].status = { statusCategory: { key: "done" } }; // someone moved it meanwhile
  await trackerOnce(db, { env: jiraEnv, fetch: j.fetch });
  assert.deepEqual(j.posts, [["PROJ-4", "/comment", "Imprimatur: tamamlandı"]]);
  assert.equal(db.trackerOutboxCount(), 0);
  flip(db, repo, "PROJ-4", "active");
  const k = fakeJira(issues, { fail: { "PROJ-4": 503 } });
  await trackerOnce(db, { env: jiraEnv, fetch: k.fetch });
  assert.deepEqual([db.trackerOutbox()[0].tries, db.trackerOutbox()[0].fails], [0, 1]);
});

test("jira pull: baseline first, then status category changes; unknown keys are skipped", async () => {
  const db = jiraDb();
  const repo = db.repoOf("/j");
  const issues = {
    "PROJ-3": { summary: "three", status: { statusCategory: { key: "indeterminate" } } },
    "PROJ-4": { summary: "four", status: { statusCategory: { key: "done" } }, resolution: { name: "Done" } },
    "PROJ-5": { summary: "Jira'dan başlık", status: { statusCategory: { key: "new" } } },
  };
  db.upsertTask(repo.id, "PROJ-3", { title: "three", status: "active" }, agent);
  db.upsertTask(repo.id, "PROJ-4", { title: "four", status: "active" }, agent);
  db.upsertTask(repo.id, "PROJ-5", { status: "open" }, agent);
  db.upsertTask(repo.id, "GONE-9", { status: "open" }, agent);
  const j = fakeJira(issues);
  await trackerOnce(db, { repos: [repo], env: jiraEnv, fetch: j.fetch });
  const st = (k) => db.taskByKey(repo.id, k);
  assert.equal(st("PROJ-4").status, "active"); // baseline: no flip
  assert.equal(st("PROJ-5").title, "Jira'dan başlık");
  issues["PROJ-3"] = { ...issues["PROJ-3"], status: { statusCategory: { key: "done" } }, resolution: { name: "Done" } };
  issues["PROJ-5"] = { ...issues["PROJ-5"], status: { statusCategory: { key: "done" } }, resolution: { name: "Won't Do" } };
  const r = await trackerOnce(db, { repos: [repo], env: jiraEnv, fetch: j.fetch });
  assert.equal(st("PROJ-3").status, "done");
  assert.equal(st("PROJ-4").status, "active");
  assert.equal(st("PROJ-5").status, "dropped");
  assert.equal(describe(r), "tracker jira: pushed 0, pulled 2 changes, 0 new tasks");
  assert.equal(db.trackerOutboxCount(), 0);
});

test("sweep: quiet while GitHub sync covers the repo; on when it has not run, or a push of the repo is stuck", () => {
  const { db, repo } = ghRepo();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-70s-")));
  req("node:child_process").execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify({ process: {} }));
  const call = () => check("PostToolUse", { cwd: root, tool_name: "mcp__imprimatur__task_upsert", tool_input: { key: "#56", status: "done" } }, {
    gh: () => JSON.stringify({ state: "OPEN" }),
    records: { dbOf: () => db, repoId: () => repo.id },
  });
  assert.match(call().context[0], /#56 is done in Imprimatur but its GitHub issue is open/);
  db.setMeta("tracker_ok_at:github", Date.now() - 60_000);
  flip(db, repo, "#56", "active", "done"); // just queued: the extension pushes it in seconds
  assert.ok(githubSyncCovers(db, repo.id));
  assert.deepEqual(call(), {});
  db.trackerBackoff(db.trackerOutbox()[0].id, Date.now()); // failed once: the user hears of it
  assert.match(call().context[0], /#56 is done/);
  db.trackerDone(db.trackerOutbox()[0].id);
  db.setMeta("tracker_ok_at:github", Date.now() - 3_600_000);
  assert.match(call().context[0], /#56 is done/);
  assert.equal(COMMENT.close_done, "Imprimatur: tamamlandı");
});

test("syncLoop: a named loop says its name when a run fails", async () => {
  const lines = [];
  const loop = syncLoop(async () => {
    throw new Error("boom");
  }, (l) => lines.push(l), { intervalMs: 1e9, name: "tracker sync" });
  const r = await loop.now();
  loop.dispose();
  assert.equal(r.error, "tracker sync failed: boom");
});
