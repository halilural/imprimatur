#!/usr/bin/env node
// Imprimatur's scoreboard for one repo (/imprimatur-stats): the last 7 days next to the 7
// before them, as ASCII bars, from the database, the review data and the last session's
// transcript. Read only. Usage: node stats.mjs [repo dir] [--days N]
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fs.realpathSync(new URL(import.meta.url).pathname));
const lib = (m) => require(path.join(here, "..", "..", "vscode", m));
const { openDb } = lib("db.js");
const { dataPath } = lib("data-dir.js");
const { waitingItems, waitingSteps, itemsOf } = lib("waiting.js");
const { inboxCount } = lib("tasksView.js");
const { gitRootOf, projectSlug } = lib("agent-setup.js");
const { sessionItems } = lib("session-context.js");

const args = process.argv.slice(2);
const daysAt = args.indexOf("--days");
const DAYS = daysAt >= 0 ? Math.max(1, Number(args[daysAt + 1]) || 7) : 7;
const root = gitRootOf(path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--days") ?? process.cwd()));
const now = Date.now();
const span = DAYS * 86_400_000;
const inNow = (t) => t > now - span && t <= now;
const inBefore = (t) => t > now - 2 * span && t <= now - span;

const db = openDb();
const repo = db.repoByRoot?.(root) ?? db.repoOf(root);
const q = (sql, ...p) => db.sqlite.prepare(sql).all(...p);
const tasks = q("SELECT status, created_at, updated_at FROM tasks WHERE repo_id = ?", repo.id);
const records = q("SELECT r.kind, r.status, r.created_at, r.updated_at FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ?", repo.id);

/** Agent edits marked for review: one history line per edit, with its time; archived days (gzipped) count too. */
function edits() {
  const data = dataPath(root, path.join(".claude", "imprimatur"));
  const times = [];
  const walk = (d) => {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.gz"))
        for (const l of (e.name.endsWith(".gz") ? zlib.gunzipSync(fs.readFileSync(p)) : fs.readFileSync(p)).toString("utf8").split("\n")) {
          const t = Date.parse(/"t":"([^"]+)"/.exec(l)?.[1] ?? "");
          if (t) times.push(t);
        }
    }
  };
  walk(path.join(data, "history"));
  let days = [];
  try { days = fs.readdirSync(path.join(data, "archive")); } catch { /* no archive yet */ }
  // Only the days that can hold the two periods: an archive day is named by when it was archived.
  for (const day of days) if (Date.parse(day) > now - 3 * span) walk(path.join(data, "archive", day, "history"));
  return times;
}

const count = (list, pick, when) => list.filter((x) => when(pick(x))).length;
const editTimes = edits();
/** Turn-end asks: the live logs and the archived (gzipped) ones; the same item in both counts once. */
function allAsks() {
  const data = dataPath(root, path.join(".claude", "imprimatur"));
  const byKey = new Map(waitingItems(root).map((a) => [`${a.session}|${a.t}`, a]));
  let days = [];
  try { days = fs.readdirSync(path.join(data, "archive")); } catch { /* no archive yet */ }
  for (const day of days) {
    if (!(Date.parse(day) > now - 3 * span)) continue;
    const dir = path.join(data, "archive", day, "waiting");
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl.gz")); } catch { continue; }
    for (const n of names) {
      const recs = zlib.gunzipSync(fs.readFileSync(path.join(dir, n))).toString("utf8").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      for (const a of itemsOf(recs, n.replace(/\.jsonl\.gz$/, ""))) if (!byKey.has(`${a.session}|${a.t}`)) byKey.set(`${a.session}|${a.t}`, a);
    }
  }
  return [...byKey.values()];
}
const asks = allAsks();
const answered = asks.filter((a) => !a.open && a.answeredAt);
const waitHours = (when) => {
  const w = answered.filter((a) => when(Date.parse(a.t))).map((a) => (Date.parse(a.answeredAt) - Date.parse(a.t)) / 3_600_000).filter((h) => h >= 0).sort((a, b) => a - b);
  return w.length ? w[Math.floor(w.length / 2)] : undefined;
};

const rows = [
  ["Tasks finished", count(tasks.filter((t) => t.status === "done"), (t) => t.updated_at, inNow), count(tasks.filter((t) => t.status === "done"), (t) => t.updated_at, inBefore)],
  ["Tasks opened", count(tasks, (t) => t.created_at, inNow), count(tasks, (t) => t.created_at, inBefore)],
  ["Decisions (ADR/PDR/decision)", count(records.filter((r) => ["adr", "pdr", "decision"].includes(r.kind)), (r) => r.created_at, inNow), count(records.filter((r) => ["adr", "pdr", "decision"].includes(r.kind)), (r) => r.created_at, inBefore)],
  ["Records written", count(records, (r) => r.created_at, inNow), count(records, (r) => r.created_at, inBefore)],
  ["Agent edits marked", count(editTimes, (t) => t, inNow), count(editTimes, (t) => t, inBefore)],
  ["Turn-end asks recorded", count(asks, (a) => Date.parse(a.t), inNow), count(asks, (a) => Date.parse(a.t), inBefore)],
];

const W = 20;
const bar = (n, max) => {
  const k = max ? Math.round((n / max) * W) : 0;
  return "█".repeat(k) + "·".repeat(W - k);
};
const trend = (a, b) => (a === b ? "" : b === 0 ? "  new" : `  ${a > b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}%`);
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
const out = [];
out.push("", `  imprimatur stats        ${path.basename(root)} · last ${DAYS} days vs the ${DAYS} before`, "");
out.push(`  ${pad("", 30)}${pad("now", W + 6)}before`);
for (const [label, a, b] of rows) {
  const max = Math.max(a, b);
  out.push(`  ${pad(label, 30)}${bar(a, max)} ${pad(String(a), 5)}${bar(b, max)} ${pad(String(b), 5)}${trend(a, b)}`);
}
const fmtH = (h) => (h === undefined ? "–" : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
// The same count as the Home badge.
out.push("", `  Waiting on you now       ${inboxCount(db, root, waitingSteps(root))}`);
out.push(`  Median time to answer   ${fmtH(waitHours(inNow))}  (before: ${fmtH(waitHours(inBefore))})`);
const open = tasks.filter((t) => t.status === "open" || t.status === "active").length;
out.push(`  Tasks open or active    ${open}`);

// The last session: what its hooks cost and what they added (session-context.js).
const home = os.homedir();
const hooks = sessionItems(path.join(home, ".claude", "projects", projectSlug(root)), home).filter((r) => r.kind === "hook output");
if (hooks.length) {
  out.push("", "  Last session's hooks     runs · ms each · added");
  for (const h of hooks.slice(0, 6)) out.push(`    ${pad(h.label, 40)} ${h.summary}`);
}
out.push("");
console.log(out.join("\n"));
