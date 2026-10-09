import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { taskKeyIn, keyOfTodo, lineFor, placeOf } = req("../vscode/tasks.js");
const records = req("../vscode/records.js");

test("tasks: keys in text and in a TODO.md's folder", () => {
  assert.equal(taskKeyIn("LATD-13937 için Tim'e yaz"), "LATD-13937");
  assert.equal(taskKeyIn("#26'yı commit et"), "#26");
  assert.equal(taskKeyIn("sürüm 0.28.6"), undefined);
  assert.equal(taskKeyIn("MT-AR-011 dirtywork"), undefined);
  assert.equal(keyOfTodo("todos/LATD-13937/TODO.md"), "LATD-13937");
  assert.equal(keyOfTodo("todos/25/TODO.md"), "#25");
});

test("tasks: the line that says the step", () => {
  const md = "Epic\nTim'e takip mailini gönder (!2690)\nREADME\n";
  assert.equal(lineFor(md, "LATD-13937: Tim'e !2690 için takip mailini gönder"), 2);
  assert.equal(lineFor(md, "Paneli aç"), 0);
});

test("tasks: a step's place from the records its session wrote", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tasks-"));
  const file = path.join(root, "imprimatur.db");
  process.env.IMPRIMATUR_DB = file;
  records.reset();
  const db = req("../vscode/db.js").openDb({ path: file });
  const repoId = db.repoOf(root).id;
  const t = db.upsertTask(repoId, "LATD-13937", { title: "Tim" });
  const r = db.addRecord(t.id, { kind: "todo", owner: "K", title: "Tim'e takip mailini gönder", body: "https://acme.atlassian.net/browse/LATD-13937" }, { kind: "agent", id: "claude-code:s1" });
  db.close();
  const sessions = records.sessionTasks(root);
  assert.deepEqual(sessions.get("s1"), ["LATD-13937"]);
  assert.deepEqual(placeOf(root, { session: "s1", text: "Tim'e takip mailini gönder" }, sessions), {
    task: "LATD-13937", url: "https://acme.atlassian.net/browse/LATD-13937", record: r.id,
  });
  assert.deepEqual(placeOf(root, { session: "other", text: "x" }, sessions), {});
  // A step that names the task finds its record without the session.
  assert.equal(placeOf(root, { session: "old", text: "LATD-13937: Tim'e takip mailini gönder" }, sessions).record, r.id);
  // A Jira key without a record of its own: the address learned from another record.
  assert.deepEqual(placeOf(root, { session: "old", text: "LATD-13931: Tim'e özet mail gönder" }, sessions), { task: "LATD-13931", url: "https://acme.atlassian.net/browse/LATD-13931" });
  // The same session asks something none of its records say: no task.
  assert.deepEqual(placeOf(root, { session: "s1", text: "Jira adresi ne?" }, sessions), {});
});
