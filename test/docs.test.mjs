// Design documents (#72): the database (migration 4, sections, versions, sync), the MCP
// tools, the panel's Architecture/Product models and writes, the Markdown export and the
// docUpdate process check.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, digest } from "../mcp/server.mjs";

const req = createRequire(import.meta.url);
const { openDb, VERSION, MIGRATIONS } = req("../vscode/db.js");
const docs = req("../vscode/docsView.js");
const tv = req("../vscode/tasksView.js");
const { docMarkdown, exportDocs, HEADER } = req("../vscode/docs-export.js");
const { check } = req("../vscode/process.js");
const { DatabaseSync } = req("node:sqlite");

const agent = { kind: "agent", id: "claude-code:S1" };
const user = { kind: "user", id: "u" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-72-")));
const tmpDb = () => path.join(tmpDir(), "imprimatur.db");
function gitRepo() {
  const root = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** A database with a repo, a task and an ADR and a PDR. */
function seeded(root = "/a/proj", origin) {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf(root, origin ? { origin } : {});
  const task = db.upsertTask(repo.id, "#72", { title: "Docs" });
  const adr = db.addRecord(task.id, { kind: "adr", title: "SQLite is the source of truth" }, agent);
  const pdr = db.addRecord(task.id, { kind: "pdr", title: "Two tabs: Mimari and Ürün" }, agent);
  return { db, repo, task, adr, pdr };
}

// ---- database ----

test("migration 4: a schema 3 database gains the document tables", () => {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m);
  raw.exec("PRAGMA user_version = 3");
  raw.close();
  const db = openDb({ path: file });
  assert.equal(db.version, VERSION);
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  for (const t of ["documents", "doc_sections", "doc_section_records", "doc_versions"]) assert.ok(tables.includes(t), t);
  assert.throws(() => db.sqlite.exec("INSERT INTO documents (uid, repo_id, kind, title, updated_at) VALUES ('x', 1, 'roadmap', 't', 1)"), /CHECK/);
  db.close();
});

test("migration 5: a schema 4 database keeps its documents, sections, links and versions, and takes a glossary", () => {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m);
  raw.exec("PRAGMA user_version = 4");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(`INSERT INTO repos (id, uid, root, created_at) VALUES (1, 'r', '/a/p', 1);
    INSERT INTO tasks (id, uid, repo_id, key, created_at, updated_at) VALUES (1, 't', 1, '#1', 1, 1);
    INSERT INTO records (id, uid, task_id, kind, title, position, created_at, updated_at) VALUES (1, 'a', 1, 'adr', 'SQLite', 1, 1, 1);
    INSERT INTO documents (id, uid, repo_id, kind, title, updated_at) VALUES (1, 'd', 1, 'architecture', 'Mimari', 1);
    INSERT INTO doc_sections (id, uid, doc_id, key, title, body, position, updated_at) VALUES (1, 's', 1, 'storage', 'Storage', 'x', 1, 1);
    INSERT INTO doc_section_records (section_id, record_id) VALUES (1, 1);
    INSERT INTO doc_versions (section_id, at, actor_kind, after) VALUES (1, 1, 'agent', '{}');`);
  assert.throws(() => raw.exec("INSERT INTO documents (uid, repo_id, kind, title, updated_at) VALUES ('g', 1, 'glossary', 't', 1)"), /CHECK/);
  raw.close();
  const db = openDb({ path: file });
  assert.equal(db.version, VERSION);
  const s = db.docSection(1, "storage");
  assert.deepEqual([s.title, s.body, s.records, db.sectionVersions(1).length], ["Storage", "x", [1], 1]);
  assert.deepEqual(db.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  const g = db.docOf(1, "glossary");
  assert.equal(g.title, "Project Glossary");
  db.upsertSection(g.id, "pointer", { title: "Pointer", body: "Where work stopped." }, agent);
  assert.throws(() => db.sqlite.exec("DELETE FROM documents WHERE id = 1"), /FOREIGN KEY/, "the sections still point at their document");
  for (const i of ["doc_section_records_record", "doc_versions_section"]) {
    assert.ok(db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(i), i);
  }
  db.close();
});

test("glossary: terms read alphabetically (Turkish), unnumbered in the panel and the file, written by MCP and the user", () => {
  const root = gitRepo();
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf(root);
  const g = db.docOf(repo.id, "glossary");
  db.upsertSection(g.id, "zarf", { title: "Zarf", body: "Kayıtların kabı." }, agent);
  db.upsertSection(g.id, "ceza", { title: "Ceza" }, agent);
  db.upsertSection(g.id, "cizgi", { title: "Çizgi", body: "Bir satır." }, agent);
  db.upsertSection(g.id, "adr", { title: "ADR", body: "Mimari karar." }, agent);
  assert.deepEqual(db.docSections(g.id).map((s) => s.title), ["ADR", "Ceza", "Çizgi", "Zarf"]);
  const m = docs.docModel(db, root, "glossary");
  assert.deepEqual([m.label, m.title, m.current.map((s) => s.n)], ["Glossary", "Project Glossary", [null, null, null, null]]);
  const html = docs.docHtml(m);
  assert.match(html, /Terms · 4/);
  assert.match(html, /New term/);
  assert.doesNotMatch(html, /class="num"/);
  const text = docMarkdown(db, g.id);
  assert.match(text, /^## Terms\n\n- \[ADR\]\(#adr\)\n- \[Ceza\]\(#ceza\)/m);
  assert.match(text, /<a id="cizgi"><\/a>\n\n## Çizgi\n\nBir satır\./);
  exportDocs(db, root);
  assert.ok(fs.readFileSync(path.join(root, "docs", "GLOSSARY.md"), "utf8").startsWith(HEADER));
  // The user adds a term from the panel; MCP reads and writes them.
  docs.applyDocMessage(db, { type: "docNew", kind: "glossary", title: "Pointer (👉)", body: "Where work stopped." }, user, root);
  assert.ok(db.docSection(g.id, "pointer"));
  const call = (name, a) => callTool(db, name, { repo: root, ...a }, { client: "test" });
  assert.deepEqual(call("doc_get", { kind: "glossary" }).sections.map((s) => s.key), ["adr", "ceza", "cizgi", "pointer", "zarf"]);
  call("doc_section_upsert", { kind: "glossary", key: "kayit", title: "Kayıt", body: "Bir görevin satırı." });
  assert.equal(db.docSection(g.id, "kayit").body, "Bir görevin satırı.");
  assert.equal(db.docHealth(repo.id).glossary.sections, 6);
  db.close();
});

test("docOf creates on first use with the default titles; one per repo and kind", () => {
  const { db, repo } = seeded();
  assert.equal(db.docFind(repo.id, "architecture"), undefined, "reading does not create");
  const a = db.docOf(repo.id, "architecture");
  assert.equal(a.title, "Architecture Design Document");
  assert.equal(db.docOf(repo.id, "product").title, "Product Design Document");
  assert.equal(db.docOf(repo.id, "architecture").id, a.id);
  assert.throws(() => db.docOf(repo.id, "roadmap"), /architecture, product/);
});

test("upsertSection: create, change, no-op, records replace and add, versions with the actor", () => {
  const { db, repo, adr, pdr } = seeded();
  const doc = db.docOf(repo.id, "architecture");
  assert.throws(() => db.upsertSection(doc.id, "storage", { body: "x" }, agent), /needs a title/);
  assert.throws(() => db.upsertSection(doc.id, "Bad Key", { title: "x" }, agent), /slug/);
  const s = db.upsertSection(doc.id, "storage", { title: "Storage", body: "SQLite in WAL mode.", addRecords: [adr.id] }, agent);
  assert.deepEqual([s.key, s.title, s.status, s.position, s.records], ["storage", "Storage", "current", 1, [adr.id]]);
  const t = db.upsertSection(doc.id, "sync", { title: "Sync" }, agent);
  assert.equal(t.position, 2, "a new section goes last");
  db.upsertSection(doc.id, "storage", { body: "SQLite in WAL mode.", addRecords: [adr.id] }, user);
  assert.equal(db.sectionVersions(s.id).length, 1, "nothing changed: no version");
  db.upsertSection(doc.id, "storage", { body: "SQLite, WAL.", addRecords: [pdr.id] }, user);
  const [v2, v1] = db.sectionVersions(s.id);
  assert.deepEqual([v1.actor_kind, v1.actor, v1.before], ["agent", "claude-code:S1", null]);
  assert.equal(v1.after.title, "Storage");
  assert.deepEqual(v2.before, { body: "SQLite in WAL mode.", records: [adr.id] });
  assert.deepEqual(v2.after, { body: "SQLite, WAL.", records: [adr.id, pdr.id] });
  assert.deepEqual(db.upsertSection(doc.id, "storage", { records: [pdr.id] }, user).records, [pdr.id], "records replaces");
  assert.equal(db.docLastChange(doc.id).actor_kind, "user");
  assert.deepEqual(db.sectionsOfRecord(pdr.id).map((x) => [x.key, x.doc_kind]), [["storage", "architecture"]]);
  const list = db.docSections(doc.id);
  assert.deepEqual(list.map((x) => x.key), ["storage", "sync"]);
  assert.deepEqual(list[0].contributors.map((r) => [r.kind, r.task_key]), [["pdr", "#72"]]);
});

test("upsertSection: a record of another repo is refused", () => {
  const { db, repo } = seeded();
  const other = db.repoOf("/b/other");
  const rec = db.addRecord(db.upsertTask(other.id, "#1").id, { kind: "adr", title: "elsewhere" }, agent);
  const doc = db.docOf(repo.id, "architecture");
  assert.throws(() => db.upsertSection(doc.id, "x", { title: "X", addRecords: [rec.id] }, agent), /another repo/);
  assert.equal(db.docSection(doc.id, "x"), undefined, "nothing written");
});

// ---- MCP tools ----

test("MCP doc_get / doc_section_upsert: TOC, bodies, records of this repo only, strict args, digest", () => {
  const root = gitRepo();
  const db = openDb({ path: tmpDb() });
  const ctx = { client: "test" };
  const call = (name, a) => callTool(db, name, { repo: root, ...a }, ctx);
  const empty = call("doc_get", { kind: "architecture" });
  assert.equal(empty.document.title, "Architecture Design Document");
  assert.match(empty.hint, /doc_section_upsert/);
  assert.equal(db.docFind(db.repoByRoot(root).id, "architecture"), undefined, "a read creates nothing");
  const { record: adr } = call("record_add", { task: "#72", kind: "adr", title: "Docs in the DB" });
  assert.throws(() => call("doc_section_upsert", { kind: "architecture", key: "storage", body: "x" }), /give a title/);
  assert.throws(() => call("doc_section_upsert", { kind: "architecture", key: "Storage!", title: "x" }), /slug/);
  assert.throws(() => call("doc_section_upsert", { kind: "architecture", key: "s", title: "x", records: ["1"] }), /integer record ids/);
  assert.throws(() => call("doc_section_upsert", { kind: "roadmap", key: "s", title: "x" }), /architecture, product/);
  assert.throws(() => call("doc_section_upsert", { kind: "architecture", key: "s", title: "x", owner: "C" }), /unknown argument "owner"/);
  const other = gitRepo();
  const { record: far } = callTool(db, "record_add", { repo: other, task: "#1", kind: "adr", title: "far" }, ctx);
  assert.throws(() => call("doc_section_upsert", { kind: "architecture", key: "s", title: "x", records: [far.id] }), /another repo/);
  assert.throws(() => call("doc_section_upsert", { kind: "architecture", key: "s", title: "x", records: [99999] }), /no record 99999/);
  const made = call("doc_section_upsert", { kind: "architecture", key: "storage", title: "Storage", body: "SQLite, WAL.", records: [adr.id], _session: "S9" });
  assert.equal(made.created, true);
  assert.deepEqual(made.section.records, [adr.id]);
  assert.equal(db.sectionVersions(made.section.id)[0].actor, "test:S9");
  assert.match(digest("doc_section_upsert", made), /^Created architecture section storage — Storage \[current\]; records \d+/);
  const again = call("doc_section_upsert", { kind: "architecture", key: "storage", body: "SQLite in WAL mode." });
  assert.equal(again.created, false);
  assert.deepEqual(again.section.records, [adr.id], "records are added, never dropped here");
  const toc = call("doc_get", { kind: "architecture" });
  assert.equal(toc.sections[0].body, undefined, "TOC only");
  assert.match(digest("doc_get", toc, {}), /1\. storage — Storage \(updated \d{4}-\d\d-\d\d; records \d+\)/);
  assert.equal(call("doc_get", { kind: "architecture", section: "storage" }).sections[0].body, "SQLite in WAL mode.");
  assert.match(digest("doc_get", call("doc_get", { kind: "architecture", full: true }), {}), /\n {4}SQLite in WAL mode\./);
  assert.throws(() => call("doc_get", { kind: "architecture", section: "nope" }), /Sections: storage/);
});

// ---- panel: Mimari / Ürün ----

test("panel model and HTML: numbered TOC, Markdown without raw HTML, contributors, superseded last, empty state", () => {
  const root = "/a/proj";
  const { db, repo, adr } = seeded(root);
  const emptyHtml = docs.docHtml(docs.docModel(db, root, "architecture"));
  assert.match(emptyHtml, /This document is empty\. When the agent adds an ADR or a decision/);
  assert.match(emptyHtml, /New section/);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "**SQLite** <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://example.com)", addRecords: [adr.id] }, agent);
  db.upsertSection(doc.id, "old-sync", { title: "Old sync", body: "gone", status: "superseded" }, agent);
  db.upsertSection(doc.id, "sync", { title: "Sync" }, user);
  const m = docs.docModel(db, root, "architecture", { docFlash: "sync" });
  assert.deepEqual(m.current.map((s) => [s.n, s.key]), [[1, "storage"], [2, "sync"]]);
  assert.deepEqual(m.superseded.map((s) => s.key), ["old-sync"]);
  assert.equal(m.last.who, "You");
  assert.equal(m.current[1].flash, true);
  const html = docs.docHtml(m);
  assert.match(html, /<strong>SQLite<\/strong>/);
  assert.ok(!html.includes("<script>alert"), "raw HTML stays text");
  assert.ok(!/href="javascript:/i.test(html), "no javascript: link");
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<details class="contrib"><summary>Based on records · 1<\/summary><div class="rchips"><a href="#" class="rchip" data-act="showRecord" data-id="\d+"/);
  assert.match(html, /<span class="num">1<\/span><span>Storage<\/span>/);
  assert.ok(html.indexOf("<summary>Superseded sections · 1</summary>") > html.indexOf('id="sec-sync"'), "superseded sections at the end");
  assert.match(html, /class="dsec flash" id="sec-sync"/);
  assert.match(html, /Last updated · .* · You/);
  // Every pane block has a key (the page swaps only the changed ones).
  // Under the Analiz tab: its sub-pages over the document (TASK-ANALYSIS).
  assert.match(tv.paneHtml(db, root, { tab: "product" }), /^<nav class="hubnav"[\s\S]*?data-tab="product" aria-current="page"[\s\S]*?<\/nav><div class="doc" data-k="doc-product">/);
  assert.match(tv.paneHtml(db, root, { tab: "product" }), /a PDR or a decision/);
});

test("panel editing: the editor with draft keys, save and new section as the user, status; cleanView keeps edit", () => {
  const root = "/a/proj";
  const { db, repo } = seeded(root);
  const doc = db.docOf(repo.id, "product");
  const s = db.upsertSection(doc.id, "tabs", { title: "Tabs", body: "Two." }, agent);
  const html = docs.docHtml(docs.docModel(db, root, "product", { edit: `product:${s.id}` }));
  assert.match(html, new RegExp(`<textarea data-draft="doc-product-${s.id}"[^>]*>Two\\.</textarea>`));
  assert.match(html, new RegExp(`data-draft="doct-product-${s.id}" value="Tabs"`));
  assert.match(html, /data-act="docSave" data-kind="product"/);
  assert.ok(!docs.docHtml(docs.docModel(db, root, "architecture", { edit: `product:${s.id}` })).includes("<textarea"), "the edit is per kind");
  assert.deepEqual(tv.cleanView({ tab: "product", edit: "product:new" }), { tab: "product", edit: "product:new" });
  assert.deepEqual(tv.cleanView({ edit: "product:<x>" }), {});
  tv.applyMessage(db, { type: "docSave", kind: "product", id: s.id, title: "Tabs ", body: "Two tabs: Mimari, Ürün.\r\n" }, user, root);
  const saved = db.sectionById(s.id);
  assert.deepEqual([saved.title, saved.body], ["Tabs", "Two tabs: Mimari, Ürün.\n"]);
  assert.equal(db.sectionVersions(s.id)[0].actor_kind, "user");
  const n1 = tv.applyMessage(db, { type: "docNew", kind: "product", title: "Çalışma şekli", body: "x" }, user, root);
  const n2 = tv.applyMessage(db, { type: "docNew", kind: "product", title: "Çalışma Şekli!", body: "" }, user, root);
  assert.deepEqual([n1.key, n2.key, n2.body], ["calisma-sekli", "calisma-sekli-2", null]);
  assert.throws(() => tv.applyMessage(db, { type: "docNew", kind: "product", title: "  " }, user, root), /needs a title/);
  tv.applyMessage(db, { type: "docStatus", id: n2.id, status: "superseded" }, user, root);
  assert.equal(db.sectionById(n2.id).status, "superseded");
  assert.throws(() => tv.applyMessage(db, { type: "docStatus", id: n2.id, status: "gone" }, user, root), /bad section status/);
  // A new document in a repo the database did not know yet.
  const fresh = openDb({ path: tmpDb() });
  const made = tv.applyMessage(fresh, { type: "docNew", kind: "architecture", title: "First" }, user, "/c/new");
  assert.equal(fresh.sectionById(made.id).key, "first");
});

test("slugify folds Turkish letters and punctuation", () => {
  assert.equal(docs.slugify("Veri Modeli & Eşitleme (sync)"), "veri-modeli-esitleme-sync");
  assert.equal(docs.slugify("İçe aktarma: ÖĞÜŞÇ"), "ice-aktarma-ogusc");
  assert.equal(docs.slugify("!!!"), "bolum");
});

// ---- Markdown export ----

test("export: the golden file; written only when changed; superseded left out; no doc, no file", () => {
  const root = tmpDir();
  const { db, repo, task, adr } = seeded(root);
  assert.deepEqual(exportDocs(db, root), [], "no document yet");
  const dec = db.addRecord(task.id, { kind: "decision", title: "Debounce 2 s" }, agent);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "SQLite in WAL mode.\n\n### Why\n\n- one file per device", addRecords: [adr.id] }, agent);
  db.upsertSection(doc.id, "export", { title: "Export [docs]", body: "Generated after a change.", addRecords: [adr.id, dec.id] }, agent);
  db.upsertSection(doc.id, "old", { title: "Old", body: "replaced", status: "superseded" }, agent);
  db.upsertSection(doc.id, "empty", { title: "Empty" }, agent);
  const golden = fs.readFileSync(new URL("./fixtures/docs-export.golden.md", import.meta.url), "utf8");
  assert.equal(docMarkdown(db, doc.id), golden);
  assert.ok(golden.startsWith(HEADER));
  const first = exportDocs(db, root);
  assert.deepEqual(first.map((r) => [r.kind, path.relative(root, r.file), r.written]), [["architecture", "docs/ARCHITECTURE.md", true]]);
  assert.equal(fs.readFileSync(path.join(root, "docs", "ARCHITECTURE.md"), "utf8"), golden);
  assert.equal(exportDocs(db, root)[0].written, false, "unchanged: not written again");
  assert.ok(!fs.existsSync(path.join(root, "docs", "PRODUCT.md")));
  db.upsertSection(doc.id, "storage", { body: "Changed." }, user);
  assert.equal(exportDocs(db, root)[0].written, true);
});

// ---- docUpdate process check ----

test("docUpdate: an ADR added and not linked is told to the agent at its next tool call; linked, nothing", () => {
  const root = gitRepo();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify({ process: { status: false, whereWeLeftOff: false, branchFinish: false, mainGuard: false, designFirst: false } }));
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#72");
  const records = { dbOf: () => db, repoId: () => repo.id, recordsOf: () => [] };
  const adr = db.addRecord(task.id, { kind: "adr", title: "Docs live in the DB" }, agent);
  const run = (event, extra = {}, session = "S1") => check(event, { cwd: root, session_id: session, ...extra }, { records });
  // The id from the tool's answer, the kind from the database.
  run("PostToolUse", { tool_name: "mcp__plugin_imprimatur_imprimatur__record_add", tool_input: { task: "#72", kind: "adr", title: adr.title }, tool_response: [{ type: "text", text: `Added [${adr.id}] adr/open - Docs live in the DB` }] });
  assert.deepEqual(run("Stop"), {}, "Stop says nothing to the user");
  const told = run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(told.context, [`Imprimatur (docUpdate): ADR #${adr.id} eklendi ama mimari dokümanı güncellenmedi: doc_section_upsert {kind: "architecture", key, title, body, records: [${adr.id}]} ile ilgili bölümü yaz ve kaydı bağla.`]);
  assert.deepEqual(run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), {}, "told once");
  // A PDR changed (title) without a link: next session start hears it; a status change alone is no design change.
  const pdr = db.addRecord(task.id, { kind: "pdr", title: "Two tabs" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_update", tool_input: { id: pdr.id, status: "done" } });
  assert.deepEqual(run("Stop"), {});
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_update", tool_input: { id: pdr.id, title: "Two tabs, Mimari and Ürün" } });
  run("Stop");
  assert.match(run("SessionStart", {}, "S2").context.join("\n"), new RegExp(`PDR #${pdr.id} güncellendi ama ürün dokümanı güncellenmedi`));
  // Linked to a section before Stop: nothing.
  const adr2 = db.addRecord(task.id, { kind: "adr", title: "Second" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_add", tool_input: { task: "#72", kind: "adr", title: "Second" }, tool_response: { content: [] } });
  db.upsertSection(db.docOf(repo.id, "architecture").id, "storage", { title: "Storage", addRecords: [adr2.id] }, agent);
  run("Stop");
  assert.deepEqual(run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), {});
  // block: the Stop is stopped (the agent goes on and links it).
  fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify({ process: { status: false, whereWeLeftOff: false, branchFinish: false, docUpdate: "block" } }));
  const adr3 = db.addRecord(task.id, { kind: "adr", title: "Third" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_add", tool_input: { task: "#72", kind: "adr", title: "Third" }, tool_response: JSON.stringify({ structuredContent: { record: { id: adr3.id, kind: "adr" } } }) });
  assert.match(run("Stop").block, new RegExp(`ADR #${adr3.id} eklendi`));
  // A note is not a design record.
  const note = db.addRecord(task.id, { kind: "note", title: "n" }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_add", tool_input: { task: "#72", kind: "note", title: "n" }, tool_response: `Added [${note.id}] note/open` });
  assert.deepEqual(run("Stop"), {});
});
