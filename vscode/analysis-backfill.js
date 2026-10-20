// @ts-check
// A task's analysis from before the hook ran (TASK-ANALYSIS): Claude Code's transcripts of the
// repo (~/.claude/projects/<slug>*, subagents too) hold every Write's text and every Edit's
// old and new string. Each Markdown file's states are replayed in time order: a Write sets the
// text, an Edit changes the text known so far (an Edit with no known text, or whose old string
// is not in it, loses the thread until the next Write). Each state is one version of the
// file's sections, dated when it was written. Then the files in the repo now that the path or
// headings call analyses (docs/research, spikes, todos/<key>/…), whose text is the newest.
// Only states newer than what the document already took from a file are replayed, so a run
// after the hook does not set a file back. Once per repo in the background (SessionStart),
// or by hand: npm run analysis.
"use strict";
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const a = require("./analysis.js");
const { transcriptsOf, slugOf } = require("./history.js");

const ACTOR = { kind: "import", id: "transcript" };
/** Model calls per run, at most: the rest wait for the next run. */
const MAX_MODEL = 300;
const metaKey = (/** @type {number} */ repoId) => `analysis-backfill:${repoId}`;

/** @typedef {{at: number, text: string, session?: string, branch?: string, prompt?: string}} State */

/** The repo's transcripts and their subagents'. @param {string} root @param {string} [home] */
function transcripts(root, home) {
  const top = transcriptsOf(root, home);
  const subs = top.flatMap((f) => {
    const dir = path.join(f.replace(/\.jsonl$/, ""), "subagents");
    try {
      return fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  });
  return [...top, ...subs];
}

/**
 * Every Markdown write and edit in the transcripts, by absolute file, in time order.
 * @param {string[]} files @returns {Map<string, Array<{at: number, session?: string, branch?: string, prompt?: string, op: any}>>}
 */
function eventsOf(files) {
  /** @type {Map<string, any[]>} */
  const out = new Map();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let prompt;
    for (const line of text.split("\n")) {
      if (!line.includes('"toolUseResult"') && !line.includes('"type":"user"')) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const content = r.message?.content;
      if (r.type === "user" && !r.isMeta && typeof content === "string") prompt = content.slice(0, 2000);
      else if (r.type === "user" && !r.isMeta && Array.isArray(content) && !content.some((b) => b?.type === "tool_result")) {
        prompt = content.filter((b) => b?.type === "text").map((b) => b.text).join("\n").slice(0, 2000) || prompt;
      }
      const t = r.toolUseResult;
      if (!t || typeof t !== "object" || typeof t.filePath !== "string" || !/\.mdx?$/i.test(t.filePath)) continue;
      const at = Date.parse(r.timestamp);
      if (!Number.isFinite(at)) continue;
      /** @type {any} */
      let op;
      if ((t.type === "create" || t.type === "update") && typeof t.content === "string") op = { write: t.content };
      else if (typeof t.oldString === "string" && typeof t.newString === "string") {
        op = { old: t.oldString, new: t.newString, all: Boolean(t.replaceAll), base: typeof t.originalFile === "string" ? t.originalFile : undefined };
      } else continue;
      const abs = path.resolve(r.cwd ?? "/", t.filePath);
      out.set(abs, [...(out.get(abs) ?? []), { at, session: r.sessionId, branch: r.gitBranch, prompt, op }]);
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.at - y.at);
  return out;
}

/**
 * A file's states from its events: each Write, and each Edit applied to the text known.
 * @param {Array<{at: number, session?: string, branch?: string, prompt?: string, op: any}>} events
 * @returns {{states: State[], lost: number}} lost: edits that could not be applied
 */
function replay(events) {
  /** @type {State[]} */
  const states = [];
  /** @type {string | undefined} */
  let text;
  let lost = 0;
  for (const e of events) {
    if (e.op.write !== undefined) text = e.op.write;
    else {
      const base = text ?? e.op.base;
      if (base === undefined || !base.includes(e.op.old)) {
        text = undefined;
        lost++;
        continue;
      }
      text = e.op.all ? base.split(e.op.old).join(e.op.new) : base.replace(e.op.old, () => e.op.new);
    }
    states.push({ at: e.at, text, session: e.session, branch: e.branch, prompt: e.prompt });
  }
  return { states, lost };
}

/** The repo's Markdown files git knows (tracked and new, not ignored). @param {string} root */
function repoFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "*.md", "*.mdx"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Replays the repo's past analyses into its tasks' documents.
 * @param {any} db @param {number} repoId @param {string} root
 * @param {{home?: string, transcriptsHome?: string, ask?: (p: string) => Promise<string>, model?: boolean, dryRun?: boolean, repoFiles?: boolean}} [o]
 * @returns {Promise<{files: number, ingested: number, versions: number, orphans: number, notAnalysis: number, unknown: number, lost: number, tasks: string[]}>}
 */
async function backfill(db, repoId, root, o = {}) {
  const home = o.home ?? os.homedir();
  const report = { files: 0, ingested: 0, versions: 0, orphans: 0, notAnalysis: 0, unknown: 0, lost: 0, tasks: /** @type {string[]} */ ([]) };
  const s = a.settingsOf(root);
  if (!s.on) return report;
  const tasks = new Set();
  let asked = 0;
  /** @type {Map<string, State[]>} by kept path */
  const byRel = new Map();
  for (const [abs, events] of eventsOf(transcripts(root, o.transcriptsHome))) {
    const rel = a.relPath(root, abs, home);
    if (!rel || !a.isCandidate(rel, undefined, s)) continue;
    const { states, lost } = replay(events);
    report.lost += lost;
    byRel.set(rel, [...(byRel.get(rel) ?? []), ...states]);
  }
  // Files in the repo now: their text is the newest state.
  const now = new Set(o.repoFiles === false ? [] : repoFiles(root));
  for (const rel of [...byRel.keys(), ...now]) {
    const file = a.absPath(root, rel, home);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > 2_000_000) continue;
    if (!byRel.has(rel) && !(a.isCandidate(rel, undefined, s) && a.heuristic(rel, "") === "yes")) continue;
    const text = fs.readFileSync(file, "utf8");
    const list = byRel.get(rel) ?? [];
    if (list.at(-1)?.text !== text) list.push({ at: Math.max(Math.floor(st.mtimeMs), (list.at(-1)?.at ?? 0) + 1), text });
    byRel.set(rel, list);
  }
  for (const [rel, states] of byRel) {
    if (!states.length) continue;
    report.files++;
    const last = /** @type {State} */ (states.at(-1));
    if (!a.isCandidate(rel, last.text, s)) continue;
    const allowed = o.model !== false && !o.dryRun && asked < MAX_MODEL;
    if (a.quickVerdict(db, repoId, rel, last.text) === undefined && allowed) asked++;
    const v = await a.verdictOf(db, repoId, rel, last.text, { ask: o.ask, model: allowed });
    if (v === "no") {
      report.notAnalysis++;
      continue;
    }
    if (v === undefined) {
      report.unknown++;
      continue;
    }
    const kept = db.sqlite.prepare(`SELECT d.id, d.scope FROM doc_sources x JOIN documents d ON d.id = x.doc_id
                                    WHERE d.repo_id = ? AND x.path = ? ORDER BY x.at DESC LIMIT 1`).get(repoId, rel);
    let task = kept?.scope;
    for (const st of [...states].reverse()) {
      if (task) break;
      task = a.taskFor(db, repoId, { rel, ...st });
    }
    if (!task) {
      report.orphans++;
      if (!o.dryRun) a.setOrphan(db, repoId, rel, last.at);
      continue;
    }
    tasks.add(task);
    report.ingested++;
    if (o.dryRun) {
      report.versions += states.length;
      continue;
    }
    a.setOrphan(db, repoId, rel, null);
    const doc = db.taskDocOf(repoId, task);
    const since = db.sqlite.prepare("SELECT at FROM doc_sources WHERE doc_id = ? AND path = ?").get(doc.id, rel)?.at ?? 0;
    for (const st of states) {
      if (st.at <= since) continue;
      const r = a.ingest(db, repoId, task, rel, st.text, { actor: ACTOR, at: st.at });
      if (!r.unchanged) report.versions++;
    }
  }
  report.tasks = [...tasks].sort();
  return report;
}

/** A report in one line. @param {Awaited<ReturnType<typeof backfill>>} r */
const summary = (r) =>
  `${r.ingested} analysis files into ${r.tasks.length} tasks (${r.versions} versions)` +
  `${r.orphans ? `, ${r.orphans} with no task` : ""}${r.unknown ? `, ${r.unknown} not judged` : ""}${r.notAnalysis ? `, ${r.notAnalysis} not analyses` : ""}` +
  `${r.lost ? `, ${r.lost} edits not replayable` : ""}`;

/** The run for the background process: its outcome in the claim. @param {any} db @param {number} repoId @param {string} root */
async function runBackfill(db, repoId, root) {
  const started = Date.now();
  try {
    const r = await backfill(db, repoId, root);
    db.setMeta(metaKey(repoId), JSON.stringify({ status: "done", started, at: Date.now(), summary: summary(r) }));
  } catch (e) {
    db.setMeta(metaKey(repoId), JSON.stringify({ status: "failed", started, at: Date.now(), error: String(e instanceof Error ? e.message : e).slice(0, 300) }));
  }
}

/**
 * At session start: claims the repo's one backfill and starts it in the background when the
 * repo has transcripts. True when it started one.
 * @param {any} db @param {number} repoId @param {string} root
 * @param {{start?: (root: string) => void, home?: string}} [o] start: tests replace the detached process
 */
function maybeStart(db, repoId, root, o = {}) {
  if (process.env.IMPRIMATUR_CHILD) return false;
  if (!a.settingsOf(root).on) return false;
  const projects = path.join(o.home ?? os.homedir(), ".claude", "projects");
  if (!fs.existsSync(path.join(projects, slugOf(root)))) return false;
  if (!db.claimMeta(metaKey(repoId), JSON.stringify({ status: "running", started: Date.now() }))) return false;
  const start = o.start ?? (process.env.NODE_TEST_CONTEXT ? () => {} : startDetached);
  start(root);
  return true;
}

/** @param {string} root */
function startDetached(root) {
  spawn(process.execPath, [path.join(__dirname, "..", "hooks", "analysis-backfill.mjs"), root], {
    cwd: root, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, IMPRIMATUR_CHILD: "1" },
  }).unref();
}

module.exports = { backfill, replay, eventsOf, transcripts, summary, runBackfill, maybeStart, metaKey, startDetached };
