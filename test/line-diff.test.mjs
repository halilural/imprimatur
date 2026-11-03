// #115 step 2: line diffs from the host's last page to the new one, applied on the page.
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { diffLines, applyOps, opsSize } = require("../vscode/line-diff.js");

test("line diff: random edits round-trip, the ops carry only the new lines", () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rnd(60) }, (_, i) => `line ${i} ${rnd(5)}`);
    const b = a.slice();
    for (let e = rnd(8); e > 0; e--) {
      const at = rnd(b.length + 1);
      const what = rnd(3);
      if (what === 0) b.splice(at, 0, `new ${round} ${e}`);
      else if (what === 1 && b.length) b.splice(at % b.length, 1);
      else if (b.length) b[at % b.length] = `changed ${round} ${e}`;
    }
    const ops = diffLines(a, b);
    assert.ok(ops, "within maxD");
    assert.deepEqual(applyOps(a, ops), b, `round ${round}`);
    const inserted = ops.flatMap(([, , ins]) => ins);
    assert.ok(inserted.every((l) => b.includes(l)));
  }
});

test("line diff: equal pages need no ops; one changed line in a big page is a small op", () => {
  const page = Array.from({ length: 4000 }, (_, i) => `<tr data-i="${i}"><td>row ${i} ${"x".repeat(200)}</td></tr>`);
  assert.deepEqual(diffLines(page, page.slice()), []);
  const b = page.slice();
  b[10] = "<nav>3 waiting</nav>";
  b.splice(20, 0, '<tr data-i="4000"><td>a new row</td></tr>');
  b[3990] = '"3990": {"preview": "<p>changed</p>"}';
  const ops = diffLines(page, b);
  assert.deepEqual(applyOps(page, ops), b);
  assert.ok(opsSize(ops) < 500, `ops ${opsSize(ops)} chars`);
});

test("line diff: too many differences give up (the host sends the whole page)", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  assert.equal(diffLines(a, b, 100), undefined);
  assert.deepEqual(applyOps(a, diffLines(a, b, 7000)), b, "with a bound high enough it still works");
});

test("line diff: applyOps runs from its source text, as the page inlines it", () => {
  const fn = new Function(`return (${applyOps.toString()})`)();
  const a = ["one", "two", "three"];
  const b = ["zero", "one", "three", "four"];
  assert.deepEqual(fn(a, diffLines(a, b)), b);
});
