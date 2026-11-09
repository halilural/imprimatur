#!/usr/bin/env node
// Removes repos from this machine's Imprimatur database (#169): every repo whose name is not
// kept, and empty duplicates of a kept name (the row with the most tasks stays). Sync carries
// no deletes, so each machine runs this once; the sync server is cleaned separately.
// Dry run by default; --yes deletes, after a backup next to the database.
//   node scripts/prune-repos.mjs [--yes] [--keep a,b,c]
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const req = createRequire(import.meta.url);
const { dbPath } = req("../vscode/db.js");

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const KEEP = (arg("--keep") ?? "dirtywork,halil-workspace,homebrain,imprimatur,investment,self-learning,twinread").split(",").map((s) => s.trim());
const apply = process.argv.includes("--yes");
const file = dbPath();

const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON");
const repos = db.prepare(`SELECT p.id, p.name, p.root, (SELECT count(*) FROM tasks t WHERE t.repo_id = p.id) AS tasks,
  (SELECT count(*) FROM documents d WHERE d.repo_id = p.id) AS docs FROM repos p ORDER BY p.name, tasks DESC, p.id`).all();

const gone = [];
const seen = new Set();
for (const r of repos) {
  if (!KEEP.includes(r.name)) gone.push(r);
  else if (seen.has(r.name)) {
    // A duplicate of a kept name: only an empty one goes; one with work in it needs a person.
    if (r.tasks || r.docs) console.log(`! second "${r.name}" has ${r.tasks} tasks, ${r.docs} documents: left alone (${r.root})`);
    else gone.push(r);
  } else seen.add(r.name);
}

console.log(`Database: ${file}`);
for (const r of repos) console.log(`${gone.includes(r) ? "DELETE" : "keep  "} #${r.id} ${r.name} · ${r.tasks} tasks · ${r.root}`);
if (!gone.length) { console.log("Nothing to delete."); process.exit(0); }
if (!apply) { console.log("Dry run: run again with --yes to delete."); process.exit(0); }

const backup = `${file}.bak-prune-${new Date().toISOString().slice(0, 10)}`;
db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
console.log(`Backup: ${backup}`);

const R = `(${gone.map((r) => r.id).join(",")})`;
const T = `(SELECT id FROM tasks WHERE repo_id IN ${R})`;
const REC = `(SELECT id FROM records WHERE task_id IN ${T})`;
const D = `(SELECT id FROM documents WHERE repo_id IN ${R})`;
const S = `(SELECT id FROM doc_sections WHERE doc_id IN ${D})`;
const outside = db.prepare(`SELECT (SELECT count(*) FROM records WHERE parent_id IN ${REC} AND task_id NOT IN ${T})
  + (SELECT count(*) FROM tasks WHERE epic_id IN ${T} AND repo_id NOT IN ${R}) AS n`).get().n;
if (outside) throw new Error(`${outside} rows of kept repos point into the deleted ones; nothing deleted`);

const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const steps = [
  `DELETE FROM doc_section_records WHERE record_id IN ${REC} OR section_id IN ${S}`,
  `DELETE FROM record_versions WHERE record_id IN ${REC}`,
  `UPDATE records SET parent_id = NULL WHERE task_id IN ${T}`,
  `DELETE FROM records WHERE task_id IN ${T}`,
  has("tracker_outbox") && `DELETE FROM tracker_outbox WHERE task_id IN ${T}`,
  `UPDATE tasks SET epic_id = NULL WHERE repo_id IN ${R}`,
  `DELETE FROM tasks WHERE repo_id IN ${R}`,
  has("tracker_state") && `DELETE FROM tracker_state WHERE repo_id IN ${R}`,
  `DELETE FROM doc_versions WHERE section_id IN ${S}`,
  has("section_reads") && `DELETE FROM section_reads WHERE section_id IN ${S}`,
  `DELETE FROM doc_sections WHERE doc_id IN ${D}`,
  has("doc_sources") && `DELETE FROM doc_sources WHERE doc_id IN ${D}`,
  `DELETE FROM documents WHERE repo_id IN ${R}`,
  `DELETE FROM repos WHERE id IN ${R}`,
].filter(Boolean);
db.exec("BEGIN");
try {
  for (const sql of steps) db.prepare(sql).run();
  const bad = db.prepare("PRAGMA foreign_key_check").all().length;
  if (bad) throw new Error(`${bad} foreign key problems; rolled back`);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(`Deleted ${gone.length} repos: ${gone.map((r) => r.name).join(", ")}. Reload VS Code windows.`);
