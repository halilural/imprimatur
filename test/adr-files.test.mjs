// #191: ADRs as docs/adr/NNNN-slug.md in Pocock's ADR-FORMAT, edits read back.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { exportDocs } = req("../vscode/docs-export.js");
const { parseAdr } = req("../vscode/adr-files.js");
const agent = { kind: "agent", id: "s1" };

test("ADR files: Pocock's format, stable numbers, a file edit read back, a clash kept as a note", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-191-")));
  fs.mkdirSync(path.join(root, ".git"));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#1", { title: "T" });
  db.addRecord(task.id, { kind: "pdr", title: "A product choice" }, agent);
  const adr = db.addRecord(task.id, { kind: "adr", title: "SQLite is the source of truth", body: "One file per device." }, agent);
  exportDocs(db, root);
  const dir = path.join(root, "docs", "adr");
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ["0002-sqlite-is-the-source-of-truth.md"], "numbers shared with the PDRs, never reused; PDRs not here");
  const f = path.join(dir, files[0]);
  const text = fs.readFileSync(f, "utf8");
  assert.match(text, /^---\nstatus: accepted\nrecord: /);
  assert.match(text, /\n# SQLite is the source of truth\n\nOne file per device\.\n$/);
  assert.deepEqual(parseAdr(text), { title: "SQLite is the source of truth", body: "One file per device." });
  // The user edits the file: its text reaches the record, the file stays.
  fs.writeFileSync(f, text.replace("One file per device.", "One file per device; WAL mode."));
  exportDocs(db, root);
  assert.equal(db.record(adr.id).body, "One file per device; WAL mode.");
  assert.match(fs.readFileSync(f, "utf8"), /WAL mode\./);
  // Both change: the record wins, the file's text is kept as a note.
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("WAL mode.", "from the file."));
  db.updateRecord(adr.id, { body: "From the record." }, agent);
  exportDocs(db, root);
  assert.equal(db.record(adr.id).body, "From the record.");
  assert.match(fs.readFileSync(f, "utf8"), /From the record\./);
  assert.ok(db.recordsOf(task.id).some((r) => r.kind === "note" && /not taken/.test(r.title) && /from the file/.test(r.body)));
  // A hand-written file of the same name is left alone.
  fs.writeFileSync(f, "# Mine\n\nHand written.\n");
  exportDocs(db, root);
  assert.equal(fs.readFileSync(f, "utf8"), "# Mine\n\nHand written.\n");
});
