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
const { trackerOnce, describe, trackerActive, githubRepo, readJira, jiraTime, MAX_TRIES } = req("../vscode/tracker.js");
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
  assert.equal(rows[0].comment, "kod hazır");
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

/** A fake gh: answers by subcommand, records every call. */
function fakeGh({ issues = [], states = {}, fail = {}, auth = true } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    const [a, b, n] = args;
    if (a === "auth") {
      if (!auth) throw new Error("gh auth status: not logged in");
      return "";
    }
    if (fail[b]) throw new Error(`gh issue ${b}: ${fail[b]}`);
    // The list follows what this run closed or reopened (GitHub would show it so).
    if (b === "list") return JSON.stringify(issues.map((i) => (states[i.number] && states[i.number] !== i.state ? { ...i, state: states[i.number], updatedAt: later() } : i)));
    if (b === "view") return JSON.stringify({ state: states[n] ?? "OPEN" });
    if (b === "close") states[n] = "CLOSED";
    if (b === "reopen") states[n] = "OPEN";
    return "";
  };
  return { gh, calls, writes: () => calls.filter((c) => c[1] === "close" || c[1] === "reopen") };
}

test("push github: done closes the issue as completed with the summary, dropped as not planned, reopen reopens", async () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r", { origin: ORIGIN });
  for (const k of ["#1", "#2", "#3"]) db.upsertTask(repo.id, k, { title: `T${k}`, status: "active", summary: `özet ${k}` }, agent);
  db.upsertTask(repo.id, "#1", { status: "done" }, agent);
  db.upsertTask(repo.id, "#2", { status: "dropped" }, agent);
  db.upsertTask(repo.id, "#3", { status: "done" }, agent);
  db.upsertTask(repo.id, "#3", { status: "active" }, agent);
  const f = fakeGh({ states: { 3: "CLOSED" } });
  const r = await trackerOnce(db, { gh: f.gh });
  assert.deepEqual(f.writes(), [
    ["issue", "close", "1", "-R", "halilural/imprimatur", "--reason", "completed", "--comment", "Imprimatur: özet #1"],
    ["issue", "close", "2", "-R", "halilural/imprimatur", "--reason", "not planned", "--comment", "Imprimatur: özet #2"],
    ["issue", "reopen", "3", "-R", "halilural/imprimatur"],
  ]);
  assert.equal(r.pushed, 3);
  assert.equal(db.trackerOutboxCount(), 0);
  assert.equal(describe(r), "tracker github: pushed 3, pulled 0 changes, 0 new tasks");
  assert.ok(trackerActive(db));
});

test("push github: an issue already in that state is left alone; the row goes", async () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r", { origin: ORIGIN });
  db.upsertTask(repo.id, "#4", { status: "active" }, agent);
  db.upsertTask(repo.id, "#4", { status: "done" }, agent);
  const f = fakeGh({ states: { 4: "CLOSED" } });
  const r = await trackerOnce(db, { gh: f.gh });
  assert.deepEqual(f.writes(), []);
  assert.equal(r.already, 1);
  assert.equal(db.trackerOutboxCount(), 0);
});

test("push github: a failure keeps the row and counts a try; after MAX_TRIES it is dropped with a log line", async () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r", { origin: ORIGIN });
  db.upsertTask(repo.id, "#5", { status: "active" }, agent);
  db.upsertTask(repo.id, "#5", { status: "done" }, agent);
  const f = fakeGh({ fail: { close: "HTTP 502" } });
  const lines = [];
  const r = await trackerOnce(db, { gh: f.gh, log: (l) => lines.push(l) });
  assert.equal(r.failed, 1);
  assert.equal(db.trackerOutbox()[0].tries, 1);
  assert.match(describe(r), /1 failed \(gh issue close: HTTP 502\)/);
  assert.ok(!trackerActive(db));
  for (let i = 1; i < MAX_TRIES; i++) await trackerOnce(db, { gh: f.gh, log: (l) => lines.push(l) });
  assert.equal(db.trackerOutboxCount(), 0);
  assert.ok(lines.some((l) => /gave up on close_done #5 after 5 tries/.test(l)));
});

test("push: gh not logged in keeps the row without a try; no tracker for the repo drops it", async () => {
  const db = openDb({ path: tmpDb() });
  const gh = db.repoOf("/r", { origin: ORIGIN });
  const lab = db.repoOf("/lab", { origin: "git@gitlab.com:a/b.git" });
  db.upsertTask(gh.id, "#6", { status: "active" }, agent);
  db.upsertTask(gh.id, "#6", { status: "done" }, agent);
  db.upsertTask(lab.id, "#6", { status: "active" }, agent);
  db.upsertTask(lab.id, "#6", { status: "done" }, agent);
  db.upsertTask(lab.id, "PROJ-1", { status: "active" }, agent);
  db.upsertTask(lab.id, "PROJ-1", { status: "done" }, agent);
  const f = fakeGh({ auth: false });
  const r = await trackerOnce(db, { gh: f.gh, env: {} });
  assert.equal(describe(r), "tracker: no issue tracker for these repos");
  const left = db.trackerOutbox();
  assert.deepEqual(left.map((x) => [x.key, x.tries]), [["#6", 0]]);
  assert.equal(left[0].repo_id, gh.id);
});

test("pull github: closed issues close tasks (and their epic lines, without a push), open ones reopen, new open issues become tasks", async () => {
  const { db, repo, l56 } = epicSetup();
  const add = (k, f) => db.upsertTask(repo.id, k, f, agent);
  add("#1", { title: "one", status: "active" });
  add("#4", { title: "four", status: "active" });
  add("#4", { status: "done" });
  db.trackerDone(db.trackerOutbox()[0].id);
  add("#5", { title: "five", status: "open" });
  add("#6", { title: "six", status: "active" });
  add("#7", { status: "open" });
  add("#8", { title: "eight", status: "active" });
  add("#8", { status: "done" }); // its close waits: the pull leaves #8 alone
  const issues = [
    { number: 56, title: "Süreç", state: "CLOSED", stateReason: "COMPLETED", updatedAt: later() },
    { number: 1, title: "one", state: "CLOSED", stateReason: "COMPLETED", updatedAt: later() },
    { number: 2, title: "Yeni iş", state: "OPEN", stateReason: "", updatedAt: later() },
    { number: 3, title: "Eski kapalı", state: "CLOSED", stateReason: "COMPLETED", updatedAt: later() },
    { number: 4, title: "four", state: "OPEN", stateReason: "REOPENED", updatedAt: later() },
    { number: 5, title: "five", state: "CLOSED", stateReason: "NOT_PLANNED", updatedAt: later() },
    { number: 6, title: "six", state: "CLOSED", stateReason: "COMPLETED", updatedAt: OLD },
    { number: 7, title: "Başlıksızdı", state: "OPEN", stateReason: "", updatedAt: OLD },
    { number: 8, title: "eight", state: "OPEN", stateReason: "", updatedAt: later() },
  ];
  const f = fakeGh({ issues, states: { 8: "OPEN" } });
  const r = await trackerOnce(db, { gh: f.gh, repos: [repo] });
  const st = (k) => db.taskByKey(repo.id, k);
  assert.equal(st("#56").status, "done");
  assert.equal(st("#1").status, "done");
  assert.equal(st("#2").title, "Yeni iş");
  assert.equal(st("#2").status, "open");
  assert.equal(st("#3"), undefined);
  assert.equal(st("#4").status, "active");
  assert.equal(st("#5").status, "dropped");
  assert.equal(st("#6").status, "active");
  assert.equal(st("#7").title, "Başlıksızdı");
  // #8's close was pushed first, then the pull saw it closed: still done.
  assert.equal(st("#8").status, "done");
  assert.deepEqual(f.writes(), [["issue", "close", "8", "-R", "halilural/imprimatur", "--reason", "completed", "--comment", "Imprimatur: eight"]]);
  // The epic line closed with the task, by the tracker; nothing queued to push back.
  assert.equal(db.record(l56.id).status, "done");
  assert.equal(db.versionsOf(l56.id).find((v) => v.after?.status === "done").actor, "tracker:github");
  assert.equal(db.trackerOutboxCount(), 0);
  assert.equal(r.created, 1);
  assert.equal(r.changes, 5);
  assert.equal(describe(r), "tracker github: pushed 1, pulled 5 changes, 1 new task");
  assert.deepEqual(f.calls.find((c) => c[1] === "list"), ["issue", "list", "-R", "halilural/imprimatur", "--state", "all", "--limit", "500", "--json", "number,title,state,stateReason,updatedAt,milestone"]);
});

test("pull github: a waiting push wins over the issue; dry run writes nothing", async () => {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf("/r", { origin: ORIGIN });
  db.upsertTask(repo.id, "#9", { title: "nine", status: "active" }, agent);
  db.upsertTask(repo.id, "#9", { status: "done" }, agent);
  const f = fakeGh({ issues: [{ number: 9, title: "nine", state: "OPEN", updatedAt: later() }, { number: 10, title: "ten", state: "OPEN", updatedAt: later() }], fail: { close: "offline" } });
  await trackerOnce(db, { gh: f.gh, repos: [repo] });
  assert.equal(db.taskByKey(repo.id, "#9").status, "done");
  const lines = [];
  const g = fakeGh({ issues: [{ number: 11, title: "eleven", state: "OPEN", updatedAt: later() }], states: { 9: "OPEN" } });
  const r = await trackerOnce(db, { gh: g.gh, repos: [repo], dryRun: true, log: (l) => lines.push(l) });
  assert.equal(db.taskByKey(repo.id, "#11"), undefined);
  assert.equal(db.trackerOutboxCount(), 1);
  assert.deepEqual(g.writes(), []);
  assert.equal(r.created, 1);
  assert.ok(lines.some((l) => /would close done #9/.test(l)));
  assert.ok(lines.some((l) => /would add halilural\/imprimatur#11 eleven/.test(l)));
});

test("githubRepo: only github.com origins, any spelling", () => {
  assert.equal(githubRepo("git@github.com:a/b.git"), "a/b");
  assert.equal(githubRepo("https://github.com/a/b"), "a/b");
  assert.equal(githubRepo("https://gitlab.com/a/b"), undefined);
  assert.equal(githubRepo(null), undefined);
});

/** Jira's REST API, faked: issue statuses, transitions, and what was posted. */
function fakeJira(issues) {
  const posts = [];
  const res = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(init.headers.authorization, `Basic ${Buffer.from("me@x.com:tok").toString("base64")}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (u.pathname === "/rest/api/3/search/jql") {
      const keys = /key in \((.*)\)/.exec(body.jql)[1].split(",");
      if (keys.some((k) => !issues[k])) return res(400, { errorMessages: ["An issue with key does not exist"] });
      return res(200, { issues: keys.map((k) => ({ key: k, fields: issues[k] })) });
    }
    const m = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(u.pathname);
    const key = decodeURIComponent(m[1]);
    if (!issues[key]) return res(404, { errorMessages: ["no"] });
    if (!m[2]) return res(200, { key, fields: issues[key] });
    if (m[2] === "/transitions" && !body) {
      return res(200, { transitions: [
        { id: "11", to: { statusCategory: { key: "new" } } },
        { id: "21", to: { statusCategory: { key: "indeterminate" } } },
        { id: "31", to: { statusCategory: { key: "done" } } },
      ] });
    }
    posts.push([key, m[2], body]);
    return res(m[2] === "/comment" ? 201 : 204);
  };
  return { fetch, posts };
}

function jiraDb(mode = 0o600, token) {
  const file = tmpDb();
  fs.writeFileSync(path.join(path.dirname(file), "config.json"), JSON.stringify({ tracker: { jira: { baseUrl: "https://jira.invalid/", email: "me@x.com", ...(token && { token }) } } }), { mode });
  fs.chmodSync(path.join(path.dirname(file), "config.json"), mode);
  return openDb({ path: file });
}

test("readJira: token from the env, or from a 0600 config.json; a readable one is refused", () => {
  const db = jiraDb(0o600, "filetok");
  assert.deepEqual(readJira(db.file, {}, "linux").jira, { baseUrl: "https://jira.invalid", email: "me@x.com", token: "filetok" });
  assert.equal(readJira(db.file, { IMPRIMATUR_JIRA_TOKEN: "envtok" }, "linux").jira.token, "envtok");
  const open = jiraDb(0o644, "filetok");
  assert.match(readJira(open.file, {}, "linux").why, /readable by others/);
  assert.match(readJira(jiraDb().file, {}, "linux").why, /no token/);
  assert.deepEqual(readJira(tmpDb(), {}, "linux"), {});
  assert.equal(jiraTime("2026-10-01T12:00:00.000+0000"), Date.parse("2026-10-01T12:00:00.000Z"));
});

test("jira: push transitions to a done status with an ADF comment, reopens to in progress; pull maps status categories", async () => {
  const db = jiraDb();
  const repo = db.repoOf("/j");
  const env = { IMPRIMATUR_JIRA_TOKEN: "tok" };
  const newer = new Date(Date.now() + 60_000).toISOString().replace("Z", "+0000");
  const issues = {
    "PROJ-1": { summary: "one", status: { statusCategory: { key: "indeterminate" } }, updated: "2020-01-01T00:00:00.000+0000" },
    "PROJ-2": { summary: "two", status: { statusCategory: { key: "done" } }, updated: "2020-01-01T00:00:00.000+0000" },
    "PROJ-3": { summary: "three", status: { statusCategory: { key: "done" } }, resolution: { name: "Done" }, updated: newer },
    "PROJ-4": { summary: "four", status: { statusCategory: { key: "new" } }, updated: newer },
    "PROJ-5": { summary: "Jira'dan başlık", status: { statusCategory: { key: "done" } }, resolution: { name: "Won't Do" }, updated: newer },
  };
  db.upsertTask(repo.id, "PROJ-1", { title: "one", status: "active", summary: "bitti" }, agent);
  db.upsertTask(repo.id, "PROJ-1", { status: "done" }, agent);
  db.upsertTask(repo.id, "PROJ-2", { title: "two", status: "done" }, agent);
  db.upsertTask(repo.id, "PROJ-2", { status: "active" }, agent);
  db.upsertTask(repo.id, "PROJ-3", { title: "three", status: "active" }, agent);
  db.upsertTask(repo.id, "PROJ-4", { title: "four", status: "done" }, agent);
  db.upsertTask(repo.id, "PROJ-5", { status: "open" }, agent);
  db.upsertTask(repo.id, "GONE-9", { status: "open" }, agent);
  const j = fakeJira(issues);
  const r = await trackerOnce(db, { repos: [repo], env, fetch: j.fetch, gh: async () => assert.fail("no gh for Jira") });
  assert.deepEqual(j.posts, [
    ["PROJ-1", "/transitions", { transition: { id: "31" } }],
    ["PROJ-1", "/comment", { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Imprimatur: bitti" }] }] } }],
    ["PROJ-2", "/transitions", { transition: { id: "21" } }],
    ["PROJ-2", "/comment", { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Imprimatur: reopened (two)" }] }] } }],
  ]);
  const st = (k) => db.taskByKey(repo.id, k);
  assert.equal(st("PROJ-3").status, "done");
  assert.equal(st("PROJ-4").status, "active");
  assert.equal(st("PROJ-5").status, "dropped");
  assert.equal(st("PROJ-5").title, "Jira'dan başlık");
  // Pushed changes stay: the issues' old dates do not pull them back.
  assert.equal(st("PROJ-1").status, "done");
  assert.equal(st("PROJ-2").status, "active");
  assert.equal(db.trackerOutboxCount(), 0);
  assert.equal(describe(r), "tracker jira: pushed 2, pulled 3 changes, 0 new tasks");
});

test("sweep: quiet while tracker sync runs, as before when it does not", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-70s-")));
  req("node:child_process").execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify({ process: {} }));
  const call = (at) => check("PostToolUse", { cwd: root, tool_name: "mcp__imprimatur__task_upsert", tool_input: { key: "#56", status: "done" } }, {
    gh: () => JSON.stringify({ state: "OPEN" }),
    records: { dbOf: () => ({ meta: (k) => (k === "tracker_ok_at" && at ? String(at) : undefined) }) },
  });
  assert.deepEqual(call(Date.now() - 60_000), {});
  assert.match(call(undefined).context[0], /#56 is done in Imprimatur but its GitHub issue is open/);
  assert.match(call(Date.now() - 3_600_000).context[0], /#56 is done/);
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
