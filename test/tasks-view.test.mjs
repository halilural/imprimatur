// The panel's task tabs (#69): Ana sayfa, Görevler, Bende bekleyenler. Their models
// and HTML are pure (vscode/tasksView.js), so they run here on a temp database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const tv = req("../vscode/tasksView.js");

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

test("#69 quick-add: ? question (yours), ! decision, # note, @ben your todo, else the agent's todo", () => {
  assert.deepEqual(tv.parseQuickAdd("? Now or later"), { kind: "question", title: "Now or later", owner: "K" });
  assert.deepEqual(tv.parseQuickAdd("!Ship it"), { kind: "decision", title: "Ship it" });
  assert.deepEqual(tv.parseQuickAdd("# a note"), { kind: "note", title: "a note" });
  assert.deepEqual(tv.parseQuickAdd("@ben test on the other machine"), { kind: "todo", title: "test on the other machine", owner: "K" });
  assert.deepEqual(tv.parseQuickAdd("  write the README  "), { kind: "todo", title: "write the README", owner: "C" });
  assert.deepEqual(tv.parseQuickAdd("#67 follow-up"), { kind: "todo", title: "#67 follow-up", owner: "C" }, "a task key is not a note");
  assert.equal(tv.parseQuickAdd(""), undefined);
  assert.equal(tv.parseQuickAdd("?   "), undefined);
  assert.equal(tv.parseQuickAdd("@ben"), undefined);
});

test("#69 Görevler: the list by status with counts, the selected task's page", () => {
  const s = seed();
  const m = tv.tasksPage(s.db, s.root, {});
  assert.deepEqual(m.counts, { active: 2, open: 1, done: 1 });
  assert.equal(m.filter, "active");
  assert.deepEqual(m.groups.flatMap((g) => g.tasks.map((t) => t.key)).sort(), ["#1", "#53"]);
  const row = m.groups[0].tasks.find((t) => t.key === "#1");
  assert.equal(row.asks, 3, "your todo, your question, the manual test");
  assert.equal(row.openTodos, 2);
  assert.equal(row.pointer, "Switch this machine");
  assert.match(row.q, /MCP server in plugin\.json/, "the search also finds the task's records");

  const page = tv.tasksPage(s.db, s.root, { sel: s.t1.id }).cur;
  assert.equal(page.key, "#1");
  assert.equal(page.epic.key, "#53");
  assert.equal(page.pointer.title, "Switch this machine");
  assert.deepEqual(page.asks.map((r) => r.title).sort(), ["MT-PL-001 validate passes", "Switch now or later?", "Switch this machine"]);
  assert.deepEqual(page.todos.map((r) => r.title), ["Switch this machine", "README section"], "done todos hidden");
  assert.equal(page.hiddenDone, 1);
  assert.equal(page.openTodos, 2);
  assert.deepEqual(page.decisions.map((d) => [d.kind, d.who]), [["adr", "ajan"], ["decision", "sen"]]);
  assert.deepEqual(page.tests.map((t) => t.title), ["MT-PL-001 validate passes"]);
  assert.ok(page.activity.length <= 5);
  assert.ok(page.older > 0, "older events behind a button");
  assert.match(page.activity[0].what, /ekledi|taşıdı/);

  const all = tv.tasksPage(s.db, s.root, { sel: s.t1.id, showDone: [s.t1.id], old: [s.t1.id] }).cur;
  assert.deepEqual(all.todos.map((r) => r.title), ["plugin.json", "Switch this machine", "README section"]);
  assert.equal(all.older, 0);

  const done = tv.tasksPage(s.db, s.root, { filter: "done" });
  assert.deepEqual(done.groups.flatMap((g) => g.tasks.map((t) => t.key)), ["#3"]);
  assert.equal(done.cur.key, "#3", "the first task of the filter is selected");

  // A flashed done todo shows with the done ones.
  const flash = tv.tasksPage(s.db, s.root, { sel: s.t1.id, flash: s.done1.id }).cur;
  assert.equal(flash.flash, s.done1.id);
  assert.ok(flash.todos.some((r) => r.id === s.done1.id));
});

test("#69 Görevler: this repo by default, every repo when asked", () => {
  const s = seed();
  const keys = (m) => m.groups.flatMap((g) => g.tasks.map((t) => t.key));
  assert.ok(!keys(tv.tasksPage(s.db, s.root, {})).includes("OT-1"));
  const m = tv.tasksPage(s.db, s.root, { all: true });
  assert.ok(keys(m).includes("OT-1"));
  assert.equal(m.groups[0].repo.name, "repo", "this window's repo first");
});

test("#69 Bende bekleyenler: buckets, groups by task, turn-end asks counted, today's done", () => {
  const s = seed();
  const waiting = [
    { kind: "question", state: "open", session: "a" },
    { kind: "verify", state: "open", session: "a" },
    { kind: "verify", state: "open", session: "todo-files" },
    { kind: "command", state: "done", session: "a" },
  ];
  let m = tv.inboxModel(s.db, s.root, { waiting });
  const n = Object.fromEntries(m.buckets.map((b) => [b.id, b.n]));
  assert.deepEqual(n, { question: 2, todo: 1, test: 2, done: 0 }, "the todo-files log mirrors records: not counted twice");
  assert.equal(m.count, 5);
  assert.equal(m.turn, 2);
  assert.deepEqual(m.groups.map((g) => g.task.key), ["#1"]);
  assert.equal(m.groups[0].items[0].kind, "question", "questions first");
  assert.equal(tv.inboxCount(s.db, s.root, waiting), 5);

  tv.applyMessage(s.db, { type: "rec", id: s.next.id, op: "done" }, USER);
  m = tv.inboxModel(s.db, s.root, { waiting });
  assert.equal(m.buckets.find((b) => b.id === "done").n, 1, "done today by you");
  assert.ok(m.groups[0].items.some((r) => r.id === s.next.id && r.done));
  assert.equal(m.buckets.find((b) => b.id === "todo").n, 0);

  const all = tv.inboxModel(s.db, s.root, { all: true });
  assert.ok(all.groups.some((g) => g.task.key === "OT-1"));
});

test("#69 Ana sayfa: progress, where we left off, top asks, tasks by status", () => {
  const s = seed();
  const m = tv.homeModel(s.db, s.root);
  assert.equal(m.repoName, "repo");
  assert.equal(m.total, 4);
  assert.equal(m.done, 1);
  assert.deepEqual(m.pointers.map((p) => [p.key, p.next, p.mine]), [["#1", "Switch this machine", true]]);
  assert.equal(m.askCount, 3);
  assert.ok(m.asks.length <= 5);
  assert.deepEqual(m.rows.map((r) => r.status), ["active", "active", "open", "done"]);
});

test("#69 writes from the panel go in as the user", () => {
  const s = seed();
  const last = (id) => s.db.versionsOf(id).at(-1);
  tv.applyMessage(s.db, { type: "rec", id: s.agentTodo.id, op: "done" }, USER);
  assert.equal(s.db.record(s.agentTodo.id).status, "done");
  assert.equal(last(s.agentTodo.id).actor_kind, "user");
  tv.applyMessage(s.db, { type: "rec", id: s.agentTodo.id, op: "open" }, USER);
  tv.applyMessage(s.db, { type: "rec", id: s.agentTodo.id, op: "pointer" }, USER);
  assert.equal(s.db.record(s.agentTodo.id).pointer, true);
  assert.equal(s.db.record(s.next.id).pointer, false, "one 👉 per task");
  tv.applyMessage(s.db, { type: "rec", id: s.agentTodo.id, op: "drop" }, USER);
  assert.equal(s.db.record(s.agentTodo.id).status, "dropped");

  const answer = tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: "Later.\nWhen sessions close." }, USER);
  assert.equal(answer.kind, "answer");
  assert.equal(answer.parent_id, s.q.id);
  assert.equal(answer.title, "Later.");
  assert.equal(answer.body, "Later.\nWhen sessions close.");
  assert.equal(s.db.record(s.q.id).status, "done", "the question is answered");
  assert.equal(last(s.q.id).actor_kind, "user");
  const page = tv.tasksPage(s.db, s.root, { sel: s.t1.id }).cur;
  assert.ok(page.notes.find((r) => r.id === s.q.id).answers.some((a) => a.id === answer.id), "the answer under its question");

  const added = tv.applyMessage(s.db, { type: "add", task: s.t2.id, text: "? Which name" }, USER);
  assert.deepEqual([added.kind, added.owner, added.title], ["question", "K", "Which name"]);
  assert.equal(s.db.versionsOf(added.id)[0].actor_kind, "user");

  tv.applyMessage(s.db, { type: "taskStatus", task: s.t2.id, status: "active" }, USER);
  assert.equal(s.db.taskById(s.t2.id).status, "active");

  assert.throws(() => tv.applyMessage(s.db, { type: "rec", id: "x", op: "done" }, USER), /bad id/);
  assert.throws(() => tv.applyMessage(s.db, { type: "rec", id: s.q.id, op: "nuke" }, USER), /unknown record action/);
  assert.throws(() => tv.applyMessage(s.db, { type: "answer", id: s.q.id, text: "  " }, USER), /empty/);
  assert.throws(() => tv.applyMessage(s.db, { type: "add", task: s.t2.id, text: "" }, USER), /nothing to add/);
  assert.throws(() => tv.applyMessage(s.db, { type: "taskStatus", task: s.t2.id, status: "gone" }, USER), /bad task status/);
  assert.throws(() => tv.applyMessage(s.db, { type: "drop table" }, USER), /unknown panel message/);
});

test("#69 the page's view is cleaned: only known tabs, filters and ids", () => {
  assert.deepEqual(tv.cleanView({ tab: "tasks", sel: "7", filter: "done", all: true, showDone: [1, "2", -3, "x"], old: "no", evil: 1 }),
    { tab: "tasks", sel: 7, filter: "done", all: true, showDone: [1, 2] });
  assert.deepEqual(tv.cleanView({ tab: "<script>", sel: 0, filter: "x", all: "yes" }), {});
  assert.deepEqual(tv.cleanView({ sel: null }), { sel: null });
  assert.deepEqual(tv.cleanView(null), {});
});

test("#69 the tabs' HTML: Turkish labels, escaped text, keyed blocks, no emoji icons", () => {
  const s = seed();
  s.db.addRecord(s.t1.id, { kind: "note", title: "<script>alert(1)</script>" }, AGENT);
  const tasks = tv.paneHtml(s.db, s.root, { tab: "tasks", sel: s.t1.id }, { linkOf: () => "https://github.com/o/r/issues/1" });
  for (const text of ["Aktif · 2", "Nerede kaldık", "Senden beklenen", "Yapılacaklar", "Bitenleri göster (1)", "Kararlar ve tasarım", "Elle testler", "Etkinlik", "Ajan değişikliklerinde göster", "GitHub'da aç", "sıradaki", "Cevapla"])
    assert.ok(tasks.includes(text), text);
  assert.ok(!tasks.includes("<script>alert"), "titles are escaped");
  assert.match(tasks, /data-draft="ans-\d+"/);
  assert.match(tasks, /data-draft="add-\d+"/);
  const inbox = tv.paneHtml(s.db, s.root, { tab: "inbox" }, { waiting: [] });
  for (const text of ["Bende bekleyenler", "Cevap bekliyor", "Senin işin", "Elle test", "Bugün bitirdin", "Bu repo", "Bütün repolar", "Yaptım", "Geçti"])
    assert.ok(inbox.includes(text), text);
  const home = tv.paneHtml(s.db, s.root, { tab: "home" });
  for (const text of ["1 / 4 görev bitti", "Nerede kaldık", "Senden beklenen", "hepsi (3)", "Son değişiklik"]) assert.ok(home.includes(text), text);
  assert.equal(tv.paneHtml(s.db, s.root, { tab: "edits" }), "");
  for (const page of [tasks, inbox, home]) assert.doesNotMatch(page, /\p{Extended_Pictographic}/u, "SVG icons, no emoji");
  assert.doesNotMatch(tv.TASKS_CSS, /#[0-9a-f]{3,8}\b/i, "theme colours only");
  assert.match(tv.paneHtml(undefined, s.root, { tab: "tasks" }, { error: "no sqlite" }), /no sqlite/);
});

test("#69 the panel page: tabs, only the visible tab drawn, its script parses", async () => {
  const Module = req("node:module");
  const load = Module._load;
  Module._load = function (r, ...a) {
    return r === "vscode" ? { window: {}, workspace: {}, commands: {}, env: {}, Uri: {} } : load.call(this, r, ...a);
  };
  try {
    const { html } = req("../vscode/graphView.js");
    const s = seed();
    const data = { rows: [{ file: "a.md", n: 1, t: Date.now(), added: 1, removed: 0, lane: 0, intent: "Edit a" }], lanes: [{ first: 0, last: 0 }], sessions: [] };
    const pane = tv.paneHtml(s.db, s.root, { tab: "tasks" });
    const page = html(data, s.root, "N", [], { view: { tab: "tasks", sel: s.t1.id }, pane, inbox: 4, repoName: "repo" });
    for (const label of ["Ana sayfa", "Görevler", "Bende bekleyenler", "Ajan değişiklikleri"]) assert.ok(page.includes(`>${label}`), label);
    assert.match(page, /<section id="pane" data-tab="tasks">/);
    assert.match(page, /<section id="edits" hidden>/);
    assert.ok(!page.includes('data-file="a.md"'), "the edits table is not drawn on another tab");
    const js = page.match(/<script nonce="N">([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(js));
    assert.match(js, /"sel":\d+/, "the host's view goes to the page");
    const edits = html(data, s.root, "N", [], { view: { tab: "edits" } });
    assert.ok(edits.includes('data-file="a.md"'));
  } finally {
    Module._load = load;
  }
});
