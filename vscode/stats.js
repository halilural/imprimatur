// @ts-check
// One stats module (#150): per-day series for a repo over a range, for the panel's board (#151,
// #152) and /imprimatur-stats (skills/imprimatur-stats/stats.mjs prints them). Series: tasks
// done and opened, decisions, records, agent edits, turn-end asks, the median time to answer,
// sessions, agent (API) time, cost and tokens (#149). Each log file is read once per version
// (its size and mtime): a second call reads only the files that changed.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const DAY = 86_400_000;
/** The local day of a time, YYYY-MM-DD. @param {number} t */
const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** @type {Map<string, {v: string, value: any}>} what was read from each file, by its version */
const fileCache = new Map();
/**
 * A file's parsed content, read again only when its size or mtime changed.
 * @template T @param {string} file @param {(text: string) => T} parse @returns {T | undefined}
 */
function cachedRead(file, parse) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return undefined;
  }
  const v = `${st.size}:${st.mtimeMs}`;
  const hit = fileCache.get(file);
  if (hit?.v === v) return hit.value;
  let value;
  try {
    const raw = fs.readFileSync(file);
    value = parse((file.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8"));
  } catch {
    value = undefined;
  }
  fileCache.set(file, { v, value });
  return value;
}

/** Every file under dir, recursively. @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The times of the agent edits marked for review: one history line each, the archive's too. @param {string} data the repo's data folder @param {number} since */
function editTimes(data, since) {
  const files = [...filesUnder(path.join(data, "history"))];
  let days = [];
  try {
    days = fs.readdirSync(path.join(data, "archive"));
  } catch {}
  // An archive day is named by when it was archived: only the days that can hold the range.
  for (const day of days) if (Date.parse(day) > since - DAY) files.push(...filesUnder(path.join(data, "archive", day, "history")));
  return files.filter((f) => /\.jsonl(\.gz)?$/.test(f)).flatMap((f) => cachedRead(f, (text) => text.split("\n").map((l) => Date.parse(/"t":"([^"]+)"/.exec(l)?.[1] ?? "")).filter(Boolean)) ?? []);
}

/** Turn-end asks: the live logs and the archived ones; the same item in both counts once. @param {string} root @param {string} data @param {number} since */
function askItems(root, data, since) {
  const { waitingItems, itemsOf } = require("./waiting.js");
  const byKey = new Map(waitingItems(root).map((/** @type {any} */ a) => [`${a.session}|${a.t}`, a]));
  let days = [];
  try {
    days = fs.readdirSync(path.join(data, "archive"));
  } catch {}
  for (const day of days) {
    if (!(Date.parse(day) > since - DAY)) continue;
    const dir = path.join(data, "archive", day, "waiting");
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl.gz"));
    } catch {
      continue;
    }
    for (const n of names) {
      const items = cachedRead(path.join(dir, n), (text) => itemsOf(text.split("\n").flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      }), n.replace(/\.jsonl\.gz$/, ""))) ?? [];
      for (const a of items) if (!byKey.has(`${a.session}|${a.t}`)) byKey.set(`${a.session}|${a.t}`, a);
    }
  }
  return [...byKey.values()];
}

/** The median of numbers, undefined for none. @param {number[]} xs */
const median = (xs) => {
  const s = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};

/**
 * The repo's per-day series for the days ending today (#150).
 * @param {string} root the repo @param {{days?: number, now?: number, db?: any}} [o]
 * @returns {{days: string[], series: Record<string, number[]>, answerHours: Array<number | undefined>, answered: Array<{t: number, hours: number}>, open: number, waiting: number, hooks: any[]}}
 */
function statsOf(root, { days = 7, now = Date.now(), db } = {}) {
  db ??= require("./db.js").openDb();
  const data = require("./data-dir.js").dataPath(root, path.join(".claude", "imprimatur"));
  const list = Array.from({ length: days }, (_, i) => dayOf(now - (days - 1 - i) * DAY));
  const index = new Map(list.map((d, i) => [d, i]));
  const since = new Date(`${list[0]}T00:00:00`).getTime();
  const zero = () => list.map(() => 0);
  /** @type {Record<string, number[]>} */
  const series = { tasksDone: zero(), tasksOpened: zero(), decisions: zero(), records: zero(), edits: zero(), asks: zero(), sessions: zero(), agentMs: zero(), cost: zero(), tokens: zero(), cacheRead: zero(), backgroundCost: zero(), backgroundRuns: zero() };
  /** @param {string} key @param {number} t @param {number} [n] */
  const add = (key, t, n = 1) => {
    if (!(t <= now)) return;
    const i = index.get(dayOf(t));
    if (i !== undefined) series[key][i] += n;
  };
  const repo = db.repoByRoot?.(root) ?? db.repoOf(root);
  const q = (/** @type {string} */ sql, /** @type {any[]} */ ...p) => db.sqlite.prepare(sql).all(...p);
  // done_at (#150) where the schema has it; a task pulled done from another machine may have none.
  const tasks = repo ? q("SELECT * FROM tasks WHERE repo_id = ?", repo.id) : [];
  const records = repo ? q("SELECT r.kind, r.created_at FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? AND r.created_at >= ?", repo.id, since) : [];
  for (const t of tasks) {
    if (t.status === "done") add("tasksDone", t.done_at ?? t.updated_at);
    add("tasksOpened", t.created_at);
  }
  for (const r of records) {
    add("records", r.created_at);
    if (["adr", "pdr", "decision"].includes(r.kind)) add("decisions", r.created_at);
  }
  for (const t of editTimes(data, since)) add("edits", t);
  const asks = askItems(root, data, since);
  for (const a of asks) add("asks", Date.parse(a.t));
  const answered = asks.filter((a) => !a.open && a.answeredAt).map((a) => ({ t: Date.parse(a.t), hours: (Date.parse(a.answeredAt) - Date.parse(a.t)) / 3_600_000 })).filter((a) => a.hours >= 0);
  const answerHours = list.map((d) => median(answered.filter((a) => dayOf(a.t) === d).map((a) => a.hours)));
  // Sessions (#149): from each transcript's cost points (Claude Code's running totals, written in
  // VS Code too, where the status line does not run). A point's growth over the one before it
  // goes to the day of that point, so a session that runs for days spreads over them. A total
  // that drops (a resumed session restores a slightly older state: 50.71 → 48.60) adds nothing
  // there, and growth counts on from the lower value. The status line's rows fill in sessions whose
  // transcript has no points.
  const { transcriptCost, readSessions } = require("./sessions.js");
  const { gitRootOf: gr, projectSlug: ps } = require("./agent-setup.js");
  const projectDir = path.join(require("node:os").homedir(), ".claude", "projects", ps(gr(root)));
  let transcripts = [];
  try {
    transcripts = fs.readdirSync(projectDir).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(projectDir, n))
      .filter((f) => fs.statSync(f).mtimeMs >= since);
  } catch {}
  const seen = new Set();
  const tok = (/** @type {any} */ k) => (k.input || 0) + (k.output || 0) + (k.cacheWrite || 0) + (k.cacheRead || 0);
  for (const f of transcripts) {
    const { points, prompts } = cachedRead(f, transcriptCost) ?? { points: [], prompts: 0 };
    // The user's own sessions count as sessions; a one-prompt run is a background agent, its cost apart.
    const mine = prompts >= 2;
    let prev = { cost: 0, apiMs: 0, tokens: 0, cacheRead: 0 };
    for (const p of points) {
      if (p.session && !seen.has(p.session)) {
        seen.add(p.session);
        if (mine) add("sessions", p.started || p.t);
      }
      if (!mine) {
        add("backgroundCost", p.t, Math.max(0, p.cost - prev.cost));
        add("backgroundRuns", p.t, prev.cost === 0 && p === points[0] ? 1 : 0);
      }
      const cur = { cost: p.cost, apiMs: p.apiMs, tokens: tok(p.tokens), cacheRead: p.tokens.cacheRead };
      for (const [k, key] of /** @type {const} */ ([["cost", "cost"], ["apiMs", "agentMs"], ["tokens", "tokens"], ["cacheRead", "cacheRead"]]))
        add(key, p.t, Math.max(0, cur[k] - prev[k]));
      prev = cur;
    }
  }
  for (const s of readSessions(root)) {
    if (seen.has(s.session)) continue;
    const t = Number(s.started ?? s.at);
    add("sessions", t);
    add("agentMs", t, Number(s.apiMs) || 0);
    add("cost", t, Number(s.cost) || 0);
    add("tokens", t, tok(s.tokens ?? {}));
    add("cacheRead", t, Number(s.tokens?.cacheRead) || 0);
  }
  const open = tasks.filter((t) => t.status === "open" || t.status === "active").length;
  // What waits on the user now (the Home badge's count) and the last session's hooks.
  const waiting = require("./tasksView.js").inboxCount(db, root, require("./waiting.js").waitingSteps(root));
  const { gitRootOf, projectSlug } = require("./agent-setup.js");
  const home = require("node:os").homedir();
  const hooks = require("./session-context.js").sessionItems(path.join(home, ".claude", "projects", projectSlug(gitRootOf(root))), home).filter((/** @type {any} */ r) => r.kind === "hook output");
  return { days: list, series, answerHours, answered, open, waiting, hooks };
}

module.exports = { statsOf, dayOf, median, cachedRead, DAY };
