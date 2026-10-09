import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { taskOfFile, placeOf } = require("../vscode/tasks.js");
const records = require("../vscode/records.js");
const { tasksOf } = require("../vscode/graph.js");
const { closeDoneTasks } = require("../vscode/todo-done.js");
const { todoAsks } = require("../vscode/history.js");
const { waitingItems } = require("../vscode/waiting.js");

/** A repo whose database holds #54 (an ask for you) and LATD-7 (done, with a Jira link). */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-layout-"));
  const file = path.join(root, "imprimatur.db");
  process.env.IMPRIMATUR_DB = file;
  records.reset();
  const db = require("../vscode/db.js").openDb({ path: file });
  const repoId = db.repoOf(root).id;
  const actor = { kind: "user", id: "k" };
  const t54 = db.upsertTask(repoId, "#54", { title: "Yerleşim", status: "active" });
  db.addRecord(t54.id, { kind: "todo", owner: "K", title: "Taşıma sırasını seç" }, actor);
  db.addRecord(t54.id, { kind: "todo", owner: "C", title: "Claude'un işi" }, actor);
  const t7 = db.upsertTask(repoId, "LATD-7", { title: "Eski", status: "done" });
  db.addRecord(t7.id, { kind: "note", title: "Jira", body: "https://acme.atlassian.net/browse/LATD-7" }, actor);
  db.sqlite.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(Date.parse("2026-10-09T12:00:00Z"), t7.id);
  db.close();
  return root;
}

test("layout: a file's task under docs/todos/ and todos/ (#54)", () => {
  assert.equal(taskOfFile("docs/todos/54/TODO.md"), "#54");
  assert.equal(taskOfFile("docs/todos/LATD-7/notes.md"), "LATD-7");
  assert.equal(taskOfFile("todos/37/TODO.md"), "#37");
  assert.equal(taskOfFile("docs/todos/54"), undefined); // the folder itself, no file in it
  assert.equal(taskOfFile("docs/design/54/x.md"), undefined);
  assert.equal(taskOfFile("src/todos/54/x.md"), undefined);
  assert.deepEqual(tasksOf([{ file: "docs/todos/54/TODO.md" }, { file: "todos/9/TODO.md" }]), ["#54", "#9"]);
});

test("layout: asks, Jira links and done tasks are read from the database (#54)", () => {
  const root = repo();
  assert.deepEqual(todoAsks(root), [{ task: "#54", text: "Taşıma sırasını seç" }]);
  assert.equal(placeOf(root, { session: "x", text: "LATD-99: bir şey" }, new Map()).url, "https://acme.atlassian.net/browse/LATD-99");
  const dir = path.join(root, ".claude/imprimatur/waiting");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.jsonl"), JSON.stringify({ session: "a", t: "2026-10-09T10:00:00Z", kind: "verify", text: "Kapat", task: "LATD-7" }) + "\n");
  assert.equal(closeDoneTasks(root), 1);
  assert.equal(waitingItems(root).find((i) => i.session === "a").open, false);
});
