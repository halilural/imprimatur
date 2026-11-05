import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

test("decisions (#130): each adr/pdr a numbered MADR 4 file with an index; numbers never reused; sections and files link both ways", () => {
  const { openDb } = require("../vscode/db.js");
  const { exportDocs, HEADER } = require("../vscode/docs-export.js");
  const { slug, LINKS_MARK } = require("../vscode/decisions.js");
  const db = openDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-madr-"));
  fs.mkdirSync(path.join(root, ".git"));
  const repo = db.repoOf(root);
  const user = { kind: "user" };
  const t = db.upsertTask(repo.id, "#7", { title: "Store the data" });
  const a = db.addRecord(t.id, { kind: "adr", title: "Use SQLite, not JSON files", body: "SQLite in one file per device.\nAlternative: JSON files, rejected for concurrent writes.\nThe trade-off: a native-free node:sqlite." }, user);
  const p = db.addRecord(t.id, { kind: "pdr", title: "Şirketler hariç tutulur", body: "Excluded companies are hidden." }, user);
  const docId = db.docOf(repo.id, "architecture").id;
  db.upsertSection(docId, "storage", { title: "Storage", body: "One database.", chapter: "building-blocks", addRecords: [a.id] }, user);
  exportDocs(db, root);
  const dir = path.join(root, "docs", "decisions");
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ["0001-use-sqlite-not-json-files.md", "0002-sirketler-haric-tutulur.md", "README.md"]);
  const madr = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.match(madr, /^---\ntype: adr\nstatus: accepted\ndate: \d{4}-\d\d-\d\d\nrecord: /);
  for (const h of ["Context and Problem Statement", "Considered Options", "Decision Outcome", "Consequences"]) assert.match(madr, new RegExp(`## ${h}`));
  assert.match(madr, /Alternative: JSON files, rejected/);
  assert.match(madr, /\[Architecture: Storage\]\(\.\.\/ARCHITECTURE\.md#storage\)/, "the decision links its section");
  const arch = fs.readFileSync(path.join(root, "docs", "ARCHITECTURE.md"), "utf8");
  assert.ok(arch.includes(`${LINKS_MARK} Decisions: [ADR 0001](decisions/0001-use-sqlite-not-json-files.md)`), "the section links its decision");
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /\| \[0002\]\(0002-sirketler-haric-tutulur\.md\) \| Şirketler hariç tutulur \| PDR \| accepted \|/);
  // Dropped: the number stays, the file says rejected; a new decision takes the next number.
  db.updateRecord(p.id, { status: "dropped" }, user);
  const n = db.addRecord(t.id, { kind: "adr", title: "Add an index", body: "x" }, user);
  exportDocs(db, root);
  assert.match(fs.readFileSync(path.join(dir, "0002-sirketler-haric-tutulur.md"), "utf8"), /status: rejected/);
  assert.ok(fs.existsSync(path.join(dir, "0003-add-an-index.md")));
  // Renamed: the old file goes, the number stays.
  db.updateRecord(n.id, { title: "Add a covering index" }, user);
  exportDocs(db, root);
  assert.ok(!fs.existsSync(path.join(dir, "0003-add-an-index.md")));
  assert.ok(fs.existsSync(path.join(dir, "0003-add-a-covering-index.md")));
  // A hand-written file of the same name is left alone.
  fs.writeFileSync(path.join(dir, "0001-use-sqlite-not-json-files.md"), "# mine\n");
  exportDocs(db, root);
  assert.equal(fs.readFileSync(path.join(dir, "0001-use-sqlite-not-json-files.md"), "utf8"), "# mine\n");
  assert.equal(slug("Çok uzun bir başlık ".repeat(10)).length <= 60, true);
  assert.ok(HEADER);
  fs.rmSync(root, { recursive: true, force: true });
});
