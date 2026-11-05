#!/usr/bin/env node
// Imprimatur's scoreboard for one repo (/imprimatur-stats): the last 7 days next to the 7
// before them, as ASCII bars. The numbers come from the stats module the panel uses too
// (vscode/stats.js, #150); this file only prints them. Read only.
// Usage: node stats.mjs [repo dir] [--days N]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fs.realpathSync(new URL(import.meta.url).pathname));
const lib = (m) => require(path.join(here, "..", "..", "vscode", m));
const { statsOf, median } = lib("stats.js");
const { gitRootOf } = lib("agent-setup.js");

const args = process.argv.slice(2);
const daysAt = args.indexOf("--days");
const DAYS = daysAt >= 0 ? Math.max(1, Number(args[daysAt + 1]) || 7) : 7;
const root = gitRootOf(path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--days") ?? process.cwd()));
const s = statsOf(root, { days: 2 * DAYS });

/** A period's total: the last DAYS days (now) or the DAYS before them. */
const sum = (xs, now) => (now ? xs.slice(DAYS) : xs.slice(0, DAYS)).reduce((a, b) => a + b, 0);
const rows = [
  ["Tasks finished", "tasksDone"], ["Tasks opened", "tasksOpened"], ["Decisions (ADR/PDR/decision)", "decisions"], ["Records written", "records"],
  ["Agent edits marked", "edits"], ["Turn-end asks recorded", "asks"], ["Your Claude sessions", "sessions"],
].map(([label, key]) => [label, sum(s.series[key], true), sum(s.series[key], false)]);

const W = 20;
const bar = (n, max) => {
  const k = max ? Math.round((n / max) * W) : 0;
  return "█".repeat(k) + "·".repeat(W - k);
};
const trend = (a, b) => (a === b ? "" : b === 0 ? "  new" : `  ${a > b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}%`);
const pad = (str, n) => (str + " ".repeat(n)).slice(0, n);
const out = ["", `  imprimatur stats        ${path.basename(root)} · last ${DAYS} days vs the ${DAYS} before`, "", `  ${pad("", 30)}${pad("now", W + 6)}before`];
for (const [label, a, b] of rows) {
  const max = Math.max(a, b);
  out.push(`  ${pad(label, 30)}${bar(a, max)} ${pad(String(a), 5)}${bar(b, max)} ${pad(String(b), 5)}${trend(a, b)}`);
}
const fmtH = (h) => (h === undefined ? "–" : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const cut = new Date(`${s.days[DAYS]}T00:00:00`).getTime();
const wait = (now) => median(s.answered.filter((a) => (now ? a.t >= cut : a.t < cut)).map((a) => a.hours));
const money = (n) => `$${n.toFixed(2)}`;
const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const hrs = (ms) => `${(ms / 3_600_000).toFixed(1)} h`;
out.push("", `  Cost                    ${money(sum(s.series.cost, true))}  (before: ${money(sum(s.series.cost, false))})`);
out.push(`    of it background agents ${money(sum(s.series.backgroundCost, true))} in ${sum(s.series.backgroundRuns, true)} runs (plugin reviews, claude -p)`);
out.push(`  Agent time (API)        ${hrs(sum(s.series.agentMs, true))}  (before: ${hrs(sum(s.series.agentMs, false))})`);
out.push(`  Tokens                  ${big(sum(s.series.tokens, true))}, ${big(sum(s.series.cacheRead, true))} of them cache reads  (before: ${big(sum(s.series.tokens, false))})`);
out.push("", `  Waiting on you now       ${s.waiting}`);
out.push(`  Median time to answer   ${fmtH(wait(true))}  (before: ${fmtH(wait(false))})`);
out.push(`  Tasks open or active    ${s.open}`);
if (s.hooks.length) {
  // Claude Code writes a hook run into the transcript only when it left output: the counts and the time are of those.
  out.push("", "  Last session's hooks (runs that left output in the transcript) · ms each · added");
  for (const h of s.hooks.slice(0, 6)) out.push(`    ${pad(h.label, 40)} ${h.summary}`);
}
out.push("");
console.log(out.join("\n"));
