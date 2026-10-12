// Design documents ↔ their Markdown files (#73): whenever Imprimatur comes to a repo
// (no files yet, hand-written files, files gone after the #59 import), one sync brings
// the database and the files to the same text and keeps them there.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, digest } from "../mcp/server.mjs";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { syncDocs, describe, parseManaged, parseHand, sectionHash, conflictsOf } = req("../vscode/docs-sync.js");
const { docMarkdown, HEADER } = req("../vscode/docs-export.js");
const { importRepo, sources } = req("../vscode/import.js");
const { check } = req("../vscode/process.js");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-73-")));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
/** A git repo whose documents live in docs/design, and a database with it. */
function repo({ dir = "docs/design", process: proc } = {}) {
  const root = tmpDir();
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  put(root, ".claude/imprimatur.json", JSON.stringify({ docs: { dir }, ...(proc && { process: proc }) }));
  const db = openDb({ path: path.join(tmpDir(), "imprimatur.db") });
  return { root, db };
}
const sectionsOf = (db, root, kind) => {
  const d = db.docFind(db.repoByRoot(root).id, kind);
  return d ? db.docSections(d.id).filter((s) => s.status === "current") : [];
};

const ARCH = `# Sistem tasarımı

Bileşenler ve bağları.

<!-- toc -->

İçindekiler:

- [Profil](#profil)
- [Ajan](#ajan)

<!-- tocstop -->

## Profil

\`user_profile\` tablosu.

- ARCH: \`user_profile\` (D1) kişi başına
- ARCH: \`/me/profile\` uçları

## Ajan

\`\`\`mermaid
flowchart TB
  W --> J
\`\`\`

### Ayrıntı

- ARCH: Workflow \`apply-submit\`
`;

const PRODUCT = `# Ürün

## Profil

### Kişiye ait veri

- STORY: kullanıcı olarak verim profilimde
- FLOW: Panel → Profil → kaydet
`;

test("parse: a hand-written file → sections (overview, ## headings, ### kept, toc dropped); the managed form round-trips", () => {
  const secs = parseHand(ARCH);
  assert.deepEqual(secs.map((s) => [s.key, s.title]), [["overview", "Genel bakış"], ["profil", "Profil"], ["ajan", "Ajan"]]);
  assert.equal(secs[0].body, "Bileşenler ve bağları.");
  assert.match(secs[2].body, /^```mermaid[\s\S]*### Ayrıntı\n\n- ARCH: Workflow/);
  // The same title twice: unique keys; "## 2. X" loses its number.
  assert.deepEqual(parseHand("## 2. A\n\nx\n\n## A\n\ny").map((s) => [s.key, s.title]), [["a", "A"], ["a-2", "A"]]);
  // A "##" inside a code block is not a heading.
  assert.equal(parseHand("## A\n\n```\n## not\n```").length, 1);
  const db = openDb({ path: path.join(tmpDir(), "x.db") });
  const r = db.repoOf("/x/r");
  const doc = db.docOf(r.id, "architecture");
  for (const s of secs) db.upsertSection(doc.id, s.key, { title: s.title, body: s.body }, agent);
  const back = parseManaged(docMarkdown(db, doc.id));
  assert.deepEqual(back.map((s) => [s.key, sectionHash(s)]), secs.map((s) => [s.key, sectionHash(s)]));
});

test("start: no file, sections in the database → the file is written in docs.dir; then in sync", () => {
  const { root, db } = repo();
  const r = db.repoOf(root);
  db.upsertSection(db.docOf(r.id, "product").id, "flow", { title: "Akış", body: "A → B" }, agent);
  const first = syncDocs(db, root);
  assert.deepEqual(first.map((x) => [x.kind, x.written]), [["architecture", false], ["product", true]]);
  assert.ok(read(root, "docs/design/PRODUCT.md").startsWith(HEADER));
  assert.ok(!fs.existsSync(path.join(root, "docs/design/ARCHITECTURE.md")), "an empty document writes no file");
  assert.deepEqual(describe(syncDocs(db, root), root), ["docs/design/ARCHITECTURE.md: in sync", "docs/design/PRODUCT.md: in sync"]);
});

test("middle: hand-written files are adopted with their imported records linked; the file is rewritten in Imprimatur's form", () => {
  const { root, db } = repo();
  put(root, "docs/design/ARCHITECTURE.md", ARCH);
  put(root, "docs/design/PRODUCT.md", PRODUCT);
  put(root, "docs/design/README.md", "# Kurallar\n\n## Biçim\n\nSatır başına bir madde.\n");
  importRepo(db, root);
  const reports = syncDocs(db, root);
  assert.deepEqual(reports.map((x) => [x.kind, x.adopted, x.imported, x.written]), [
    ["architecture", "docs/design/ARCHITECTURE.md", ["overview", "profil", "ajan"], true],
    ["product", "docs/design/PRODUCT.md", ["profil"], true],
  ]);
  const arch = sectionsOf(db, root, "architecture");
  const title = (id) => db.record(id).title;
  assert.deepEqual(arch.find((s) => s.key === "profil").records.map(title), ["Profil", "`user_profile` (D1) kişi başına", "`/me/profile` uçları"]);
  assert.deepEqual(arch.find((s) => s.key === "ajan").records.map(title), ["Ajan", "Workflow `apply-submit`"], "a ### under it is the same section");
  const prod = sectionsOf(db, root, "product");
  assert.deepEqual(prod[0].records.map((id) => db.record(id).kind), ["pdr"], "docs/design/PRODUCT.md is product, not ADRs");
  assert.ok(read(root, "docs/design/ARCHITECTURE.md").startsWith(HEADER));
  // No ADR from the README.
  const repoId = db.repoByRoot(root).id;
  assert.equal(db.recordsFromSource(repoId, "docs/design/README.md").length, 0);
  assert.deepEqual(syncDocs(db, root).map((x) => [x.written, x.imported.length]), [[false, 0], [false, 0]], "second sync: in sync");
  // The generated file is no source of records for the importer any more.
  assert.ok(sources(root).filter((s) => s.rel.endsWith("ARCHITECTURE.md")).every((s) => s.type === "generated"));
  assert.equal(importRepo(db, root).dropped, 0, "a generated file does not drop the records it came from");
});

test("ongoing: file edit → database; database edit → file; both → conflict, neither written; take settles; deleted → superseded", () => {
  const { root, db } = repo();
  put(root, "docs/design/ARCHITECTURE.md", ARCH);
  syncDocs(db, root);
  const file = "docs/design/ARCHITECTURE.md";
  const doc = db.docFind(db.repoByRoot(root).id, "architecture");
  put(root, file, read(root, file).replace("Bileşenler ve bağları.", "Bileşenler, bağları."));
  assert.deepEqual(syncDocs(db, root)[0].imported, ["overview"]);
  assert.equal(db.docSection(doc.id, "overview").body, "Bileşenler, bağları.");
  assert.equal(db.sectionVersions(db.docSection(doc.id, "overview").id)[0].actor, "file");
  db.upsertSection(doc.id, "profil", { body: "DB'den." }, agent);
  assert.equal(syncDocs(db, root)[0].written, true);
  assert.match(read(root, file), /DB'den\./);
  // Both sides.
  put(root, file, read(root, file).replace("DB'den.", "Dosyadan."));
  db.upsertSection(doc.id, "profil", { body: "Yine DB'den." }, agent);
  const c = syncDocs(db, root)[0];
  assert.deepEqual([c.conflicts, c.written], [["profil"], false]);
  assert.match(read(root, file), /Dosyadan\./, "the file keeps its edit");
  assert.deepEqual(conflictsOf(db, db.repoByRoot(root).id), { architecture: ["profil"] });
  assert.deepEqual(syncDocs(db, root, { take: "db" })[0].conflicts, []);
  assert.match(read(root, file), /Yine DB'den\./);
  assert.deepEqual(conflictsOf(db, db.repoByRoot(root).id), {});
  // A section deleted from the file, unchanged in the database: superseded.
  const text = read(root, file);
  put(root, file, text.slice(0, text.indexOf('<a id="ajan">')));
  assert.deepEqual(syncDocs(db, root)[0].superseded, ["ajan"]);
  assert.equal(db.docSection(doc.id, "ajan").status, "superseded");
});

test("end: files gone after the import come back from a git revision; misfiled ADRs move to PDR", () => {
  const { root, db } = repo();
  put(root, "docs/design/ARCHITECTURE.md", ARCH);
  put(root, "docs/design/PRODUCT.md", PRODUCT);
  put(root, "docs/design/README.md", "# Kurallar\n\n## Biçim\n\nx\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "docs");
  // The old importer: every docs/design file as ADRs (simulated: README and PRODUCT under "ADR").
  const repoId = db.repoOf(root).id;
  const adrTask = db.upsertTask(repoId, "ADR", {});
  const old = db.addRecord(adrTask.id, { kind: "adr", title: "Kişiye ait veri", links: { source: "docs/design/README.md" }, uid: "md:readme1" }, agent);
  importRepo(db, root);
  const pdrsBefore = db.recordsFromSource(repoId, "docs/design/PRODUCT.md");
  // Wrongly filed as the old importer did: move them back under ADR to see them moved again.
  for (const r of pdrsBefore) db.sqlite.prepare("UPDATE records SET task_id = ?, kind = 'adr' WHERE id = ?").run(adrTask.id, r.id);
  db.sqlite.prepare("UPDATE records SET links = json_set(links, '$.md.kind', 'adr') WHERE task_id = ?").run(adrTask.id);
  git(root, "rm", "-rq", "docs/design");
  git(root, "commit", "-qm", "gone");
  const rev = git(root, "rev-parse", "HEAD~1").trim();
  const dry = syncDocs(db, root, { rev, dryRun: true });
  assert.deepEqual(dry.map((x) => x.adopted), ["docs/design/ARCHITECTURE.md", "docs/design/PRODUCT.md"]);
  assert.ok(!fs.existsSync(path.join(root, "docs/design/ARCHITECTURE.md")), "dry run writes nothing");
  const reports = syncDocs(db, root, { rev });
  assert.ok(reports.every((x) => x.written));
  const prod = sectionsOf(db, root, "product");
  const linked = prod[0].records.map((id) => db.record(id));
  assert.deepEqual(linked.map((r) => [r.kind, db.taskById(r.task_id).key]), [["pdr", "PDR"]]);
  assert.ok(pdrsBefore.every((r) => db.record(r.id).status === "dropped" && db.record(r.id).links.moved_to), "the misfiled copies are dropped, pointing to the moved ones");
  assert.equal(db.record(old.id).status, "dropped", "README records are no design");
  assert.deepEqual(syncDocs(db, root, { rev }).map((x) => x.imported.length + x.linked), [0, 0], "again: nothing new");
});

test("MCP doc_section_upsert writes the file and says so; a section also edited in the file is a conflict, told back", () => {
  const { root, db } = repo();
  const out = callTool(db, "doc_section_upsert", { kind: "architecture", key: "storage", title: "Storage", body: "SQLite.", repo: root });
  assert.deepEqual(out.file, { path: "docs/design/ARCHITECTURE.md", written: true, conflicts: [] });
  assert.match(digest("doc_section_upsert", out), /docs\/design\/ARCHITECTURE\.md written$/);
  const file = "docs/design/ARCHITECTURE.md";
  put(root, file, read(root, file).replace("SQLite.", "SQLite, WAL."));
  const again = callTool(db, "doc_section_upsert", { kind: "architecture", key: "storage", body: "SQLite in a file.", repo: root });
  assert.deepEqual(again.file.conflicts, ["storage"]);
  assert.match(digest("doc_section_upsert", again), /NOT written: storage also changed in the file/);
  // {"docs": {"sync": false}}: no file.
  put(root, ".claude/imprimatur.json", JSON.stringify({ docs: { dir: "docs/design", sync: false } }));
  assert.equal(callTool(db, "doc_section_upsert", { kind: "product", key: "p", title: "P", repo: root }).file, undefined);
});

test("process docSync: at session start a hand-written file is adopted and the agent told; after an edit of the file, taken in", () => {
  const { root, db } = repo({ process: { status: false, whereWeLeftOff: false, branchFinish: false, mainGuard: false, designFirst: false, docUpdate: false } });
  const repoId = db.repoOf(root).id;
  const records = { dbOf: () => db, repoId: () => repoId, recordsOf: () => [] };
  put(root, "docs/design/PRODUCT.md", PRODUCT);
  const start = check("SessionStart", { cwd: root, session_id: "S1" }, { records });
  assert.match(start.context.join("\n"), /Imprimatur \(docSync\): design documents synced with their files: docs\/design\/PRODUCT\.md: adopted docs\/design\/PRODUCT\.md; from the file: profil; file written/);
  const file = "docs/design/PRODUCT.md";
  put(root, file, read(root, file).replace("kaydet", "kaydet, bitti"));
  const after = check("PostToolUse", { cwd: root, session_id: "S1", tool_name: "Edit", tool_input: { file_path: path.join(root, file) } }, { records });
  assert.match(after.context.join("\n"), /from the file: profil/);
  assert.match(db.docSection(db.docFind(repoId, "product").id, "profil").body, /kaydet, bitti/);
  assert.deepEqual(check("PostToolUse", { cwd: root, session_id: "S1", tool_name: "Edit", tool_input: { file_path: path.join(root, "README.md") } }, { records }), {}, "another file: nothing");
});

// ---- Review fixes (#73): nothing lost, nothing taken without asking ----

test("an unclosed code fence in a section body does not swallow the sections after it", () => {
  const { root, db } = repo();
  const doc = db.docOf(db.repoOf(root).id, "architecture");
  db.upsertSection(doc.id, "a", { title: "A", body: "```js\nconst x = 1;" }, agent);
  db.upsertSection(doc.id, "b", { title: "B", body: "B's text." }, agent);
  assert.equal(syncDocs(db, root)[0].written, true);
  const again = syncDocs(db, root)[0];
  assert.deepEqual([again.imported, again.superseded, again.conflicts, again.written], [[], [], [], false]);
  assert.equal(db.docSection(doc.id, "b").status, "current");
  assert.equal(db.docSection(doc.id, "a").body, "```js\nconst x = 1;");
});

test("a repo that did not opt in: a hand-written file is left alone; asked (adopt), adopted with the original kept", () => {
  const root = tmpDir();
  git(root, "init", "-q");
  const db = openDb({ path: path.join(tmpDir(), "imprimatur.db") });
  put(root, "docs/ARCHITECTURE.md", ARCH);
  const r = syncDocs(db, root)[0];
  assert.deepEqual([r.skipped, r.written], ["manual", false]);
  assert.equal(read(root, "docs/ARCHITECTURE.md"), ARCH);
  const asked = syncDocs(db, root, { adopt: true })[0];
  assert.equal(asked.written, true);
  assert.equal(read(root, asked.backup), ARCH);
  assert.match(asked.backup, /^\.claude\/imprimatur\/docs-backup\/ARCHITECTURE-\d+\.md$/);
});

test("no last sync (new machine, lost state): a section that differs is a conflict, not overwritten; superseded and edited: a conflict", () => {
  const { root, db } = repo();
  const repoId = db.repoOf(root).id;
  const doc = db.docOf(repoId, "architecture");
  db.upsertSection(doc.id, "a", { title: "A", body: "one" }, agent);
  db.upsertSection(doc.id, "b", { title: "B", body: "two" }, agent);
  syncDocs(db, root);
  const file = "docs/design/ARCHITECTURE.md";
  put(root, file, read(root, file).replace("one", "one, from a pull"));
  db.setMeta(`docsync:${repoId}:architecture`, null);
  const r = syncDocs(db, root)[0];
  assert.deepEqual([r.conflicts, r.written], [["a"], false]);
  assert.match(read(root, file), /from a pull/);
  assert.deepEqual(syncDocs(db, root, { take: "file" })[0].imported, ["a"]);
  // Superseded in the database, edited in the file: not silently dropped from the file.
  db.upsertSection(doc.id, "b", { status: "superseded" }, agent);
  put(root, file, read(root, file).replace("two", "two, edited"));
  assert.deepEqual(syncDocs(db, root)[0].conflicts, ["b"]);
  assert.match(read(root, file), /two, edited/);
});

test("import: a record moved by hand to another task stays there; only a misfiled kind moves", () => {
  const root = tmpDir();
  git(root, "init", "-q");
  const db = openDb({ path: path.join(tmpDir(), "imprimatur.db") });
  put(root, "docs/design/ARCHITECTURE.md", "## Store\n\nSQLite.\n");
  importRepo(db, root);
  const repoId = db.repoByRoot(root).id;
  const [rec] = db.recordsFromSource(repoId, "docs/design/ARCHITECTURE.md");
  const other = db.upsertTask(repoId, "#9", {});
  db.sqlite.prepare("UPDATE records SET task_id = ? WHERE id = ?").run(other.id, rec.id);
  const again = importRepo(db, root);
  assert.deepEqual([again.added, again.moved], [0, 0]);
  assert.equal(db.record(rec.id).status, "done");
  assert.equal(db.recordsFromSource(repoId, "docs/design/ARCHITECTURE.md").length, 1);
});
