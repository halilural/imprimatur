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
const docs = req("../vscode/markdown.js");
const { docMarkdown, exportDocs, HEADER, generatedText } = req("../vscode/docs-export.js");
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
  const pdr = db.addRecord(task.id, { kind: "pdr", title: "Two tabs: Architecture and Product" }, agent);
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
    INSERT INTO documents (id, uid, repo_id, kind, title, updated_at) VALUES (1, 'd', 1, 'architecture', 'Architecture', 1);
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

test("glossary: terms read alphabetically (Turkish), in the file, written by MCP and the user", () => {
  const root = gitRepo();
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf(root);
  const g = db.docOf(repo.id, "glossary");
  db.upsertSection(g.id, "envelope", { title: "Envelope", body: "The container of records." }, agent);
  db.upsertSection(g.id, "penalty", { title: "Penalty" }, agent);
  // Turkish input: the glossary sorts by Turkish collation (Ç right after C)
  db.upsertSection(g.id, "cizgi", { title: "Çizgi", body: "One line." }, agent);
  db.upsertSection(g.id, "adr", { title: "ADR", body: "Architecture decision." }, agent);
  assert.deepEqual(db.docSections(g.id).map((s) => s.title), ["ADR", "Çizgi", "Envelope", "Penalty"]);
  const text = docMarkdown(db, g.id);
  // #191: Pocock's GLOSSARY-FORMAT, alphabetical, at the repo root.
  assert.match(text, /^## Language\n\n<a id="adr"><\/a>\n\n\*\*ADR\*\*:/m);
  assert.match(text, /<a id="cizgi"><\/a>\n\n\*\*Çizgi\*\*:\n\nOne line\./);
  assert.deepEqual(req("../vscode/docs-sync.js").parseManaged(text).map((s) => s.key).slice(0, 2), ["adr", "cizgi"], "the terms read back");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "GLOSSARY.md"), "---\ntype: reference\n---\n\n<!-- Generated by Imprimatur from its database; old -->\n");
  exportDocs(db, root);
  assert.ok(generatedText(fs.readFileSync(path.join(root, "GLOSSARY.md"), "utf8")));
  assert.ok(!fs.existsSync(path.join(root, "docs", "GLOSSARY.md")), "the old generated copy under docs/ goes");
  // The user adds a term; MCP reads and writes them.
  db.upsertSection(g.id, "pointer", { title: "Pointer (👉)", body: "Where work stopped." }, user);
  assert.ok(db.docSection(g.id, "pointer"));
  const call = (name, a) => callTool(db, name, { repo: root, ...a }, { client: "test" });
  assert.deepEqual(call("doc_get", { kind: "glossary" }).sections.map((s) => s.key), ["adr", "cizgi", "envelope", "penalty", "pointer"]);
  call("doc_section_upsert", { kind: "glossary", key: "record", title: "Record", body: "A task's row." });
  assert.equal(db.docSection(g.id, "record").body, "A task's row.");
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

// ---- panel: Architecture / Product ----

test("slugify folds Turkish letters and punctuation", () => {
  assert.equal(docs.slugify("Data Model & Syncing (sync)"), "data-model-syncing-sync");
  // Turkish input: the slug folds the Turkish letters (İ ç ö ğ ü ş)
  assert.equal(docs.slugify("İçe aktarma: ÖĞÜŞÇ"), "ice-aktarma-ogusc");
  assert.equal(docs.slugify("!!!"), "section");
});

// ---- Markdown export ----

test("export: the golden file; written only when changed; superseded left out; no doc, no file", () => {
  const root = tmpDir();
  const { db, repo, task, adr } = seeded(root);
  assert.deepEqual(exportDocs(db, root), [], "no document yet");
  const dec = db.addRecord(task.id, { kind: "decision", title: "Debounce 2 s" }, agent);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "SQLite in WAL mode.\n\n#### Why\n\n- one file per device", addRecords: [adr.id], chapter: "building-blocks" }, agent);
  db.upsertSection(doc.id, "export", { title: "Export [docs]", body: "Generated after a change.", addRecords: [adr.id, dec.id], chapter: "goals" }, agent);
  db.upsertSection(doc.id, "old", { title: "Old", body: "replaced", status: "superseded" }, agent);
  db.upsertSection(doc.id, "empty", { title: "Empty" }, agent);
  // UPDATE_GOLDEN=1 writes the fixture from the current output; read the diff before committing it.
  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(new URL("./fixtures/docs-export.golden.md", import.meta.url), docMarkdown(db, doc.id));
  const golden = fs.readFileSync(new URL("./fixtures/docs-export.golden.md", import.meta.url), "utf8");
  assert.equal(docMarkdown(db, doc.id), golden);
  assert.ok(golden.startsWith(`---\ntype: explanation\n---\n\n${HEADER}`), "front matter first (#129), then the header");
  // #129: read back, the chapters and their "not written yet" lines belong to no section.
  assert.deepEqual(req("../vscode/docs-sync.js").parseManaged(golden).map((s) => [s.key, s.title, s.body]), [
    ["export", "Export [docs]", "Generated after a change."],
    ["storage", "Storage", "SQLite in WAL mode.\n\n#### Why\n\n- one file per device"],
    ["empty", "Empty", ""],
  ]);
  assert.throws(() => db.upsertSection(doc.id, "x", { title: "X", chapter: "nope" }, agent), /not one of the architecture/);
  assert.throws(() => db.upsertSection(doc.id, "chapter-goals", { title: "X" }, agent), /must not start with "chapter-"/);
  const first = exportDocs(db, root);
  assert.deepEqual(first.map((r) => [r.kind, path.relative(root, r.file), r.written]), [["architecture", "docs/ARCHITECTURE.md", true]]);
  assert.equal(fs.readFileSync(path.join(root, "docs", "ARCHITECTURE.md"), "utf8"), golden);
  assert.equal(exportDocs(db, root)[0].written, false, "unchanged: not written again");
  assert.ok(!fs.existsSync(path.join(root, "docs", "PRODUCT.md")));
  db.upsertSection(doc.id, "storage", { body: "Changed." }, user);
  assert.equal(exportDocs(db, root)[0].written, true);
});

// ---- docUpdate process check ----

test("docUpdate (#186): an ADR stands alone; one changed after the section it feeds is told at the next tool call", () => {
  const root = gitRepo();
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify({ process: { status: false, whereWeLeftOff: false, branchFinish: false, mainGuard: false, designFirst: false } }));
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#72");
  const records = { dbOf: () => db, repoId: () => repo.id, recordsOf: () => [] };
  const adr = db.addRecord(task.id, { kind: "adr", title: "Docs live in the DB" }, agent);
  const run = (event, extra = {}, session = "S1") => check(event, { cwd: root, session_id: session, ...extra }, { records });
  const added = (r) => run("PostToolUse", { tool_name: "mcp__plugin_imprimatur_imprimatur__record_add", tool_input: { task: "#72", kind: r.kind, title: r.title }, tool_response: [{ type: "text", text: `Added [${r.id}] ${r.kind}/open - ${r.title}` }] });
  // Not linked anywhere: Pocock's ADRs stand alone, nothing is said.
  added(adr);
  assert.deepEqual(run("Stop"), {});
  assert.deepEqual(run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), {});
  // Linked to a capability's section, then changed after it: told once.
  const cap = db.taskDocOf(repo.id, "storage", "capability");
  db.upsertSection(cap.id, "where", { title: "Where it lives", addRecords: [adr.id] }, agent);
  db.sqlite.prepare("UPDATE doc_sections SET updated_at = 1 WHERE doc_id = ?").run(cap.id);
  db.updateRecord(adr.id, { body: "And the files follow." }, agent);
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_update", tool_input: { id: adr.id, body: "And the files follow." } });
  run("Stop");
  const told = run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.match(told.context?.[0] ?? "", new RegExp(`ADR #${adr.id} updated, but the section it is linked to \\(capability/where\\) has not changed since`));
  assert.deepEqual(run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }), {}, "told once");
  // A status change alone is no design change; a note is not a design record.
  run("PostToolUse", { tool_name: "mcp__imprimatur__record_update", tool_input: { id: adr.id, status: "done" } });
  const note = db.addRecord(task.id, { kind: "note", title: "n" }, agent);
  added(note);
  assert.deepEqual(run("Stop"), {});
});

test("MCP (#184): a spec section with a delta, a map hint, a capability needs a name, a ticket's type and blockers", async () => {
  const root = gitRepo();
  const db = openDb({ path: tmpDb() });
  db.repoOf(root);
  const call = (name, a) => callTool(db, name, { repo: root, ...a }, { client: "test" });
  const sp = await call("doc_section_upsert", { kind: "spec", task: "#40", key: "problem", title: "Finding a record", chapter: "problem", body: "Search misses words." });
  assert.equal(sp.document.title, "Spec · #40");
  const d = await call("doc_section_upsert", { kind: "spec", task: "#40", key: "search--ranking", title: "Ranked", chapter: "implementation", delta: "added" });
  assert.equal(d.section.delta, "added");
  assert.equal((await call("doc_get", { kind: "spec", task: "#40" })).sections.length, 2);
  assert.match((await call("doc_get", { kind: "map", task: "#41" })).hint, /no map for #41 yet/);
  await assert.rejects(async () => call("doc_get", { kind: "capability" }), /capability's name/);
  const t = await call("task_upsert", { key: "#42", title: "Which index?", epic: "#40", ticket_type: "research", blocked_by: ["#43"] });
  assert.deepEqual([t.task.ticket_type, t.task.blocked_by], ["research", '["#43"]']);
});
