import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { diff, wordDiff, acceptHunk } = createRequire(import.meta.url)("../vscode/diff.js");

test("identical text has no hunks", () => {
  assert.deepEqual(diff("a\nb\n", "a\nb\n"), []);
});

test("added line", () => {
  const h = diff("a\nc", "a\nb\nc");
  assert.deepEqual(h[0].marks, [{ kind: "added", line: 1 }]);
});

test("deleted block sits after the previous new line", () => {
  const h = diff("a\nx\ny\nc", "a\nc");
  assert.deepEqual(h[0].marks, [{ kind: "deleted", afterLine: 0, oldLines: ["x", "y"] }]);
  assert.equal(diff("x\na", "a")[0].marks[0].afterLine, -1); // deleted at the top
});

test("changed line marks only the changed word", () => {
  const h = diff("Sprint cumartesi başlar.", "Sprint pazartesi başlar.");
  const m = h[0].marks[0];
  assert.equal(m.kind, "changed");
  assert.deepEqual(m.inserted, [[7, 16]]); // "pazartesi"
  assert.deepEqual(m.deleted, [{ at: 7, text: "cumartesi" }]);
});

test("word diff: pure insertion and deletion at the end", () => {
  assert.deepEqual(wordDiff("a b", "a b c"), { inserted: [[3, 5]], deleted: [] });
  assert.deepEqual(wordDiff("a b c", "a b"), { inserted: [], deleted: [{ at: 3, text: " c" }] });
});

test("more new lines than old: pairs change, rest added", () => {
  const kinds = diff("a\nold\nz", "a\nnew1\nnew2\nz")[0].marks.map((m) => m.kind);
  assert.deepEqual(kinds, ["changed", "added"]);
});

test("accepting every hunk yields the new text", () => {
  const oldT = "a\nb\nc\nd\ne", newT = "a\nB\nc\ne\nf";
  let base = oldT;
  for (;;) {
    const h = diff(base, newT);
    if (!h.length) break;
    base = acceptHunk(base, newT, h[0]);
  }
  assert.equal(base, newT);
});
