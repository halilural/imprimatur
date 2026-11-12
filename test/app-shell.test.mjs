// #195: the new panel's shell: five areas, the reading layout for any document, theme colors only.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { appModel, AREAS } = req("../vscode/app/model.js");
const { appHtml, readingHtml, CSS } = req("../vscode/app/html.js");
const agent = { kind: "agent", id: "s" };
const render = (md) => `<p>${md.replace(/</g, "&lt;")}</p>`;
const o = { nonce: "n0", cspSource: "vscode-resource:", render };

test("app shell: five areas and More; Home lists the tasks in progress; a document reads in the layout", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-195-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const t = db.upsertTask(repo.id, "#1", { title: "Search", status: "active" });
  db.addRecord(t.id, { kind: "todo", title: "Rank the results", pointer: true }, agent);
  assert.deepEqual(AREAS.map((a) => a.id), ["home", "tasks", "docs", "edits", "setup"]);
  const home = appHtml(appModel(db, repo, root, {}), o);
  assert.doesNotMatch(home, /<nav|class="top"|data-doc=/, "navigation is the side bar's Imprimatur view, not the panel's");
  assert.match(home, /data-task="#1"[\s\S]*👉 Rank the results/);
  // A document: its sections left, the page with the summary first, "On this page" right.
  const g = db.docOf(repo.id, "glossary");
  db.upsertSection(g.id, "wal", { title: "WAL", body: "Write-ahead log.\n\nOne file.\n\nMore detail here." }, agent);
  const m = appModel(db, repo, root, { area: "docs", doc: "glossary" });
  assert.equal(m.reading.sections[0].title, "WAL");
  const html = appHtml(m, o);
  assert.match(html, /class="onpage"><div class="label">On this page<\/div><a href="#wal">WAL<\/a>/);
  assert.doesNotMatch(html, /class="toc"|<summary>More<\/summary>/, "one table of contents, nothing folded");
  assert.match(html, /<section id="wal"><h2>WAL<\/h2>(<details class="edit">[\s\S]*?<\/details>)?<p>Write-ahead log\.[\s\S]*More detail here\./);
  assert.match(html, /class="onpage"/);
  assert.match(readingHtml({ title: "Empty", sections: [] }, render), /Nothing written here yet/);
  // Theme colors only: every color is a VS Code variable.
  assert.doesNotMatch(CSS.replace(/var\(--vscode-[^)]*\)/g, ""), /#[0-9a-f]{3,6}\b|rgb\(/i);
  // The CSP lets in only the nonce's script.
  assert.match(html, /script-src 'nonce-n0'/);
});

test("Home board (#196): needs you (an open ask the user owns), active, done this week; a task's spec is tagged", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-196-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const a = db.upsertTask(repo.id, "#1", { title: "Search", status: "active" });
  db.addRecord(a.id, { kind: "question", owner: "K", title: "Which index?" }, agent);
  db.upsertTask(repo.id, "#2", { title: "Wiki", status: "active" });
  db.upsertTask(repo.id, "#3", { title: "Model", status: "done" });
  db.upsertSection(db.taskDocOf(repo.id, "#2", "spec").id, "p", { title: "P", chapter: "problem" }, agent);
  const m = appModel(db, repo, root, {});
  assert.deepEqual([m.board.needs.map((t) => t.key), m.board.active.map((t) => t.key), m.board.done.map((t) => t.key)], [["#1"], ["#2"], ["#3"]]);
  const html = appHtml(m, o);
  assert.match(html, /Needs you · 1[\s\S]*Which index\?/);
  assert.match(html, /data-task="#2"><span class="key">#2<\/span><span><b>Wiki<\/b> <span class="tag">spec<\/span>/);
});

test("task page (#197): the gates in order with the next one to approve; spec, tickets, records, activity", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-197-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const t = db.upsertTask(repo.id, "#5", { title: "Search", status: "active", summary: "Spec written" });
  db.upsertSection(db.taskDocOf(repo.id, "#5", "spec").id, "problem", { title: "Finding a record", chapter: "problem", body: "Search misses words." }, agent);
  db.upsertTask(repo.id, "#6", { title: "Which index?", epicId: t.id, ticketType: "research", status: "active" });
  db.addRecord(t.id, { kind: "decision", status: "done", title: "Approved: Problem and user stories", links: { gate: "stories" } }, agent);
  // The agent passes a gate with its own decision record; the panel has no Approve button.
  let m = appModel(db, repo, root, { area: "tasks", task: "#5" });
  assert.deepEqual(m.page.gates.map((g) => [g.id, g.done, g.next]), [["stories", true, false], ["design", false, true], ["analyze", false, false], ["tickets", false, false]]);
  let html = appHtml(m, o);
  assert.match(html, /<h2>Problem Statement · Finding a record<\/h2>/);
  assert.match(html, /class="gate done"><span>✓<\/span> Problem and user stories/);
  assert.doesNotMatch(html, /Approve|Confirm|data-gate/);
  m = appModel(db, repo, root, { area: "tasks", task: "#5", tab: "tickets" });
  assert.match(appHtml(m, o), /Which index\?<\/b><br><span class="ptr">claimed · research/);
  assert.match(appHtml(appModel(db, repo, root, { area: "tasks", task: "#5", tab: "activity" }), o), /create · decision · Approved/);
  assert.match(appHtml(appModel(db, repo, root, { area: "tasks" }), o), /Active · 2/);
});

test("docs editing (#198): database documents get Edit and New section; ADRs and the wiki do not", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-198-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  db.upsertSection(db.docOf(repo.id, "project").id, "why", { title: "Why", chapter: "mission", body: "Agents remember." }, agent);
  const proj = appHtml(appModel(db, repo, root, { area: "docs", doc: "project" }), o);
  assert.match(proj, /<form class="editor" data-save data-kind="project" data-dscope="" data-key="why">/);
  assert.match(proj, /data-new="1">[\s\S]*<select name="chapter"><option value="mission">Mission<\/option>/);
  assert.doesNotMatch(appHtml(appModel(db, repo, root, { area: "docs", doc: "adrs" }), o), /<form class="editor"/);
  assert.doesNotMatch(appHtml(appModel(db, repo, root, { area: "docs", doc: "wiki" }), o), /<form class="editor"/);
  assert.match(appHtml(appModel(db, repo, root, { area: "docs", doc: "glossary" }), o), /New section/);
});

test("Edits and Setup (#199): the review queue per file, newest first; setup links the checklist and recommendations", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-199-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const rows = [
    { file: "a.md", n: 1, t: "2026-11-10T10:00:00Z", summary: "old" }, { file: "a.md", n: 2, t: "2026-11-10T12:00:00Z", summary: "new" },
    { file: "b.md", t: "2026-11-10T11:00:00Z", summary: "b", accepted: true }, { file: "#1 · note", t: "2026-11-10T13:00:00Z" },
  ];
  const html = appHtml(appModel(db, repo, root, { area: "edits", rows }), o);
  assert.match(html, /2 agent edits in 1 file wait for your review/);
  assert.match(html, /<span><b>a\.md<\/b>[\s\S]*2026-11-10 12:00 · new[\s\S]*class="count" title="Edits waiting">2</);
  // Each edit under review, newest first, with its own Accept, Diff and Go (#202).
  assert.match(html, /<b>#2<\/b>[\s\S]*data-edit="accept" data-file="a\.md" data-n="2"[\s\S]*data-edit="diff"[\s\S]*data-edit="go"[\s\S]*<b>#1<\/b>/);
  assert.doesNotMatch(html, /data-file="b\.md"/);
  assert.match(appHtml(appModel(db, repo, root, { area: "edits", rows: [] }), o), /Every agent edit is reviewed/);
  assert.match(appHtml(appModel(db, repo, root, { area: "setup" }), o), /data-cmd="imprimatur\.setup\.focus"[\s\S]*data-task="RECS"/);
});

test("More (#202): Exercises, Meetings and Social open in this panel; a step's box ticks it through the exercise messages", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-202-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const nav = appModel(db, repo, root, {});
  assert.deepEqual(nav.more.map((x) => x.id), ["exercises", "meetings"], "social is off by default");
  assert.doesNotMatch(appHtml(nav, o), /imprimatur\.open(Exercises|Meetings|Social)/, "no hop to the old panel");
  const e = db.saveExercise({ topic: "Bedrock", goal: "Call it", steps: [{ title: "Read the docs", kind: "learn" }, { title: "Call it" }] });
  const ex = appModel(db, repo, root, { area: "exercises" });
  assert.equal(ex.area, "exercises");
  const html = appHtml(ex, o);
  assert.match(html, new RegExp(`data-ex="exStep" data-id="${e.steps[0].id}" data-status="done"`));
  assert.match(html, /Bedrock[\s\S]*0 \/ 2 steps/);
  const { applyExerciseMessage } = req("../vscode/exercises.js");
  applyExerciseMessage(db, { type: "exStep", id: e.steps[0].id, status: "done" });
  assert.match(appHtml(appModel(db, repo, root, { area: "exercises" }), o), /1 \/ 2 steps/);
  const t = db.upsertTask(repo.id, "#5", { title: "Payments" });
  const m = db.addRecord(t.id, { kind: "meeting", title: "Payments weekly", body: "## Özet\nKafka it is." }, agent);
  db.addRecord(t.id, { kind: "decision", title: "Use Kafka", parent_id: m.id }, agent);
  const mh = appHtml(appModel(db, repo, root, { area: "meetings" }), o);
  assert.match(mh, /Payments weekly[\s\S]*Kafka it is\.[\s\S]*1 decisions[\s\S]*Use Kafka[\s\S]*data-task="#5"/);
  db.upsertSection(db.docOf(repo.id, "social").id, "launch", { title: "Launch on Reddit", body: "Draft." }, agent);
  const sm = appModel(db, repo, root, { area: "social" });
  assert.equal(sm.reading.edit.kind, "social");
  assert.match(appHtml(sm, o), /<section id="launch"><h2>Launch on Reddit/);
});

test("task page: a bucket of records (RECS) has no spec tab and no gates; it opens on its records", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-bucket-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const t = db.upsertTask(repo.id, "RECS", { title: "Recommendations", status: "active" });
  db.addRecord(t.id, { kind: "note", title: "One" }, agent);
  const m = appModel(db, repo, root, { area: "tasks", task: "RECS" });
  assert.deepEqual([m.page.tab, m.page.tabs, m.page.gates], ["records", ["tickets", "records", "activity"], []]);
  assert.doesNotMatch(appHtml(m, o), /class="gates"|data-tab="spec"/);
  db.upsertTask(repo.id, "PROJ-12", { title: "Jira", status: "open" });
  assert.equal(appModel(db, repo, root, { area: "tasks", task: "PROJ-12" }).page.gates.length, 4);
  // Not work: left out of the task lists and Home's board; still opens by its key.
  const lists = appModel(db, repo, root, { area: "tasks" }).lists;
  assert.deepEqual(lists.map((l) => l.tasks.map((t) => t.key)), [[], ["PROJ-12"], []]);
  assert.ok(!appModel(db, repo, root, { area: "home" }).board.active.some((t) => t.key === "RECS"));
});
