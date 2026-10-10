// Design documents (#72), review fixes: the export never overwrites a hand-written file or
// writes outside the repo; section bodies capped so they sync; received sections checked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../cloud/src/server.js";
import { callTool } from "../mcp/server.mjs";

const req = createRequire(import.meta.url);
const { openDb, normOrigin } = req("../vscode/db.js");
const { syncOnce, wire, MAX_VALUE } = req("../vscode/sync.js");
const docs = req("../vscode/docsView.js");
const { exportDocs, HEADER } = req("../vscode/docs-export.js");
const { DatabaseSync } = req("node:sqlite");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-72r-")));
const tmpDb = () => path.join(tmpDir(), "imprimatur.db");
const ORIGIN = "git@github.com:u/proj.git";
function seeded(root = "/a/proj", origin) {
  const db = openDb({ path: tmpDb() });
  const repo = db.repoOf(root, origin ? { origin } : {});
  const task = db.upsertTask(repo.id, "#72", { title: "Docs" });
  const adr = db.addRecord(task.id, { kind: "adr", title: "SQLite is the source of truth" }, agent);
  const pdr = db.addRecord(task.id, { kind: "pdr", title: "Two tabs" }, agent);
  return { db, repo, task, adr, pdr };
}
const docOn = (db, kind) => {
  const r = db.repos().find((x) => x.origin && normOrigin(x.origin) === "github.com/u/proj");
  return r && db.docFind(r.id, kind);
};

class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(fs.readFileSync(new URL("../cloud/migrations/0001_changes.sql", import.meta.url), "utf8"));
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
const TOKEN = "t0ken";
const server = () => {
  const env = { DB: new FakeD1(), SYNC_TOKEN: TOKEN };
  return { fetch: (url, init) => handle(new Request(url, init), env) };
};
const cfg = { url: "https://sync.example", token: TOKEN };

test("export: a hand-written docs file is never overwritten; the tab says so", () => {
  const root = tmpDir();
  const { db, repo } = seeded(root);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "storage", { title: "Storage", body: "x" }, agent);
  fs.mkdirSync(path.join(root, "docs"));
  const file = path.join(root, "docs", "ARCHITECTURE.md");
  fs.writeFileSync(file, "# Our architecture\n\nWritten by hand.\n");
  assert.deepEqual(exportDocs(db, root).map((r) => [r.kind, r.written, r.skipped]), [["architecture", false, "manual"]]);
  assert.equal(fs.readFileSync(file, "utf8"), "# Our architecture\n\nWritten by hand.\n");
  assert.match(docs.docHtml(docs.docModel(db, root, "architecture")), /docs\/ARCHITECTURE\.md elle yazılmış, üzerine yazılmadı/);
  assert.ok(!docs.docHtml(docs.docModel(db, root, "product")).includes("elle yazılmış"));
  // Ours (the header first): rewritten, and no note.
  fs.writeFileSync(file, `${HEADER}\n\nold\n`);
  assert.equal(exportDocs(db, root)[0].written, true);
  assert.ok(!docs.docHtml(docs.docModel(db, root, "architecture")).includes("elle yazılmış"));
});

test("export: a docs/ symlinked out of the repo, or a symlinked file, is refused", () => {
  const root = tmpDir();
  const away = tmpDir();
  const { db, repo } = seeded(root);
  db.upsertSection(db.docOf(repo.id, "architecture").id, "s", { title: "S" }, agent);
  fs.symlinkSync(away, path.join(root, "docs"));
  assert.deepEqual(exportDocs(db, root).map((r) => r.skipped), ["outside"]);
  assert.deepEqual(fs.readdirSync(away), []);
  fs.unlinkSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "docs"));
  const target = path.join(away, "x.md");
  fs.writeFileSync(target, `${HEADER}\n`);
  fs.symlinkSync(target, path.join(root, "docs", "ARCHITECTURE.md"));
  assert.deepEqual(exportDocs(db, root).map((r) => r.skipped), ["outside"]);
  assert.equal(fs.readFileSync(target, "utf8"), `${HEADER}\n`);
});

test("section body capped at 40,000 chars (db, MCP); an oversized section is never cut nor dropped quietly", async () => {
  const { db, repo } = seeded("/a/proj", ORIGIN);
  db.enableSync();
  const doc = db.docOf(repo.id, "architecture");
  assert.throws(() => db.upsertSection(doc.id, "big", { title: "Big", body: "x".repeat(40_001) }, agent), /limit is 40000/);
  assert.throws(() => db.upsertSection(doc.id, "big", { title: "T".repeat(301) }, agent), /over 300/);
  db.upsertSection(doc.id, "big", { title: "Big", body: '"\n'.repeat(20_000) }, agent);
  const row = db.outbox().find((r) => r.entity === "section" && r.field === "body");
  assert.ok(row.value.length < MAX_VALUE, "40,000 chars stay under the Worker's limit when escaping doubles them");
  const root = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const mdb = openDb({ path: tmpDb() });
  assert.throws(() => callTool(mdb, "doc_section_upsert", { repo: root, kind: "product", key: "a", title: "A", body: "x".repeat(40_001) }), /limit is 40000/);
  // One over the Worker's limit anyway (older code wrote it): not cut, not sent, said loudly with its key.
  const huge = JSON.stringify("y".repeat(MAX_VALUE));
  assert.equal(wire({ entity: "section", key: "github.com/u/proj\tarchitecture\tbig", field: "body", value: huge, at: 1 }), undefined);
  db.sqlite.prepare("INSERT INTO outbox (entity, key, field, value, at) VALUES ('section', ?, 'body', ?, ?)").run("github.com/u/proj\tarchitecture\tbig", huge, Date.now());
  const s = server();
  const lines = [];
  await syncOnce(db, cfg, { fetch: s.fetch, log: (line, loud) => lines.push([line, !!loud]) });
  assert.ok(lines.some(([l, loud]) => loud && /NOT SENT, section github\.com\/u\/proj architecture\/big body is \d+ chars encoded/.test(l)), JSON.stringify(lines));
  // A section change the server refuses (the bisect drops it): logged with its key.
  db.upsertSection(doc.id, "big", { body: "short" }, agent);
  const refused = [];
  const no = async (url, init) => (String(url).includes("/v1/push") ? new Response(JSON.stringify({ error: "bad" }), { status: 400 }) : s.fetch(url, init));
  await syncOnce(db, cfg, { fetch: no, log: (line, loud) => refused.push([line, !!loud]) });
  assert.ok(refused.some(([l, loud]) => loud && l.includes("(section github.com/u/proj architecture/big body)")), JSON.stringify(refused));
});

test("applySection_: received titles and bodies over the limits are refused", () => {
  const b = openDb({ path: tmpDb() });
  const at = Date.now();
  const key = "github.com/u/proj\tproduct\tok";
  const r = b.applyRemote([
    { entity: "section", key, field: "title", value: JSON.stringify("T".repeat(301)), at, device: "d" },
    { entity: "section", key, field: "body", value: JSON.stringify("x".repeat(40_001)), at, device: "d" },
  ]);
  assert.equal(r.applied, 0);
  assert.equal(docOn(b, "product"), undefined);
});

test("applySection_: records with one not here yet change nothing (links, clock) and wait", () => {
  const a = seeded("/a/proj", ORIGIN);
  const doc = a.db.docOf(a.repo.id, "architecture");
  a.db.upsertSection(doc.id, "storage", { title: "Storage", addRecords: [a.adr.id] }, agent);
  const key = "github.com/u/proj\tarchitecture\tstorage";
  const r = a.db.applyRemote([{ entity: "section", key, field: "records", value: JSON.stringify([a.pdr.uid, "not-here-yet"]), at: Date.now() + 1000, device: "zz" }]);
  assert.equal(r.pending, 1);
  assert.deepEqual(a.db.docSection(doc.id, "storage").records, [a.adr.id], "links untouched");
  assert.equal(a.db.sqlite.prepare("SELECT count(*) AS n FROM clock WHERE entity = 'section' AND field = 'records'").get().n, 0);
  // The record arrives: the waiting change applies.
  a.db.addRecord(a.task.id, { kind: "note", title: "late", uid: "not-here-yet" }, agent);
  a.db.applyRemote([]);
  assert.equal(a.db.docSection(doc.id, "storage").records.length, 2);
});
