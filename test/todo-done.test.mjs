import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { isDone, closeDoneTasks } = require("../vscode/todo-done.js");
const { waitingItems } = require("../vscode/waiting.js");
const { namesTask } = require("../vscode/tasks.js");

test("todo-done: a TODO.md says done in its Durum / Status section or line", () => {
  assert.equal(isDone("# x\n\n## Durum\n\nBitti — 2026-10-06 (PR #40)\n"), true);
  assert.equal(isDone("## Status\n\n**Done** 2026-10-06\n"), true);
  assert.equal(isDone("- **Durum:** Bitti (2026-10-06)\n"), true);
  assert.equal(isDone("## Durum\n\nDevam ediyor — Bitti değil\n"), false);
  assert.equal(isDone("## Durum\n\n## Yapılacaklar\n\n- DONE: (C) bitti\n"), false);
});

test("todo-done: names a task by its key or a Jira key's number alone", () => {
  assert.equal(namesTask("13977 kapatıldı", "LATD-13977"), true);
  assert.equal(namesTask("latd-13977 tamam", "LATD-13977"), true);
  assert.equal(namesTask("139770 başka", "LATD-13977"), false);
  assert.equal(namesTask("#39 bitti", "#39"), true);
  assert.equal(namesTask("39 bitti", "#39"), false); // a bare short number names nothing
});

test("todo-done: a task done in its TODO.md ticks its earlier asks in every session, not later ones (#43)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-todo-done-"));
  const dir = path.join(root, ".claude/imprimatur/waiting");
  fs.mkdirSync(dir, { recursive: true });
  const todo = path.join(root, "todos/LATD-13977/TODO.md");
  fs.mkdirSync(path.dirname(todo), { recursive: true });
  fs.writeFileSync(todo, "# LATD-13977\n\n## Durum\n\nBitti (2026-10-06)\n");
  const at = new Date("2026-10-06T10:00:00Z");
  fs.utimesSync(todo, at, at);
  const write = (s, ...rs) => fs.writeFileSync(path.join(dir, `${s}.jsonl`), rs.map((r) => JSON.stringify({ session: s, ...r }) + "\n").join(""));
  write("a", { t: "2026-10-06T08:00:00Z", kind: "question", text: "Kapatalım mı?", task: "LATD-13977" });
  write("b", { t: "2026-10-06T09:00:00Z", kind: "verify", text: "LATD-13977: A/B düzelt\nMaili gönder" }); // key in its text
  write("c", { t: "2026-10-06T11:00:00Z", kind: "verify", text: "Tag'leri sil", task: "LATD-13977" }); // asked after done
  write("d", { t: "2026-10-06T08:00:00Z", kind: "verify", text: "Tim'e mail", task: "LATD-13937" });
  assert.equal(closeDoneTasks(root), 3);
  const open = waitingItems(root).filter((i) => i.open).map((i) => i.session).sort();
  assert.deepEqual(open, ["c", "d"]);
  const b = waitingItems(root).find((i) => i.session === "b");
  assert.deepEqual([b.done, b.ticks[0].by, b.ticks[0].note], [true, "file", "LATD-13977 done in todos/LATD-13977/TODO.md"]);
  // The same TODO.md at the same mtime is not read again.
  assert.equal(closeDoneTasks(root), 0);
});
