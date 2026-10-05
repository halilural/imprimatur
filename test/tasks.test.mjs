import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { taskKeyIn, keyOfTodo, lineFor, linkFor, sessionTodos, placeOf } = req("../vscode/tasks.js");

test("tasks: keys in text and in a TODO.md's folder", () => {
  assert.equal(taskKeyIn("LATD-13937 için Tim'e yaz"), "LATD-13937");
  assert.equal(taskKeyIn("#26'yı commit et"), "#26");
  assert.equal(taskKeyIn("sürüm 0.28.6"), undefined);
  assert.equal(taskKeyIn("MT-AR-011 dirtywork"), undefined);
  assert.equal(keyOfTodo("todos/LATD-13937/TODO.md"), "LATD-13937");
  assert.equal(keyOfTodo("todos/25/TODO.md"), "#25");
});

test("tasks: the line that says the step, and the link that names the task", () => {
  const md = "# #25 · Epic\n\n[#25](https://github.com/o/r/issues/25)\n\n- 👉 TODO: (K) Tim'e takip mailini gönder (!2690)\n- TODO: (C) README\n";
  assert.equal(lineFor(md, "LATD-13937: Tim'e !2690 için takip mailini gönder"), 5);
  assert.equal(lineFor(md, "Paneli aç"), 0);
  assert.equal(linkFor(md, "#25"), "https://github.com/o/r/issues/25");
  assert.equal(linkFor("[LATD-13937](https://acme.atlassian.net/browse/LATD-13937)", "LATD-13937"), "https://acme.atlassian.net/browse/LATD-13937");
  assert.equal(linkFor(md, "#7"), undefined);
});

test("tasks: a step's place from the TODO.md its session edited", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tasks-"));
  const todo = "todos/LATD-13937/TODO.md";
  fs.mkdirSync(path.join(root, path.dirname(todo)), { recursive: true });
  fs.writeFileSync(path.join(root, todo), "# LATD-13937\n\n[LATD-13937](https://acme.atlassian.net/browse/LATD-13937)\n\n- 👉 TODO: (K) Tim'e takip mailini gönder\n");
  const hist = path.join(root, ".claude/imprimatur/history", `${todo}.jsonl`);
  fs.mkdirSync(path.dirname(hist), { recursive: true });
  fs.writeFileSync(hist, JSON.stringify({ t: "2026-10-05T10:00:00Z", session: "s1", before: "" }) + "\n");
  const todos = sessionTodos(root);
  assert.deepEqual(todos.get("s1"), [todo]);
  assert.deepEqual(placeOf(root, { session: "s1", text: "Tim'e takip mailini gönder" }, todos), {
    task: "LATD-13937", url: "https://acme.atlassian.net/browse/LATD-13937", todo, line: 5,
  });
  assert.deepEqual(placeOf(root, { session: "other", text: "x" }, todos), { task: undefined });
  // The same session asks something its TODO.md does not say: no task from the file.
  assert.deepEqual(placeOf(root, { session: "s1", text: "Jira adresi ne?" }, todos), { task: undefined });
});
