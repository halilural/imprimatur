import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { closeDoneTasks } = require("../vscode/todo-done.js");
const records = require("../vscode/records.js");
const { waitingItems } = require("../vscode/waiting.js");
const { namesTask } = require("../vscode/tasks.js");

test("todo-done: names a task by its key or a Jira key's number alone", () => {
  assert.equal(namesTask("13977 kapatıldı", "LATD-13977"), true);
  assert.equal(namesTask("latd-13977 tamam", "LATD-13977"), true);
  assert.equal(namesTask("139770 başka", "LATD-13977"), false);
  assert.equal(namesTask("#39 bitti", "#39"), true);
  assert.equal(namesTask("39 bitti", "#39"), false); // a bare short number names nothing
});

/** A repo whose database holds tasks {key: [status, doneAt]}; the process reads it. */
function seed(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-todo-done-"));
  const file = path.join(root, "imprimatur.db");
  process.env.IMPRIMATUR_DB = file;
  records.reset();
  const db = require("../vscode/db.js").openDb({ path: file });
  const repoId = db.repoOf(root).id;
  for (const [key, [status, at]] of Object.entries(tasks)) {
    db.upsertTask(repoId, key, { status });
    if (at) db.sqlite.prepare("UPDATE tasks SET updated_at = ? WHERE repo_id = ? AND key = ?").run(Date.parse(at), repoId, key);
  }
  db.close();
  return root;
}

test("todo-done: a task done in the database ticks its earlier asks in every session, not later ones (#43)", () => {
  const root = seed({ "LATD-13977": ["done", "2026-10-06T10:00:00Z"], "LATD-13937": ["open"] });
  const dir = path.join(root, ".claude/imprimatur/waiting");
  fs.mkdirSync(dir, { recursive: true });
  const write = (s, ...rs) => fs.writeFileSync(path.join(dir, `${s}.jsonl`), rs.map((r) => JSON.stringify({ session: s, ...r }) + "\n").join(""));
  write("a", { t: "2026-10-06T08:00:00Z", kind: "question", text: "Kapatalım mı?", task: "LATD-13977" });
  write("b", { t: "2026-10-06T09:00:00Z", kind: "verify", text: "LATD-13977: A/B düzelt\nMaili gönder" }); // key in its text
  write("c", { t: "2026-10-06T11:00:00Z", kind: "verify", text: "Tag'leri sil", task: "LATD-13977" }); // asked after done
  write("d", { t: "2026-10-06T08:00:00Z", kind: "verify", text: "Tim'e mail", task: "LATD-13937" });
  assert.equal(closeDoneTasks(root), 3);
  const open = waitingItems(root).filter((i) => i.open).map((i) => i.session).sort();
  assert.deepEqual(open, ["c", "d"]);
  const b = waitingItems(root).find((i) => i.session === "b");
  assert.deepEqual([b.done, b.ticks[0].by, b.ticks[0].note], [true, "file", "LATD-13977 done in Imprimatur"]);
  // The same task at the same change time is not read again.
  assert.equal(closeDoneTasks(root), 0);
});
