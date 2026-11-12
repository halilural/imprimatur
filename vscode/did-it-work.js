// @ts-check
// Did it work? (#217): for each recent change to an agent rule or skill file, the 7 days before next
// to the 7 days after: output tokens per turn (Claude Code's transcripts, ticket-tokens.js) and asks
// to the user per turn (turn-end asks, waiting.js). A correlation, not proof: other things change in
// the same week. A side with no turn has no number. No model call.
"use strict";
const { spawnSync } = require("node:child_process");

const WINDOW = 7;
const DAY = 86_400_000;
const PATHS = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", ".claude/rules", ".claude/skills", "skills", ".cursor/rules"];

/** The commits that changed a rule or skill file in the last `days`, newest first. @param {string} root @param {number} [days] */
function ruleChanges(root, days = 60) {
  const r = spawnSync("git", ["log", `--since=${days}.days`, "--no-merges", "--name-only", "--format=%x1e%h%x09%ct%x09%s", "--", ...PATHS], { cwd: root, encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) return [];
  return r.stdout.split("\x1e").slice(1).map((chunk) => {
    const [head, ...files] = chunk.split("\n").filter(Boolean);
    const [hash, ct, ...subject] = head.split("\t");
    // A skill counts by its SKILL.md; other files in a skill's folder (scripts, notices) are not rules.
    const rules = files.filter((f) => !f.startsWith("skills/") || f.endsWith("/SKILL.md"));
    return { hash, at: Number(ct) * 1000, subject: subject.join("\t"), files: rules };
  }).filter((c) => c.files.length);
}

/**
 * The two windows around a change, from daily usage and the asks' times. Pure.
 * @param {Map<string, {turns: number, output: number}>} days per UTC day @param {number[]} asks the asks' times (ms)
 * @param {number} at the change's time @param {number} now
 */
function compare(days, asks, at, now) {
  const side = (/** @type {number} */ from, /** @type {number} */ to) => {
    let turns = 0, output = 0;
    for (const [d, v] of days) {
      const t = Date.parse(`${d}T12:00:00Z`);
      if (t >= from && t < to) {
        turns += v.turns;
        output += v.output;
      }
    }
    const n = asks.filter((t) => t >= from && t < to).length;
    return turns ? { turns, tokensPerTurn: Math.round(output / turns), asksPerTurn: Math.round((n / turns) * 100) / 100 } : undefined;
  };
  // Whole UTC days, as the daily usage is counted: the change's day starts the after window.
  const day = Math.floor(at / DAY) * DAY;
  const before = side(day - WINDOW * DAY, day);
  const after = side(day, Math.min(Math.floor(now / DAY) * DAY + DAY, day + WINDOW * DAY));
  const pct = (/** @type {number | undefined} */ a, /** @type {number | undefined} */ b) => (a && b !== undefined ? Math.round(((b - a) / a) * 100) : undefined);
  return { before, after, tokens: pct(before?.tokensPerTurn, after?.tokensPerTurn), asks: pct(before?.asksPerTurn, after?.asksPerTurn) };
}

/**
 * The latest rule and skill changes of a repo with both windows.
 * @param {string} root @param {{now?: number, limit?: number}} [o]
 */
function didItWork(root, { now = Date.now(), limit = 8 } = {}) {
  // One row per day: changes on the same day share both windows.
  /** @type {Map<string, Array<ReturnType<typeof ruleChanges>[number]>>} */
  const byDay = new Map();
  for (const c of ruleChanges(root)) {
    const d = new Date(c.at).toISOString().slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), c]);
  }
  const groups = [...byDay].slice(0, limit);
  if (!groups.length) return [];
  const tt = require("./ticket-tokens.js");
  const days = tt.dailyUsage(tt.projectDirOf(root));
  const asks = require("./waiting.js").waitingItems(root).filter((i) => i.kind === "question" || i.kind === "verify").map((i) => Date.parse(i.t)).filter(Number.isFinite);
  return groups.map(([day, changes]) => ({ day, changes, ...compare(days, asks, Date.parse(`${day}T00:00:00Z`), now) }));
}

module.exports = { didItWork, ruleChanges, compare, WINDOW };
