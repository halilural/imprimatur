// #114: what a write under .claude/imprimatur/ redraws, and one redraw per burst.
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { routeOf, trailing } = require("../vscode/refresh-route.js");

test("refresh route: copies and history redraw everything, the graph's inputs the graph, bookkeeping nothing", () => {
  const root = path.resolve("/r");
  const at = (...p) => path.join(root, ".claude", "imprimatur", ...p);
  assert.equal(routeOf(root, at("baseline", "README.md")), "edits");
  assert.equal(routeOf(root, at("history", "docs", "a.md.jsonl")), "edits");
  for (const p of [at("waiting", "s1.jsonl"), at("activity", "s1.jsonl"), at("descriptions.jsonl"), at("calls.jsonl"), at("something-new.json")]) assert.equal(routeOf(root, p), "graph", p);
  for (const p of [at("pending", "x.json"), at("process.json"), at("open-edits.json"), at("archive", "2026-10", "h.jsonl"), at("docs-backup", "A.md"), at("todo-done.json"), at("scanned.json"), at("setup-history.json")]) assert.equal(routeOf(root, p), "none", p);
  assert.equal(routeOf(root, path.join(root, "src", "a.js")), "none");
  assert.equal(routeOf(root, at()), "none");
});

test("refresh route: trailing runs once after a burst, and at least every maxWait while it lasts", () => {
  let t = 0;
  /** @type {Array<{at: number, fn: () => void, id: number}>} */
  let timers = [];
  let id = 0;
  const set = (fn, ms) => (timers.push({ at: t + ms, fn, id: ++id }), id);
  const clear = (x) => (timers = timers.filter((y) => y.id !== x));
  const tick = (ms) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      t = next.at;
      clear(next.id);
      next.fn();
    }
    t = end;
  };
  let runs = 0;
  const call = trailing(() => runs++, { wait: 300, maxWait: 2000, now: () => t, set: /** @type {any} */ (set), clear: /** @type {any} */ (clear) });
  // 20 tool calls 50 ms apart: one run, 300 ms after the last.
  for (let i = 0; i < 20; i++) {
    call();
    tick(50);
  }
  assert.equal(runs, 0, "not while the burst lasts (under maxWait)");
  tick(300);
  assert.equal(runs, 1);
  // A burst longer than maxWait still draws, about every 2 s.
  runs = 0;
  for (let i = 0; i < 100; i++) {
    call();
    tick(50);
  }
  tick(300);
  assert.ok(runs >= 2 && runs <= 4, `runs ${runs}`);
  // cancel drops a pending run; flush runs it now.
  runs = 0;
  call();
  call.cancel();
  tick(1000);
  assert.equal(runs, 0);
  call();
  call.flush();
  assert.equal(runs, 1);
});
