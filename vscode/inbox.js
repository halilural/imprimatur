// @ts-check
// What waits on the user, counted once for every place that shows it (the launcher's badge, the
// status bar, the new panel's ⏳), and the upkeep of that list when the database changes. Moved out
// of the old panel (graphView.js) when it was deleted (#202).
"use strict";
const records = require("./records.js");
const { waitingSteps } = require("./waiting.js");
const fs = require("node:fs");

/** The repo row of a root, also when the database spells it by its real path. @param {any} db @param {string} root */
function repoOfRoot(db, root) {
  const found = db.repoByRoot(root);
  if (found) return found;
  try {
    const real = fs.realpathSync(root);
    if (real !== root) return db.repoByRoot(real);
  } catch {}
  return undefined;
}

/** This root's repo, or every repo (this one first). @param {any} db @param {string} root @param {boolean} all */
function scopeRepos(db, root, all) {
  const here = repoOfRoot(db, root);
  if (!all) return here ? [here] : [];
  return db.repos().sort((a, b) => Number(b.id === here?.id) - Number(a.id === here?.id));
}

const DAY = 86_400_000;

/** "today", "yesterday", "3 days" @param {number} ms @param {number} now */
function age(ms, now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return "today";
  if (ms >= start.getTime() - DAY) return "yesterday";
  return `${Math.ceil((start.getTime() - ms) / DAY)} days`;
}

/** Midnight today. @param {number} now */
const today = (now) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * The Waiting on you tab: the user's open records grouped by task, with
 * buckets (answer, do, test by eye, done today). Turn-end asks (waiting.js
 * steps) are cards too, under the task placeOf finds for them (else "No task").
 * @param {any} db @param {string} root
 * @param {{all?: boolean, waiting?: any[], now?: number, placeOf?: (step: any) => {task?: string}}} [o]
 */
function inboxModel(db, root, { all = false, waiting = [], now = Date.now(), placeOf } = {}) {
  const repos = scopeRepos(db, root, all);
  const byRepo = new Map(repos.map((r) => [r.id, r]));
  // One repo: asked of the database for that repo, so no limit cuts its records off.
  const repoId = all ? undefined : repos[0]?.id ?? -1;
  const open = [...db.openAsks({ repoId, limit: 5000 }), ...db.openTests({ repoId, limit: 5000 })].filter((r) => byRepo.has(r.repo_id));
  const done = db.doneByUserSince(today(now), { repoId, limit: 1000 }).filter((/** @type {any} */ r) => byRepo.has(r.repo_id));
  const turn = openTurn(waiting);
  const n = (/** @type {string} */ k) => open.filter((r) => r.kind === k).length;
  const buckets = [
    { id: "question", n: n("question") + turn.filter((w) => w.kind === "question").length, label: "Needs an answer", hint: "the agent is stopped on a decision" },
    { id: "todo", n: n("todo") + turn.filter((w) => w.kind === "command" || w.kind === "input").length, label: "Your to-do", hint: "steps for you to do" },
    { id: "test", n: n("test") + turn.filter((w) => w.kind === "verify").length, label: "Manual test", hint: "things to check by eye" },
    { id: "done", n: done.length, label: "Done today", hint: "the agent will see it" },
  ];
  // Turn-end asks: the open ones, and the ones you ticked today (like the records you finished).
  const here = repoOfRoot(db, root);
  const start = today(now);
  /** @type {Map<string, any>} */
  const keyed = new Map();
  const turnItem = (/** @type {any} */ w) => {
    const key = placeOf?.(w)?.task;
    if (key && here && !keyed.has(key)) keyed.set(key, db.taskByKey(here.id, key));
    const task = key && here ? keyed.get(key) : undefined;
    // The group names the task: the text need not start with it too ("LATD-13937: …").
    const title = task && w.text.startsWith(task.key) ? w.text.slice(task.key.length).replace(/^[\s:–—-]+/, "") || w.text : w.text;
    return { turn: true, kind: TURN_KIND[w.kind] ?? "todo", title, why: w.why, detail: w.detail, prompt: w.prompt, session: w.session, item: w.item, i: w.i,
      created_at: Date.parse(w.t) || 0, task_id: task ? task.id : 0, repo_id: here?.id };
  };
  const turnDone = waiting.filter((w) => w.session !== "todo-files" && w.state === "done" && !w.by && w.at && Date.parse(w.at) >= start);
  /** @type {Map<number, {task: any, repo: any, items: any[]}>} */
  const groups = new Map();
  const add = (/** @type {any} */ r, /** @type {boolean} */ isDone) => {
    // Task 0: turn-end asks no task is found for.
    if (!groups.has(r.task_id)) groups.set(r.task_id, { task: r.task_id ? db.taskById(r.task_id) : null, repo: byRepo.get(r.repo_id), items: [] });
    const g = /** @type {any} */ (groups.get(r.task_id));
    // The task's title goes into the search text: a card is found by its task's name too.
    g.items.push({ ...r, task_key: r.task_key ?? g.task?.key, task_title: g.task?.title, age: age(r.created_at, now), done: isDone });
  };
  // Questions first (the agent waits on them), then todos, tests; newest first within.
  const rank = { question: 0, todo: 1, test: 2 };
  [...open, ...turn.map(turnItem)].sort((a, b) => (rank[/** @type {keyof typeof rank} */ (a.kind)] ?? 3) - (rank[/** @type {keyof typeof rank} */ (b.kind)] ?? 3) || b.created_at - a.created_at).forEach((r) => add(r, false));
  done.forEach((/** @type {any} */ r) => add(r, true));
  turnDone.map(turnItem).forEach((r) => add(r, true));
  return { all, buckets, groups: [...groups.values()], count: open.length + turn.length, records: open.length, turn: turn.length };
}

/** A turn-end ask's kind as a card's: what you answer, do or check by eye. */
const TURN_KIND = /** @type {Record<string, string>} */ ({ question: "question", verify: "test", command: "todo", input: "todo" });

/** Turn-end asks older than this no longer wait on the user: the work went on without them. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Turn-end asks still open; the todo-files log only mirrors records, which count themselves.
 * One older than a week is stale and not counted (it stays in its session's log and list).
 * @param {Array<{session: string, state: string, t?: string}>} waiting @param {number} [now]
 */
const openTurn = (waiting, now = Date.now()) => waiting.filter((w) => w.session !== "todo-files" && w.state === "open" && !(now - Date.parse(w.t ?? "") > STALE_MS));

/**
 * How many things wait on the user: the one count the launcher's badge, the status
 * bar, the panel's tab badge and Waiting on you show. Records of this root's repo
 * (or every repo), and open turn-end asks; without a database, the asks alone.
 * @param {any} db @param {string} root @param {any[]} [waiting] @param {{all?: boolean}} [o]
 */
function inboxCount(db, root, waiting = [], { all = false } = {}) {
  if (!db) return openTurn(waiting).length;
  return inboxModel(db, root, { all, waiting }).count;
}

/** How many asks wait on the user in this repo. @param {string | undefined} root */
function inboxNow(root) {
  if (!root) return 0;
  const waiting = waitingSteps(root);
  try {
    return inboxCount(records.dbOf(), root, waiting);
  } catch {
    return openTurn(waiting).length;
  }
}

/**
 * What makes up inboxNow, item by item, for the side bar's Home row: by kind, and the ones on
 * tasks already done (asks left behind).
 * @param {string | undefined} root
 * @returns {Record<"question" | "todo" | "test" | "turn" | "doneTasks", Array<{id?: number, title: string, task?: string}>> | undefined}
 */
function inboxParts(root) {
  if (!root) return undefined;
  const waiting = waitingSteps(root);
  try {
    const m = inboxModel(records.dbOf(), root, { waiting });
    /** @type {any} */
    const out = { question: [], todo: [], test: [], turn: [], doneTasks: [] };
    for (const g of m.groups) {
      for (const i of g.items) {
        if (i.done) continue;
        const item = { id: i.turn ? undefined : i.id, title: i.title, task: g.task?.key };
        // Grouped by what the user does, not by where it came from: a turn-end ask is a
        // question or something to do, next to the records of the same kind.
        out[i.turn ? (i.kind === "question" ? "question" : "todo") : i.kind]?.push(item);
        if (g.task?.status === "done") out.doneTasks.push(item);
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * The database changed (a record, a task's status): done tasks close their asks, the user's open
 * records sync into the waiting list. Both write only under the repo's .claude/imprimatur, never the
 * database: no loop. @param {string | undefined} root
 */
function syncWaiting(root) {
  if (!root) return;
  try {
    require("./todo-done.js").closeDoneTasks(root);
    require("./history.js").scanTodos(root);
  } catch {
    // a waiting log being written: the next change catches up
  }
}

module.exports = { inboxNow, inboxParts, syncWaiting, inboxModel, inboxCount, openTurn, scopeRepos, repoOfRoot };
