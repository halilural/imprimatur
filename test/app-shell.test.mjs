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
  assert.match(home, /data-go="docs"/);
  assert.match(home, /More<\/div>.*Exercises.*Meetings.*Social/s);
  assert.match(home, /data-task="#1"[\s\S]*👉 Rank the results/);
  // A document: its sections left, the page with the summary first, "On this page" right.
  const g = db.docOf(repo.id, "glossary");
  db.upsertSection(g.id, "wal", { title: "WAL", body: "Write-ahead log.\n\nOne file.\n\nMore detail here." }, agent);
  const m = appModel(db, repo, root, { area: "docs", doc: "glossary" });
  assert.equal(m.reading.sections[0].title, "WAL");
  const html = appHtml(m, o);
  assert.match(html, /class="toc"><div class="label">Sections<\/div><a href="#wal">WAL<\/a>/);
  assert.match(html, /<section id="wal"><h2>WAL<\/h2><div class="lead"><p>Write-ahead log\.[\s\S]*<details><summary>More<\/summary><p>More detail here\./);
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
  let m = appModel(db, repo, root, { area: "tasks", task: "#5" });
  assert.deepEqual(m.page.gates.map((g) => [g.id, g.done, g.next]), [["stories", true, false], ["design", false, true], ["analyze", false, false], ["tickets", false, false]]);
  let html = appHtml(m, o);
  assert.match(html, /<h2>Problem Statement · Finding a record<\/h2>/);
  assert.match(html, /data-gate="design" data-key="#5">Approve/);
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
