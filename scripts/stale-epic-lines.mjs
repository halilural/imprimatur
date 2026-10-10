#!/usr/bin/env node
// Read-only report (#70): open epic records that are the line of a task already done or
// dropped, in every repo of the database (the same matching as the epic cascade in
// vscode/db.js: links.issue, or a title that starts with the key). Changes nothing.
//
//   node scripts/stale-epic-lines.mjs [--json]
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dbPath, refersTo } = require("../vscode/db.js");
// node:sqlite without its "experimental" warning.
const emit = process.emitWarning;
process.emitWarning = () => {};
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = emit;

// Opened read-only: no migration, no write, whatever the schema version.
const db = new DatabaseSync(dbPath(), { readOnly: true });
try {
  const tasks = db.prepare(`SELECT t.key, t.status, t.epic_id, e.key AS epic, p.name AS repo
                            FROM tasks t JOIN tasks e ON e.id = t.epic_id JOIN repos p ON p.id = t.repo_id
                            WHERE t.status IN ('done', 'dropped') AND t.epic_id != t.id ORDER BY p.name, e.key, t.key`).all();
  const open = db.prepare("SELECT id, title, links FROM records WHERE task_id = ? AND status = 'open' ORDER BY position");
  const rows = [];
  for (const t of tasks) {
    for (const r of open.all(t.epic_id)) {
      const rec = { ...r, links: r.links ? JSON.parse(r.links) : null };
      if (refersTo(rec, t.key)) rows.push({ repo: t.repo, key: t.key, status: t.status, epic: t.epic, record: r.id, title: r.title });
    }
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else if (!rows.length) {
    console.log("No open epic lines for finished tasks.");
  } else {
    for (const r of rows) console.log(`${r.repo}\t${r.key} (${r.status})\tepic ${r.epic}\trecord ${r.record}\t${r.title}`);
    console.log(`${rows.length} open epic line${rows.length === 1 ? "" : "s"} for finished tasks`);
  }
} finally {
  db.close();
}
