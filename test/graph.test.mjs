import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { graphRows, previewOf, summaryOf, acceptEdit } = createRequire(import.meta.url)("../vscode/graph.js");

test("graph: all files' edits newest first, one lane per session", () => {
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
      [path.join("docs", "b.md"), 1, "second", 1, 1],
      ["a.md", 1, "first", 1, 1],
    ],
  );
  assert.deepEqual(lanes, [
    { session: "s2", title: undefined, first: 0, last: 0 },
    { session: "s1", title: undefined, first: 1, last: 2 },
  ]);
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

test("graph: no history, empty graph", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  assert.deepEqual(graphRows(root), { rows: [], lanes: [] });
});
