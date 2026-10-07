// Data recorded under older rules corrects itself when read (#47).
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { callOf, keptCalls, CALLS } = req("../vscode/calls.js");
const { graphRows } = req("../vscode/graph.js");
const { closeDoneTasks } = req("../vscode/todo-done.js");
const { waitingItems } = req("../vscode/waiting.js");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A transcript: tool calls ({id, name, input, branch, failed, running}). */
function transcript(dir, calls) {
  const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = calls.flatMap((c) => [
    { type: "assistant", gitBranch: c.branch, message: { id: `m-${c.id}`, content: [{ type: "tool_use", id: c.id, name: c.name, input: c.input }] } },
    ...(c.running ? [] : [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: c.id, is_error: !!c.failed, content: "x" }] } }]),
  ]);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

test("#47: a finished call is kept in the repo and read from there once its transcript is gone", () => {
  const root = tmp("imprimatur-47c-");
  const tr = transcript(root, [
    { id: "e1", name: "Edit", input: { old_string: "a", new_string: "b" }, branch: "feat/3-x" },
    { id: "b1", name: "Bash", input: { command: "ls" }, branch: "main", failed: true },
    { id: "r1", name: "Edit", input: { old_string: "a", new_string: "c" }, branch: "feat/3-x", running: true },
  ]);
  assert.deepEqual(callOf(root, tr, "e1"), { toolUseId: "e1", branch: "feat/3-x", name: "Edit", input: { old_string: "a", new_string: "b" }, failed: false });
  assert.deepEqual(callOf(root, tr, "b1"), { toolUseId: "b1", branch: "main" });
  assert.equal(callOf(root, tr, "r1")?.name, "Edit");
  // Kept: the finished ones only (a running call's result is not known yet).
  assert.deepEqual([...keptCalls(root).keys()].sort(), ["b1", "e1"]);
  fs.rmSync(tr);
  assert.equal(callOf(root, tr, "e1")?.input.new_string, "b");
  assert.equal(callOf(root, tr, "r1"), undefined);
  // Read twice, kept once.
  assert.equal(fs.readFileSync(path.join(root, CALLS), "utf8").trimEnd().split("\n").length, 2);
});

test("#47: an older Bash row recorded the branch after the command: the graph corrects it from the transcript", () => {
  const root = tmp("imprimatur-47b-");
  const tr = transcript(root, [
    { id: "b1", name: "Bash", input: { command: "sed -i s/a/b/ a.md && git commit -qam x && git switch main" }, branch: "fix/692-reroute" },
    { id: "b2", name: "Bash", input: { command: "sed -i s/b/c/ a.md" }, branch: "feat/5-y" },
  ]);
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(
    path.join(h, "a.md.jsonl"),
    [
      { t: "2026-10-06T10:00:00Z", session: "s1", tool: "Bash", prompt: "p1", transcript: tr, toolUseId: "b1", branch: "main", before: "a\n" },
      // Before branches were recorded at all.
      { t: "2026-10-06T11:00:00Z", session: "s1", tool: "Bash", prompt: "p2", transcript: tr, toolUseId: "b2", before: "b\n" },
    ].map((r) => JSON.stringify(r) + "\n").join(""),
  );
  fs.writeFileSync(path.join(root, "a.md"), "c\n");
  assert.deepEqual(graphRows(root).rows.map((r) => [r.n, r.task]), [[2, "#5"], [1, "#692"]]);
});

test("#47: a done-cache written under older rules is read again from scratch", () => {
  const root = tmp("imprimatur-47t-");
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // The item's task field names another task; the step itself is about #37.
  fs.writeFileSync(log, JSON.stringify({ t: "2026-10-06T08:00:00Z", session: "s1", kind: "verify", task: "#36", text: "#37 için panelde kutuları tikle" }) + "\n");
  const todo = path.join(root, "todos/37/TODO.md");
  fs.mkdirSync(path.dirname(todo), { recursive: true });
  fs.writeFileSync(todo, "# #37\n\n## Durum\n\nBitti\n");
  const at = new Date("2026-10-06T10:00:00Z");
  fs.utimesSync(todo, at, at);
  // The old cache (plain map) saw this TODO.md already, under the old rules.
  fs.writeFileSync(path.join(root, ".claude/imprimatur/todo-done.json"), JSON.stringify({ "todos/37/TODO.md": at.getTime() }));
  assert.equal(closeDoneTasks(root), 1);
  assert.equal(waitingItems(root)[0].open, false);
  // The new cache: nothing to do twice.
  assert.equal(closeDoneTasks(root), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".claude/imprimatur/todo-done.json"), "utf8")).rules, 2);
});
