// What waits on the user (#69; vscode/inbox.js since the old panel went, #202): the model the
// launcher's badge, the status bar and the new panel's ⏳ count from, on a temp database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
/** A turn-end ask from an hour ago: one older than a week is stale and not counted. */
const RECENT = new Date(Date.now() - 3600e3).toISOString();

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const tv = req("../vscode/inbox.js");

const AGENT = { kind: "agent", id: "claude-code:s1" };
const USER = { kind: "user", id: "me" };

/** A database with two repos: this one (tasks #1 active, #2 open, #3 done) and another. */
function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-69-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const repo = db.repoOf(root, { name: "repo" });
  const epic = db.upsertTask(repo.id, "#53", { title: "Epic", status: "active" });
  const t1 = db.upsertTask(repo.id, "#1", { title: "Plugin", status: "active", summary: "Code ready\nmore", epicId: epic.id });
  const done1 = db.addRecord(t1.id, { kind: "todo", owner: "C", title: "plugin.json", status: "done" }, AGENT);
  const next = db.addRecord(t1.id, { kind: "todo", owner: "K", title: "Switch this machine", pointer: true }, AGENT);
  const agentTodo = db.addRecord(t1.id, { kind: "todo", owner: "C", title: "README section" }, AGENT);
  const q = db.addRecord(t1.id, { kind: "question", owner: "K", title: "Switch now or later?" }, AGENT);
  const adr = db.addRecord(t1.id, { kind: "adr", title: "MCP server in plugin.json", body: "Why." }, AGENT);
  const dec = db.addRecord(t1.id, { kind: "decision", title: "Later", body: "Sessions" }, USER);
  const test1 = db.addRecord(t1.id, { kind: "test", title: "MT-PL-001 validate passes" }, AGENT);
  const t2 = db.upsertTask(repo.id, "#2", { title: "Open task", status: "open" });
  const t3 = db.upsertTask(repo.id, "#3", { title: "Finished", status: "done" });
  const otherRoot = path.join(dir, "other");
  const other = db.repoOf(otherRoot, { name: "other" });
  const o1 = db.upsertTask(other.id, "OT-1", { title: "Other", status: "active" });
  const oq = db.addRecord(o1.id, { kind: "question", owner: "K", title: "Other repo ask" }, AGENT);
  return { db, file: path.join(dir, "imprimatur.db"), root, repo, epic, t1, t2, t3, done1, next, agentTodo, q, adr, dec, test1, other, o1, oq };
}

test("#69 Waiting on you: buckets, groups by task, turn-end asks counted, today's done", () => {
  const s = seed();
  const waiting = [
    { kind: "question", state: "open", session: "a", item: "t1", i: 0, t: RECENT, text: "Which one?" },
    { kind: "verify", state: "open", session: "a", item: "t1", i: 1, t: RECENT, text: "Bak" },
    { kind: "verify", state: "open", session: "todo-files", item: "t2", i: 0, t: RECENT, text: "x" },
    { kind: "command", state: "done", session: "a", by: "audit", item: "t3", i: 0, t: RECENT, text: "y" },
  ];
  let m = tv.inboxModel(s.db, s.root, { waiting });
  const n = Object.fromEntries(m.buckets.map((b) => [b.id, b.n]));
  assert.deepEqual(n, { question: 2, todo: 1, test: 2, done: 0 }, "the todo-files log mirrors records: not counted twice");
  assert.equal(m.count, 5);
  assert.equal(m.turn, 2);
  assert.deepEqual(m.groups.map((g) => g.task?.key ?? null), ["#1", null], "turn-end asks with no task: No task");
  assert.equal(m.groups[0].items[0].kind, "question", "questions first");
  assert.equal(tv.inboxCount(s.db, s.root, waiting), 5);

  s.db.updateRecord(s.next.id, { status: "done" }, USER);
  m = tv.inboxModel(s.db, s.root, { waiting });
  assert.equal(m.buckets.find((b) => b.id === "done").n, 1, "done today by you");
  assert.ok(m.groups[0].items.some((r) => r.id === s.next.id && r.done));
  assert.equal(m.buckets.find((b) => b.id === "todo").n, 0);

  const all = tv.inboxModel(s.db, s.root, { all: true });
  assert.ok(all.groups.some((g) => g.task?.key === "OT-1"));
});

test("turn-end asks are cards under their task; ticked today shows done; audit's and replaced ones do not", () => {
  const s = seed();
  const now = Date.now();
  const w = (/** @type {any} */ o) => ({ kind: "command", session: "s9", item: "2026-01-01T10:00:00Z", t: RECENT, prompt: "deploy", ...o });
  const waiting = [
    w({ i: 0, state: "open", text: "#1: Deploy it", why: "waiting for prod", detail: "long message" }),
    w({ i: 1, state: "open", kind: "verify", text: "Check by eye" }),
    w({ i: 2, state: "done", text: "#1: Delete the log", at: new Date(now).toISOString() }),
    w({ i: 3, state: "done", by: "audit", text: "#1: Audit closed it", at: new Date(now).toISOString() }),
    w({ i: 4, state: "replaced", text: "#1: Old question" }),
  ];
  const placeOf = (/** @type {any} */ x) => (x.text.startsWith("#1") ? { task: "#1" } : {});
  const m = tv.inboxModel(s.db, s.root, { waiting, placeOf, now });
  const g1 = m.groups.find((g) => g.task?.key === "#1");
  const turn = g1.items.filter((/** @type {any} */ r) => r.turn);
  assert.deepEqual(turn.map((/** @type {any} */ r) => [r.title, r.done]), [["Deploy it", false], ["Delete the log", true]], "open and yours today; not audit's or replaced");
  assert.equal(m.groups.find((g) => !g.task).items[0].kind, "test", "a verify ask is a test; no task: No task");
  assert.equal(turn[0].why, "waiting for prod");
});

test("Waiting on you: every card carries its task's title, so it is found by it", () => {
  const s = seed();
  const m = tv.inboxModel(s.db, s.root, { all: true });
  assert.ok(m.groups.length > 1);
  for (const g of m.groups) assert.ok(g.items.every((r) => r.task_title === g.task.title), g.task.key);
});

test("steps in a record body: checkboxes with their line, a tick rewrites that line", () => {
  const s = seed();
  const body = "**Steps:**\n\n- [ ] Find the pod\n- [x] Open the log\n\n```\n- [ ] not a step\n```\n1. [ ] numbered";
  const r = s.db.addRecord(s.t1.id, { kind: "test", title: "Adhoc 05", body }, AGENT);
  const docs = req("../vscode/markdown.js");
  assert.deepEqual(docs.stepsOf(body), [{ line: 2, done: false }, { line: 3, done: true }, { line: 8, done: false }]);
  assert.match(docs.renderMarkdown(body, { steps: true }), /data-line="2"/);
  assert.ok(!docs.renderMarkdown(body).includes('data-line="2" aria'), "documents: boxes only show");
  const ticked = docs.toggleStep(body, 2, true);
  assert.equal(ticked, body.replace("- [ ] Find", "- [x] Find"), "the step's line ticked");
  assert.equal(docs.toggleStep(body, 6, true), body, "a fenced line is no step");
  assert.ok(docs.toggleStep(ticked, 3, false).includes("- [ ] Open the log"));
  assert.ok(r.id);
});
