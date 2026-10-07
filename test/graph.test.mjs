import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { graphRows, previewOf, summaryOf, acceptEdit, spotsOf } = createRequire(import.meta.url)("../vscode/graph.js");

test("graph: all files' edits newest first; no task named, one No task lane", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(path.join(h, "docs"), { recursive: true });
  const row = (t, session, prompt, before) => JSON.stringify({ t, session, tool: "Edit", prompt, before }) + "\n";
  fs.writeFileSync(path.join(h, "a.md.jsonl"), row("2026-10-02T10:00:00Z", "s1", "first", "") + row("2026-10-02T12:00:00Z", "s2", "third", "x\n"));
  fs.writeFileSync(path.join(h, "docs/b.md.jsonl"), row("2026-10-02T11:00:00Z", "s1", "second", ""));
  fs.writeFileSync(path.join(root, "a.md"), "x\ny\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/b.md"), "b\n");
  const { rows, lanes } = graphRows(root);
  assert.deepEqual(
    rows.map((r) => [r.file, r.n, r.prompt, r.lane, r.added]),
    [
      ["a.md", 2, "third", 0, 1],
      [path.join("docs", "b.md"), 1, "second", 0, 1],
      ["a.md", 1, "first", 0, 1],
    ],
  );
  assert.deepEqual(lanes, [{ first: 0, last: 2 }]);
});

test("graph: edits whose lines are still under review are not accepted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(h, { recursive: true });
  const row = (t, before) => JSON.stringify({ t, session: "s1", tool: "Edit", before }) + "\n";
  // #1 adds "b", #2 adds "c"; "b" was accepted (in the copy), "c" was not.
  fs.writeFileSync(path.join(h, "a.md.jsonl"), row("2026-10-02T10:00:00Z", "a\n") + row("2026-10-02T11:00:00Z", "a\nb\n"));
  fs.writeFileSync(path.join(root, "a.md"), "a\nb\nc\n");
  fs.mkdirSync(path.join(root, ".claude/imprimatur/baseline"), { recursive: true });
  const copy = path.join(root, ".claude/imprimatur/baseline/a.md");
  fs.writeFileSync(copy, "a\nb\n");
  let { rows } = graphRows(root);
  assert.deepEqual(rows.map((r) => [r.n, r.accepted]), [[2, false], [1, true]]);
  assert.deepEqual(rows[0].preview, [["+", "c"]]);
  assert.equal(rows[1].preview, undefined);
  // Accept all removes the copy: everything is accepted.
  fs.rmSync(copy);
  ({ rows } = graphRows(root));
  assert.deepEqual(rows.map((r) => r.accepted), [true, true]);
});

test("graph: an edit whose line a later edit rewrote follows the later edit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(path.join(root, ".claude/imprimatur/baseline"), { recursive: true });
  fs.mkdirSync(h, { recursive: true });
  const row = (t, before) => JSON.stringify({ t, session: "s1", before }) + "\n";
  // #1 adds "x" (accepted), #2 adds "y" after it (open).
  fs.writeFileSync(path.join(h, "a.md.jsonl"), row("2026-10-02T10:00:00Z", "a\n") + row("2026-10-02T11:00:00Z", "a\nx\n"));
  fs.writeFileSync(path.join(root, "a.md"), "a\nx\ny\n");
  fs.writeFileSync(path.join(root, ".claude/imprimatur/baseline/a.md"), "a\nx\n");
  assert.deepEqual(graphRows(root).rows.map((r) => [r.n, r.accepted]), [[2, false], [1, true]]);
});

test("graph: hover preview lists removed and added lines, capped", () => {
  assert.deepEqual(previewOf("a\nb\nc\n", "a\nB\nc\nd\n"), [["-", "b"], ["+", "B"], ["…", ""], ["+", "d"]]);
  const big = previewOf("", Array.from({ length: 310 }, (_, i) => `l${i}`).join("\n"));
  assert.equal(big.length, 301);
  assert.deepEqual(big[300], ["…", "11 more lines"]); // 1 removed empty line + 310 added, 300 shown
});

test("graph: an edit without the agent's words is summed up from its text", () => {
  const doc = "# T\n\n## Sorular\n\n- a\n";
  assert.equal(summaryOf(doc, doc + "- **ANSWERED:** Tim'in maili\n"), "## Sorular · ANSWERED: Tim'in maili");
  assert.equal(summaryOf("## A\nx\ny\n", "## A\ny\n"), "## A · Removed: x");
  assert.equal(summaryOf("a\n", "a\n"), "No change");
});

test("graph: accepting one edit takes in its lines only, the other edit stays open", () => {
  // #1 added "x" after a, #2 changed "m" to "M" and deleted "z".
  const copy = "a\nb\nm\nz\n";
  const e1 = { before: copy, after: "a\nx\nb\nm\nz\n" };
  const e2 = { before: e1.after, after: "a\nx\nb\nM\n" };
  const current = e2.after;
  assert.equal(acceptEdit(copy, e1, current), e1.after);
  assert.equal(acceptEdit(copy, e2, current), "a\nb\nM\n");
  assert.equal(acceptEdit(acceptEdit(copy, e1, current), e2, current), current);
});

test("graph: a line put where an edit's line was deleted is not that edit's", () => {
  const e1 = { before: "a\nz\n", after: "a\nz\nold\n" };
  const current = "a\nz\nnew\n"; // "old" removed by hand, "new" written by a later edit
  assert.deepEqual(spotsOf(e1, current), []);
  assert.equal(acceptEdit("a\nz\n", e1, current), "a\nz\n");
});

test("graph: no history, empty graph", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  assert.deepEqual(graphRows(root), { rows: [], lanes: [], sessions: [] });
});

test("graph: one lane per task, not per session (#39)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  const h = path.join(root, ".claude/imprimatur/history");
  const write = (file, rows) => {
    fs.mkdirSync(path.dirname(path.join(h, file)), { recursive: true });
    fs.writeFileSync(path.join(h, `${file}.jsonl`), rows.map((r) => JSON.stringify({ tool: "Edit", before: "", ...r }) + "\n").join(""));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "x\n");
  };
  fs.mkdirSync(path.join(root, "todos/25"), { recursive: true });
  // Session s1 works on #25 (its TODO.md and, in the same turn, the README), then on #37 on its branch.
  write("todos/25/TODO.md", [{ t: "2026-10-06T10:00:00Z", session: "s1", prompt: "do 25" }]);
  fs.writeFileSync(path.join(root, "todos/25/TODO.md"), "# #25 · Agent setup\n");
  write("README.md", [
    { t: "2026-10-06T10:01:00Z", session: "s1", prompt: "do 25" },
    { t: "2026-10-06T11:00:00Z", session: "s1", prompt: "now the tick", branch: "fix/37-tick", before: "a\n" },
    // Session s2, later, on #25 again: the same lane as s1's #25.
    { t: "2026-10-06T12:00:00Z", session: "s2", prompt: "more on #25", before: "b\n" },
    // A turn with no clue at all.
    { t: "2026-10-06T13:00:00Z", session: "s2", prompt: "tidy up", branch: "main", before: "c\n" },
  ]);
  const { rows, lanes, sessions } = graphRows(root);
  assert.deepEqual(rows.map((r) => [r.file, r.session, r.task, r.lane]), [
    ["README.md", "s2", undefined, 0],
    ["README.md", "s2", "#25", 1],
    ["README.md", "s1", "#37", 2],
    ["README.md", "s1", "#25", 1],
    [path.join("todos", "25", "TODO.md"), "s1", "#25", 1],
  ]);
  assert.deepEqual(lanes, [{ first: 0, last: 0 }, { task: "#25", title: "Agent setup", first: 1, last: 4 }, { task: "#37", title: undefined, first: 2, last: 2 }]);
  assert.deepEqual(sessions.map((s) => s.session), ["s2", "s1"]);
});

test("graph: a task from its branch, a Jira key, or the Bash description (#39)", async () => {
  const { tasksOf, taskOfBranch } = createRequire(import.meta.url)("../vscode/graph.js");
  assert.equal(taskOfBranch("feat/39-task-lanes"), "#39");
  assert.equal(taskOfBranch("feature/LATD-13937-sync"), "LATD-13937");
  assert.equal(taskOfBranch("main"), undefined);
  assert.deepEqual(
    tasksOf([
      { file: "todos/LATD-12/TODO.md" },
      { file: "a.md", said: "Update notes for #41" },
      { file: "a.md", branch: "fix/37-x", prompt: "see #41" },
      { file: "todos/README.md" },
    ]),
    ["LATD-12", "#41", "#37", undefined],
  );
});
