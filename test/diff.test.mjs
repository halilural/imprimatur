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

test("CRLF and LF compare equal", () => {
  assert.deepEqual(diff("a\r\nb\r\n", "a\nb\n"), []);
});

test("past the size cap the middle is one replaced block", () => {
  const big = (p) => Array.from({ length: 2100 }, (_, i) => p + i).join("\n");
  const h = diff(big("x"), big("y"));
  assert.equal(h.length, 1);
  assert.equal(h[0].oldEnd - h[0].oldStart, 2100);
});

test("review: staged rounds dim, new round bright (C1, C2 staged; C3 new)", () => {
  const { review } = createRequire(import.meta.url)("../vscode/diff.js");
  const base = "a\n";
  const staged = "a\nC1\nC2\n";
  const current = "a\nC1\nC2\nC3\n";
  const marks = review(base, staged, current).flatMap((h) => h.marks.map((m) => [m.line, m.fresh]));
  assert.deepEqual(marks, [[1, false], [2, false], [3, true]]);
});

test("review: file not in the index is all fresh", () => {
  const { review } = createRequire(import.meta.url)("../vscode/diff.js");
  assert.ok(review("", undefined, "x\ny").every((h) => h.fresh));
});

test("one word changed: word marks; several words: whole line", () => {
  const { lineOrWordDiff } = createRequire(import.meta.url)("../vscode/diff.js");
  assert.deepEqual(lineOrWordDiff("Sprint cumartesi başlar.", "Sprint pazartesi başlar."), {
    inserted: [[7, 16]],
    deleted: [{ at: 7, text: "cumartesi" }],
  });
  const oldL = "7. Clinician side: what triggers an alert, and where is it stored?";
  const newL = "7. Alerts: what does the device flag, and who sets the threshold?";
  assert.deepEqual(lineOrWordDiff(oldL, newL), { inserted: [[0, newL.length]], deleted: [{ at: 0, text: `${oldL} ` }], whole: true });
  // indented: old sentence goes after the indent
  assert.deepEqual(lineOrWordDiff("  a b c", "  x y z").deleted, [{ at: 2, text: "a b c " }]);
});

test("changes inside fenced code blocks are not marked", () => {
  const { review, codeLines } = createRequire(import.meta.url)("../vscode/diff.js");
  const base = "intro\n\n```js\nconst a = 1;\n```\n\n~~~\nold\nkeep\n~~~\nend\n";
  const current = "intro changed\n\n```js\nconst a = 2;\nconst b = 3;\n```\n\n~~~\nkeep\n~~~\nend\n";
  const marks = review(base, undefined, current).flatMap((h) => h.marks.map((m) => [m.kind, m.line ?? m.afterLine]));
  assert.deepEqual(marks, [["changed", 0]]); // only the prose line; code edits and the deleted code line are skipped
  assert.deepEqual([...codeLines("a\n````\nx\n```\ny\n````\nb")], [1, 2, 3, 4, 5]); // closing fence must be as long
});

test("accepting one block takes only its lines, not the whole hunk", () => {
  const { acceptLines, diff } = createRequire(import.meta.url)("../vscode/diff.js");
  // The agent added a list item with an English and a Turkish paragraph: one hunk.
  const base = "- x\n\n  X\n\n- y\n";
  const cur = "- x\n\n  X\n\n- new en\n\n  yeni tr\n\n- y\n";
  assert.equal(diff(base, cur).length, 1);
  const copy = acceptLines(base, cur, 4, 5); // only "- new en"
  const left = diff(copy, cur).flatMap((h) => h.marks.map((m) => [m.kind, m.line]));
  assert.deepEqual(left, [["added", 6], ["added", 7]]); // the Turkish paragraph (and its blank) still to review
  assert.equal(acceptLines(copy, cur, 6, 7), cur); // accepting it too reaches the new text
});

test("accepting a changed line leaves the other changed lines", () => {
  const { acceptLines, diff } = createRequire(import.meta.url)("../vscode/diff.js");
  const base = "one\ntwo\nthree\n";
  const cur = "ONE\nTWO\nthree\n";
  const copy = acceptLines(base, cur, 0, 1);
  assert.equal(copy, "ONE\ntwo\nthree\n");
  assert.deepEqual(diff(copy, cur).flatMap((h) => h.marks.map((m) => m.line)), [1]);
});

test("accepting at a deletion removes only that deletion", () => {
  const { acceptLines } = createRequire(import.meta.url)("../vscode/diff.js");
  const base = "a\ngone\nb\n\nc\nalso gone\nd\n";
  const cur = "a\nb\n\nc\nd\n";
  assert.equal(acceptLines(base, cur, 0, 1), "a\nb\n\nc\nalso gone\nd\n");
});

test("adjacent list items (one hunk): accepting one line leaves its neighbours", () => {
  const { acceptLines, diff } = createRequire(import.meta.url)("../vscode/diff.js");
  const copy = acceptLines("- a\n- b\n- c\n", "- A\n- B\n- C\n", 1, 2);
  assert.equal(copy, "- a\n- B\n- c\n");
  assert.deepEqual(diff(copy, "- A\n- B\n- C\n").flatMap((h) => h.marks.map((m) => m.line)), [0, 2]);
});
