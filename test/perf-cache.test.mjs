// The graph's per-file cache returns the same rows as a fresh computation and
// is dropped when anything it read changes (#51).
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { graphRows } = req("../vscode/graph.js");
const { diff } = req("../vscode/diff.js");
const { sessionTodos, placeOf } = req("../vscode/tasks.js");

// mtime resolution: make each write visibly newer.
let clock = Date.now() / 1000 - 1000;
const write = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  clock += 2;
  fs.utimesSync(f, clock, clock);
};
const row = (t, before) => JSON.stringify({ t, session: "s1", tool: "Edit", prompt: "p", before }) + "\n";
const view = (root, open) => graphRows(root, open).rows.map((r) => [r.n, r.added, r.removed, r.accepted, r.summary]);

test("#51: cached rows follow the log, the file, the review copy and the open editor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-51-"));
  const log = path.join(root, ".claude/imprimatur/history/a.md.jsonl");
  const copy = path.join(root, ".claude/imprimatur/baseline/a.md");
  write(path.join(root, "a.md"), "one\ntwo\n");
  write(copy, "one\n");
  write(log, row("2026-10-07T10:00:00Z", "one\n"));
  assert.deepEqual(view(root), [[1, 1, 0, false, "two"]]);
  assert.deepEqual(view(root), [[1, 1, 0, false, "two"]]); // from the cache
  // The agent edits again: a new log line.
  write(path.join(root, "a.md"), "one\ntwo\nthree\n");
  fs.appendFileSync(log, row("2026-10-07T10:01:00Z", "one\ntwo\n"));
  clock += 2;
  fs.utimesSync(log, clock, clock);
  assert.deepEqual(view(root), [[2, 1, 0, false, "three"], [1, 1, 0, false, "two"]]);
  // Accept all: the copy is the file.
  write(copy, "one\ntwo\nthree\n");
  assert.deepEqual(view(root).map((r) => r[3]), [true, true]);
  // The open editor's unsaved text counts, and changes with it.
  // (the latest edit's after is the text now: the unsaved line is under review with it)
  assert.deepEqual(view(root, () => "one\ntwo\nthree\nfour\n").map((r) => r[3]), [false, true]);
  // Editor closed again: the file on disk, not the cached editor text.
  assert.deepEqual(view(root).map((r) => r[3]), [true, true]);
});

test("#51: a line-only diff has the same ranges as the full one", () => {
  const a = "# T\n\nOld sentence here.\nkeep\n- one\n";
  const b = "# T\n\nNew sentence there.\nkeep\n- one\n- two\n";
  const strip = (hs) => hs.map((h) => [h.oldStart, h.oldEnd, h.newStart, h.newEnd, h.marks.map((m) => m.kind)]);
  assert.deepEqual(strip(diff(a, b, { words: false })), strip(diff(a, b)));
  assert.deepEqual(diff(a, b, { words: false })[0].marks[0].inserted, []);
});

test("#51: the waiting list's TODO.md lookups see a TODO.md that changed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-51t-"));
  const todo = path.join(root, "todos/7/TODO.md");
  write(todo, "# #7\n\n- TODO: something else\n");
  const step = { session: "s", text: "check the deploy logs", task: "#7" };
  assert.equal(placeOf(root, step, sessionTodos(root)).line, 0);
  write(todo, "# #7\n\n- TODO: something else\n- TODO: (K) check the deploy logs\n");
  assert.equal(placeOf(root, step, sessionTodos(root)).line, 4);
});
