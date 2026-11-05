import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { statsOf, dayOf, cachedRead, DAY } = require("../vscode/stats.js");

test("stats (#150): per-day series for a range; sessions' cost, time and tokens on the day they started", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-stats-"));
  const { sessionsFile } = require("../vscode/sessions.js");
  const now = new Date("2026-11-05T15:00:00").getTime();
  const f = sessionsFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [
    { session: "a", started: now - 1 * DAY, cost: 1.5, apiMs: 60000, tokens: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } },
    { session: "b", started: now - 1 * DAY, cost: 0.5, apiMs: 30000, tokens: { output: 10 } },
    { session: "c", started: now - 30 * DAY, cost: 9 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s = statsOf(root, { days: 3, now });
  assert.deepEqual(s.days, [dayOf(now - 2 * DAY), dayOf(now - DAY), dayOf(now)]);
  assert.deepEqual(s.series.sessions, [0, 2, 0]);
  assert.deepEqual(s.series.cost, [0, 2, 0], "a session out of the range is left out");
  assert.deepEqual(s.series.agentMs, [0, 90000, 0]);
  assert.deepEqual(s.series.tokens, [0, 20, 0]);
  for (const k of ["tasksDone", "tasksOpened", "decisions", "records", "edits", "asks"]) assert.equal(s.series[k].length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stats (#150): a file is read again only when it changed", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imp-cache-")), "x.jsonl");
  fs.writeFileSync(f, "a\n");
  let reads = 0;
  const parse = (t) => (reads++, t.trim());
  assert.equal(cachedRead(f, parse), "a");
  assert.equal(cachedRead(f, parse), "a");
  assert.equal(reads, 1, "the same version comes from the cache");
  fs.appendFileSync(f, "b\n");
  assert.equal(cachedRead(f, parse), "a\nb");
  assert.equal(reads, 2);
  assert.equal(cachedRead(path.join(path.dirname(f), "none"), parse), undefined);
});
