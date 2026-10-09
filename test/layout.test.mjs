import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { todoFiles, taskOfFile, todoOfKey, jiraBase } = require("../vscode/tasks.js");
const { tasksOf } = require("../vscode/graph.js");
const { closeDoneTasks } = require("../vscode/todo-done.js");
const { todoAsks } = require("../vscode/history.js");
const { waitingItems } = require("../vscode/waiting.js");

/** A repo with one task in each layout: docs/todos/54/ (new) and todos/LATD-7/ (old). */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-layout-"));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put("docs/todos/54/TODO.md", "# #54 · Yerleşim\n\n## Durum\n\nSürüyor\n\n- 👉 TODO: (K) Taşıma sırasını seç\n");
  put("docs/todos/TEMPLATE.md", "# şablon\n"); // not a task folder
  put("todos/LATD-7/TODO.md", "# LATD-7 · Eski\n\n## Durum\n\nBitti (2026-10-09)\n\n[LATD-7](https://acme.atlassian.net/browse/LATD-7)\n");
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

test("layout: TODO.md files and a task's own one in both layouts (#54)", () => {
  const root = repo();
  const files = todoFiles(root).filter((f) => fs.existsSync(path.join(root, f)));
  assert.deepEqual(files, [path.join("docs", "todos", "54", "TODO.md"), path.join("todos", "LATD-7", "TODO.md")]);
  assert.equal(todoOfKey(root, "#54"), path.join("docs", "todos", "54", "TODO.md"));
  assert.equal(todoOfKey(root, "LATD-7"), path.join("todos", "LATD-7", "TODO.md"));
  assert.equal(todoOfKey(root, "#1"), undefined);
  // The newer layout wins when a task is in both (mid-move).
  fs.mkdirSync(path.join(root, "todos", "54"), { recursive: true });
  fs.writeFileSync(path.join(root, "todos", "54", "TODO.md"), "# eski kopya\n");
  assert.equal(todoOfKey(root, "#54"), path.join("docs", "todos", "54", "TODO.md"));
});

test("layout: asks, Jira links and done tasks are read from both layouts (#54)", () => {
  const root = repo();
  assert.deepEqual(todoAsks(root), [{ file: path.join("docs", "todos", "54", "TODO.md"), text: "Taşıma sırasını seç" }]);
  assert.equal(jiraBase(root, "LATD-99"), "https://acme.atlassian.net/browse/LATD-99");
  const dir = path.join(root, ".claude/imprimatur/waiting");
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date("2026-10-09T12:00:00Z");
  fs.utimesSync(path.join(root, "todos/LATD-7/TODO.md"), at, at);
  fs.writeFileSync(path.join(dir, "a.jsonl"), JSON.stringify({ session: "a", t: "2026-10-09T10:00:00Z", kind: "verify", text: "Kapat", task: "LATD-7" }) + "\n");
  assert.equal(closeDoneTasks(root), 1);
  assert.equal(waitingItems(root).find((i) => i.session === "a").open, false);
});
