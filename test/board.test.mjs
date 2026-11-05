import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { boardModel, boardHtml, sparkline, heatmap, delta, fmtValue, BOARD_SCRIPT } = createRequire(import.meta.url)("../vscode/board.js");

const days = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 7, 8) + i * 86400e3).toISOString().slice(0, 10));
const series = (f) => days.map((_, i) => f(i));
const stats = {
  days, waiting: 5, sessionList: [{ session: "s1", prompt: "Ne <durumdayız>", started: 0, last: 3_600_000, cost: 1.5, tokens: 12_000, turns: 4, edits: 2 }],
  series: { tasksDone: series((i) => (i >= 83 ? 2 : 0)), decisions: series(() => 1), edits: series((i) => (i % 2 ? 3 : 0)), asks: series(() => 0), agentMs: series(() => 3_600_000),
    cost: series((i) => (i >= 83 ? 10 : 0)), tokens: series(() => 1000), records: series((i) => (i === 89 || i === 88 ? 1 : 0)), sessions: series(() => 0) },
};

test("board (#151): seven cards, the last 7 days next to the 7 before, each with a sparkline", () => {
  const b = boardModel(stats);
  assert.deepEqual(b.cards.map((c) => c.label), ["Tasks done", "Decisions", "Agent edits", "Waiting on you", "Agent time", "Cost", "Tokens"]);
  const done = b.cards[0];
  assert.deepEqual([done.now, done.before], [14, 0]);
  assert.equal(b.cards[3].now, 5, "waiting on you is now, not a sum");
  assert.equal(b.cards[5].now, 70);
  const html = boardHtml(b);
  assert.equal((html.match(/class="spark"/g) ?? []).length, 7);
  assert.match(html, /\$70\.00/);
  assert.match(html, /Ne &lt;durumdayız&gt;/, "a prompt is escaped");
  assert.match(html, /<th>Turns<\/th><th>Edits<\/th>/);
  assert.match(html, /id="board-data"/);
  assert.doesNotMatch(html, /<script(?! type="application\/json")/, "no script but the data");
});

test("board (#151): the heatmap has 12 weeks, active days and the streak; the helpers", () => {
  const h = heatmap(days, stats.series.records);
  assert.equal(h.days, 84);
  assert.equal((h.svg.match(/<rect/g) ?? []).length, 84);
  assert.equal(h.active, 2);
  assert.equal(h.streak, 2);
  assert.equal(heatmap(days, series(() => 0)).streak, 0);
  assert.equal(delta(12, 10), "▲ 20%");
  assert.equal(delta(5, 0), "new");
  assert.equal(delta(3, 3), "");
  assert.equal(fmtValue(7_200_000, "h"), "2.0 h");
  assert.equal(fmtValue(1_500_000, "k"), "1.5M");
  assert.match(sparkline([0, 1, 2]), /^<svg class="spark"/);
  assert.equal(sparkline([]), "");
  assert.ok(!/require\(|import /.test(BOARD_SCRIPT), "the page script uses no library");
});
