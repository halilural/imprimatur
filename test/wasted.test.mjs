// Wasted edits (#212): what the agent replaced itself, and rewrite loops, from the graph's rows.
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { wastedEdits, TOKENS_PER_LINE } = createRequire(import.meta.url)("../vscode/wasted.js");
const NOW = Date.parse("2026-11-12T12:00:00Z");
const at = (/** @type {number} */ min) => new Date(NOW - 3600e3 + min * 60e3).toISOString();
const edit = (/** @type {Partial<any>} */ r) => ({ file: "a.js", session: "S1", tool: "Edit", added: 4, removed: 1, gone: false, ...r });

test("wasted edits: a gone edit the same session followed with another edit of the file counts; the rest do not", () => {
  const rows = [
    edit({ t: at(1), gone: true }), // replaced later in S1: wasted
    edit({ t: at(2), gone: true }), // last of a.js in S1: not counted
    edit({ file: "b.js", t: at(3), gone: true, session: "S2" }),
    edit({ file: "b.js", t: at(4), session: "S3" }), // another session's later edit: S2's is not wasted
    edit({ file: "c.js", t: at(5) }),
    edit({ file: "c.js", t: at(6) }), // surviving: not wasted
    edit({ t: at(-60 * 24 * 8), gone: true }), // 8 days old
    { ...edit({ t: at(7), gone: true }), activity: true },
  ];
  const w = wastedEdits(rows, { now: NOW });
  assert.deepEqual([w.edits, w.lines, w.tokens], [1, 4, 4 * TOKENS_PER_LINE]);
  assert.deepEqual(w.files.map((f) => [f.file, f.edits]), [["a.js", 1]]);
});

test("wasted edits: three changing edits in a row to one file are a rewrite loop; appends and other files between do not count", () => {
  const loop = [1, 2, 3].map((m) => edit({ file: "x.js", t: at(m) }));
  const appends = [4, 5, 6, 7].map((m) => edit({ file: "CHANGELOG.md", t: at(m), removed: 0 }));
  const broken = [edit({ file: "y.js", t: at(8) }), edit({ file: "y.js", t: at(9) }), edit({ file: "z.js", t: at(10) }), edit({ file: "y.js", t: at(11) })];
  assert.deepEqual(wastedEdits([...loop, ...appends, ...broken], { now: NOW }).rewrites, [{ file: "x.js", session: "S1", count: 3 }]);
});
