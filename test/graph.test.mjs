import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { graphRows } = createRequire(import.meta.url)("../vscode/graph.js");

test("graph: all files' edits newest first, one lane per session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  const h = path.join(root, ".claude/agent-review/history");
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
    { session: "s2", first: 0, last: 0 },
    { session: "s1", first: 1, last: 2 },
  ]);
});

test("graph: no history, empty graph", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-graph-"));
  assert.deepEqual(graphRows(root), { rows: [], lanes: [] });
});
