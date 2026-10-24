// @ts-check
// Tasks in the Agent Change Graph panel (#69): the "Home", "Tasks" and
// "Waiting on you" tabs (the "Architecture" and "Product" document tabs: docsView.js, #72). Pure: every builder takes a database connection
// (vscode/db.js) and returns a model or HTML, so the unit tests run them without
// VS Code. The panel (graphView.js) renders only the visible tab's HTML, sends
// the user's clicks back here (applyMessage) and redraws on the database's change.
"use strict";
const fs = require("node:fs");
const os = require("node:os");

/** The user, as record versions name them. */
const userActor = () => ({ kind: /** @type {"user"} */ ("user"), id: os.userInfo().username });

const TABS = ["home", "tasks", "inbox", "architecture", "product", "glossary", "analysis", "exercises", "edits"];
/** The Analysis tab's pages (TASK-ANALYSIS): the design documents, the glossary and the tasks' analyses. */
const ANALYSIS_TABS = [["architecture", "Architecture"], ["product", "Product"], ["glossary", "Glossary"], ["analysis", "Task analyses"]];
const FILTERS = ["active", "open", "done"];
const TASK_STATUSES = ["open", "active", "done", "dropped"];
/** The tasks that hold recommendations (#87: RECS; AUDIT and BEST before it). */
const RECS_KEYS = ["RECS", "AUDIT", "BEST"];
const STATUS_TR = { active: "In progress", open: "Open", done: "Done", dropped: "Dropped" };
/** Tasks the importer opens to hold records (#59), not work (#75); db.whereWeLeftOff leaves them out too. */
const CONTAINERS = ["ADR", "PDR", "TEST", "AUDIT", "BEST", "RECS"];
const KIND_TR = { todo: "to-do", question: "question", answer: "answer", decision: "decision", note: "note", fixme: "fixme", adr: "ADR", pdr: "PDR", test: "test" };
const WHO_TR = { user: "You", agent: "Agent", hook: "Hook", import: "Import" };
/** The analysis section /study keeps its note in (study.js NOTE_KEY). */
const STUDY_KEY = "study";
const DOC_LABEL_TR = { architecture: "Architecture", product: "Product", glossary: "Glossary" };
const TODO_KINDS = ["todo", "fixme"];
const DESIGN_KINDS = ["decision", "adr", "pdr"];
/** The task list's filter a status falls under. @param {string} s */
const bucketOf = (s) => (s === "active" ? "active" : s === "open" ? "open" : "done");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Small line icons (no emoji): Lucide's 24×24 paths (icons.js), stroked in currentColor. */
const { ICONS: ICON } = require("./icons.js");
/** @param {keyof typeof ICON} name @param {number} [size] */
const icon = (name, size = 16) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/**
 * The quick-add box: "? text" a question to the user, "! text" a decision,
 * "# text" a note, "@me text" (or the Turkish "@ben") a todo of the user's; anything else a todo of
 * the agent's. "#67 …" (a task key) stays a todo.
 * @param {string} text @returns {{kind: string, title: string, owner?: string} | undefined}
 */
function parseQuickAdd(text) {
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  /** @param {string} kind @param {string} rest @param {string} [owner] */
  const mk = (kind, rest, owner) => {
    const parts = splitText(rest);
    return parts ? { kind, ...parts, ...(owner && { owner }) } : undefined;
  };
  if (!t) return undefined;
  if (t[0] === "?") return mk("question", t.slice(1), "K");
  if (t[0] === "!") return mk("decision", t.slice(1));
  if (t[0] === "#" && !/^#\d/.test(t)) return mk("note", t.slice(1));
  const me = /^@(?:me|ben)\b\s*/i.exec(t);
  if (me) return mk("todo", t.slice(me[0].length), "K");
  return mk("todo", t, "C");
}

const TITLE_MAX = 300;
const BODY_MAX = 20_000;
/**
 * Typed text as a record's title and body: the first line (at most TITLE_MAX
 * characters) is the title; the whole text, when it says more, the body (at most BODY_MAX).
 * @param {unknown} text @returns {{title: string, body?: string} | undefined}
 */
function splitText(text) {
  if (typeof text !== "string") return undefined;
  const t = text.trim();
  if (!t) return undefined;
  const first = t.split("\n")[0].trim();
  const title = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
  return t === title ? { title } : { title, body: t.slice(0, BODY_MAX) };
}

/** What waits on the user: an open todo or question of theirs, or an open manual test. @param {any} r */
const isAsk = (r) => r.status === "open" && ((r.owner === "K" && (r.kind === "todo" || r.kind === "question")) || (r.kind === "test" && r.owner !== "C"));

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

/**
 * The global setup's audit (#77, the home's AUDIT task): it applies to every repo, so
 * "this repo" lists it too, in its own group. Not when this repo is the home itself.
 * @param {any} db @param {string} root @param {string} [home]
 */
function globalAudit(db, root, home = os.homedir()) {
  const h = repoOfRoot(db, home);
  if (!h || h.id === repoOfRoot(db, root)?.id) return [];
  return taskSummaries(db, h).filter((/** @type {any} */ t) => t.key === "RECS" || t.key === "AUDIT").map((/** @type {any} */ t) => ({ ...t, global: true }));
}

/** This root's repo, or every repo (this one first). @param {any} db @param {string} root @param {boolean} all */
function scopeRepos(db, root, all) {
  const here = repoOfRoot(db, root);
  if (!all) return here ? [here] : [];
  return db.repos().sort((a, b) => Number(b.id === here?.id) - Number(a.id === here?.id));
}

const DAY = 86_400_000;
/** "9 Oct, 22:40" @param {number} ms */
const when = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** "9 Oct" @param {number} ms */
const day = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
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

/** Reads kept until the database changes (db.changeStamp): a redraw that changed nothing reads nothing again. @type {WeakMap<any, {stamp: string, values: Map<string, any>}>} */
const memo = new WeakMap();
/** @template T @param {any} db @param {string} key @param {() => T} read @returns {T} */
function cached(db, key, read) {
  if (typeof db.changeStamp !== "function") return read();
  const stamp = db.changeStamp();
  let m = memo.get(db);
  if (!m || m.stamp !== stamp) memo.set(db, (m = { stamp, values: new Map() }));
  if (!m.values.has(key)) m.values.set(key, read());
  return m.values.get(key);
}

/**
 * Each task of a repo with its counts for lists: open asks, todos, where we left off.
 * @param {any} db @param {any} repo
 */
function taskSummaries(db, repo) {
  return cached(db, `summaries:${repo.id}`, () => readSummaries(db, repo));
}

/** @param {any} db @param {any} repo */
function readSummaries(db, repo) {
  const tasks = db.tasksOf(repo.id, { limit: 2000 });
  /** @type {Map<number, any[]>} */
  const by = new Map();
  for (const r of db.recordsOfRepo(repo.id)) by.set(r.task_id, [...(by.get(r.task_id) ?? []), r]);
  return tasks.map((/** @type {any} */ t) => {
    const rs = by.get(t.id) ?? [];
    const todos = rs.filter((r) => TODO_KINDS.includes(r.kind));
    return {
      id: t.id, key: t.key, title: t.title, status: t.status, summary: t.summary, updated_at: t.updated_at, epic_id: t.epic_id,
      repo: { id: repo.id, name: repo.name, root: repo.root },
      asks: rs.filter(isAsk).length,
      openTodos: todos.filter((r) => r.status === "open").length,
      todos: todos.length,
      pointer: rs.find((r) => r.pointer)?.title,
      q: [t.key, t.title, t.summary, repo.name, ...rs.map((r) => r.title)].filter(Boolean).join(" "),
    };
  });
}

/** "2 open to-dos", "all done", "no plan". @param {{openTodos: number, todos: number}} t */
const todoLine = (t) => (!t.todos ? "no plan" : t.openTodos ? `${t.openTodos} open to-do${t.openTodos === 1 ? "" : "s"}` : "all done");

/**
 * What the user has not read yet (#92), by task key: the agent's edits not accepted
 * (openEdits, from the graph's lanes; "" is the no-task lane) and the sections someone
 * else changed since the user last read them.
 * @param {any} db @param {any} repo @param {Map<string, number>} [openEdits]
 */
function unreadOf(db, repo, openEdits = new Map()) {
  /** @type {any[]} */
  const sections = repo ? cached(db, `unread:${repo.id}`, () => db.unreadSections(repo.id)) : [];
  /** @type {Map<string, {edits: number, sections: any[]}>} */
  const byTask = new Map();
  const of = (/** @type {string} */ k) => {
    let u = byTask.get(k);
    if (!u) byTask.set(k, (u = { edits: 0, sections: [] }));
    return u;
  };
  let edits = 0;
  for (const [k, n] of openEdits) {
    edits += n;
    if (k) of(k).edits = n;
  }
  for (const s of sections) for (const k of s.tasks) of(k).sections.push(s);
  return { byTask, sections, edits };
}

/** How many things a task has unread. @param {{edits: number, sections: any[]} | undefined} u */
const unreadCount = (u) => (u ? u.edits + u.sections.length : 0);

/** A section where the panel shows it: its document tab ("analysis": the task's, by its key). @param {any} s */
const sectionPlace = (s) => ({ id: s.id, key: s.key, title: s.title, tab: s.kind, scope: s.scope, label: s.kind === "analysis" ? "Analysis" : DOC_LABEL_TR[s.kind] ?? s.kind });

/**
 * What one version of a record did, in words.
 * @param {any} v a version with the record's kind and title
 * @returns {string | undefined} undefined: not worth a line (the 👉 leaving a record)
 */
function describeVersion(v) {
  const k = KIND_TR[/** @type {keyof typeof KIND_TR} */ (v.kind)] ?? v.kind;
  const a = v.after ?? {};
  if (v.op === "create") return `added ${k}: ${v.title}`;
  if (a.status === "done") return `${v.kind === "question" ? "answered" : "finished"}: ${v.title}`;
  if (a.status === "open") return `reopened: ${v.title}`;
  if (a.status === "dropped") return `dropped: ${v.title}`;
  if (a.pointer === true) return `moved where we left off here: ${v.title}`;
  if (a.pointer === false && Object.keys(a).length === 1) return undefined;
  if (typeof a.task === "string") return `moved to ${a.task}: ${v.title}`;
  if ("title" in a) return `renamed: ${v.title}`;
  return `updated: ${v.title}`;
}

/**
 * One task's page.
 * @param {any} db @param {any} task @param {{showDone?: number[], old?: number[], flash?: number | null}} view
 * @param {{linkOf?: (root: string, key: string) => string | undefined, now?: number, turns?: Map<number, any[]>, unread?: {edits: number, sections: any[]}}} opts
 */
function taskPage(db, task, view, opts) {
  const now = opts.now ?? Date.now();
  const repo = db.repos().find((/** @type {any} */ r) => r.id === task.repo_id);
  const recs = db.recordsOf(task.id, { dropped: true });
  const live = recs.filter((/** @type {any} */ r) => r.status !== "dropped");
  const pointer = live.find((/** @type {any} */ r) => r.pointer);
  const flash = view.flash ? recs.find((/** @type {any} */ r) => r.id === view.flash) : undefined;
  const todoAll = live.filter((/** @type {any} */ r) => TODO_KINDS.includes(r.kind));
  const showDone = (view.showDone ?? []).includes(task.id) || (flash && TODO_KINDS.includes(flash.kind) && flash.status !== "open");
  const creators = cached(db, `creators:${task.id}`, () => db.creatorsOf(task.id));
  const answers = live.filter((/** @type {any} */ r) => r.kind === "answer");
  const showOld = (view.old ?? []).includes(task.id);
  const { list: versions, total } = db.taskVersions(task.id, { limit: showOld ? 300 : 12 });
  /** @type {Array<{at: number, who: string, kind: string, what: string}>} */
  const events = [];
  let used = 0;
  for (const v of versions) {
    if (!showOld && events.length >= 5) break;
    used++;
    const what = describeVersion(v);
    if (what) events.push({ at: v.at, who: WHO_TR[/** @type {keyof typeof WHO_TR} */ (v.actor_kind)] ?? v.actor_kind, kind: v.actor_kind, what });
  }
  const epic = task.epic_id ? db.taskById(task.epic_id) : undefined;
  const last = versions[0];
  const lastAt = Math.max(task.updated_at, last?.at ?? 0);
  return {
    id: task.id, key: task.key, title: task.title, status: task.status, summary: task.summary,
    repo: repo ? { id: repo.id, name: repo.name, root: repo.root } : undefined,
    url: repo && opts.linkOf ? opts.linkOf(repo.root, task.key) : undefined,
    epic: epic ? { id: epic.id, key: epic.key, title: epic.title, status: epic.status } : undefined,
    pointer: pointer && { id: pointer.id, title: pointer.title, owner: pointer.owner, kind: pointer.kind, at: pointer.updated_at },
    // Its records that wait on the user, then the turn-end asks placed on it (there is no Waiting on you tab).
    asks: [...live.filter(isAsk).map((/** @type {any} */ r) => ({ ...r, age: age(r.created_at, now) })), ...(opts.turns?.get(task.id) ?? [])],
    todos: todoAll.filter((/** @type {any} */ r) => showDone || r.status === "open" || r.pointer),
    openTodos: todoAll.filter((/** @type {any} */ r) => r.status === "open").length,
    hiddenDone: todoAll.filter((/** @type {any} */ r) => r.status !== "open" && !r.pointer).length,
    showDone: !!showDone,
    decisions: live.filter((/** @type {any} */ r) => DESIGN_KINDS.includes(r.kind)).map((/** @type {any} */ r) => {
      const c = creators.get(r.id);
      return { ...r, date: day(r.created_at), who: c ? (c === "user" ? "you" : c === "agent" ? "agent" : c) : "" };
    }),
    tests: recs.filter((/** @type {any} */ r) => r.kind === "test"),
    analysis: repo ? analysisOf(db, repo.id, task.key) : undefined,
    notes: live
      .filter((/** @type {any} */ r) => (r.kind === "note" && !r.links?.bestSources) || (r.kind === "question" && r.status !== "open"))
      .map((/** @type {any} */ r) => ({ ...r, answers: answers.filter((/** @type {any} */ a) => a.parent_id === r.id) })),
    activity: events,
    older: Math.max(0, total - used),
    showOld,
    last: lastAt ? { at: lastAt, who: last ? WHO_TR[/** @type {keyof typeof WHO_TR} */ (last.actor_kind)] ?? last.actor_kind : "" } : undefined,
    openCount: live.filter((/** @type {any} */ r) => r.status === "open").length,
    recordCount: live.length,
    flash: flash?.id,
    // Not read yet (#92): its edits not accepted, the sections changed since the user read them.
    unread: { edits: opts.unread?.edits ?? 0, sections: (opts.unread?.sections ?? []).map(sectionPlace) },
    // The audit's findings (#77): grouped like Agent setup's Recommendations, not a flat todo list.
    // Recommendations (#87): the agent setup audit's findings and the project's best
    // practices, grouped as in the Recommendations tree, not as a flat todo list.
    audit: RECS_KEYS.includes(task.key) && recs.some((/** @type {any} */ r) => r.links?.audit) ? require("./setup-audit-tree.js").auditGroups(recs, { lang: "tr" }) : undefined,
    // Best-practice recommendations (#86): grouped, with the source map they were read from.
    best: RECS_KEYS.includes(task.key) && recs.some((/** @type {any} */ r) => r.links?.best || r.links?.bestSources) ? { groups: require("./best-tree.js").bestGroups(recs), map: recs.find((/** @type {any} */ r) => r.links?.bestSources)?.links.bestSources } : undefined,
  };
}

/**
 * A task's analysis (TASK-ANALYSIS) for its page: its current sections by the file they came
 * from, newest file first; and the repo's analysis files no task was found for, to give one.
 * @param {any} db @param {number} repoId @param {string} key
 */
function analysisOf(db, repoId, key) {
  const doc = db.taskDocFind(repoId, key);
  /** @type {Map<string, {source: string, at: number, sections: any[]}>} */
  const files = new Map();
  /** @type {any} */
  let study;
  for (const s of doc ? db.docSections(doc.id) : []) {
    if (s.status !== "current") continue;
    // The /study note (#95) is no file of the analysis: it goes under them (#100).
    if (s.key === STUDY_KEY && !s.source) {
      study = { id: s.id, key: s.key, title: s.title, body: s.body, at: s.updated_at };
      continue;
    }
    const src = s.source ?? "";
    const f = files.get(src) ?? { source: src, at: 0, sections: [] };
    f.sections.push({ id: s.id, key: s.key, title: s.title, body: s.body });
    f.at = Math.max(f.at, s.updated_at);
    files.set(src, f);
  }
  const orphans = Object.entries(require("./analysis.js").orphans(db, repoId)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([source, at]) => ({ source, at }));
  // Only files read on this machine open from here; one synced from another has its text only.
  // "open" only for a file read on this machine and still there; one synced or deleted has its text only.
  const local = new Set(doc ? db.docSourceFiles(doc.id).map((/** @type {any} */ x) => x.path) : []);
  const root = db.repos().find((/** @type {any} */ r) => r.id === repoId)?.root;
  const there = (/** @type {string} */ src) => {
    if (!root || !local.has(src) || src.startsWith("plan:")) return false;
    try {
      return fs.statSync(require("./analysis.js").absPath(root, src)).isFile();
    } catch {
      return false;
    }
  };
  if (study) {
    const task = db.taskByKey(repoId, key);
    const m = task ? require("./study.js").masteryOf(db.recordsOf(task.id)) : undefined;
    if (m) study.mastery = { at: m.at, full: m.score.full, total: m.score.total, weak: m.weak.slice(0, 3).map((/** @type {any} */ q) => q.q) };
  }
  return { files: [...files.values()].map((f) => ({ ...f, local: there(f.source) })).sort((a, b) => b.at - a.at), orphans, study };
}

/**
 * The Tasks tab: the filtered task list (this repo, or every repo) and the selected task's page.
 * @param {any} db @param {string} root
 * @param {{sel?: number | null, filter?: string, all?: boolean, showDone?: number[], old?: number[], flash?: number | null}} [view]
 * @param {{linkOf?: (root: string, key: string) => string | undefined, now?: number, home?: string, openEdits?: Map<string, number>, waiting?: any[], placeOf?: (w: any) => any}} [opts]
 */
function tasksPage(db, root, view = {}, opts = {}) {
  const all = !!view.all;
  const repos = scopeRepos(db, root, all);
  const here = repoOfRoot(db, root);
  // The edits are this repo's (the open panel's graph); other repos show their sections only.
  const unread = new Map(repos.map((repo) => [repo.id, unreadOf(db, repo, repo.id === here?.id ? opts.openEdits : undefined)]));
  const tasks = [...repos.flatMap((repo) => taskSummaries(db, repo).map((t) => ({ ...t, unread: unreadCount(unread.get(repo.id)?.byTask.get(t.key)) }))),
    ...(all ? [] : globalAudit(db, root, opts.home))];
  const filter = FILTERS.includes(view.filter ?? "") ? /** @type {string} */ (view.filter) : "active";
  const counts = { active: 0, open: 0, done: 0 };
  for (const t of tasks) counts[/** @type {keyof typeof counts} */ (bucketOf(t.status))]++;
  // Record containers (#75) after the work, in each repo's list.
  const list = tasks.filter((t) => bucketOf(t.status) === filter)
    .sort((a, b) => Number(CONTAINERS.includes(a.key)) - Number(CONTAINERS.includes(b.key)));
  let task = view.sel ? db.taskById(Number(view.sel)) : undefined;
  if (!task) {
    const first = list[0] ?? tasks.find((t) => t.status === "active") ?? tasks[0];
    task = first && db.taskById(first.id);
  }
  /** @type {Array<{repo: any, tasks: typeof list, global?: boolean}>} */
  const groups = [];
  for (const t of list) {
    const g = groups.find((x) => x.repo.id === t.repo.id);
    if (g) g.tasks.push(t);
    else groups.push({ repo: t.repo, tasks: [t], ...(t.global && { global: true }) });
  }
  return {
    all, filter, counts, groups, sel: task?.id,
    repoName: here?.name ?? root.split(/[\\/]/).pop(),
    cur: task ? taskPage(db, task, view, { ...opts, turns: turnAsks(db, root, opts), unread: unread.get(task.repo_id)?.byTask.get(task.key) }) : undefined,
  };
}

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

/** Turn-end asks still open; the todo-files log only mirrors records, which count themselves. @param {Array<{session: string, state: string}>} waiting */
const openTurn = (waiting) => waiting.filter((w) => w.session !== "todo-files" && w.state === "open");

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

/**
 * The Home tab: progress of the repo's tasks, where each was left, the top asks, the task table.
 * @param {any} db @param {string} root @param {{now?: number}} [o]
 */
/**
 * The open turn-end asks (waiting.js steps) by the task placeOf finds for them; 0: no task.
 * @param {any} db @param {string} root @param {{waiting?: any[], now?: number, placeOf?: (w: any) => any}} o
 * @returns {Map<number, any[]>}
 */
function turnAsks(db, root, o) {
  /** @type {Map<number, any[]>} */
  const out = new Map();
  if (!o.waiting?.length) return out;
  for (const g of inboxModel(db, root, { all: true, waiting: o.waiting, now: o.now, placeOf: o.placeOf }).groups) {
    const items = g.items.filter((/** @type {any} */ i) => i.turn && !i.done);
    if (items.length) out.set(g.task?.id ?? 0, items);
  }
  return out;
}

/** @param {any} db @param {string} root @param {{now?: number, waiting?: any[], placeOf?: (w: any) => any, openEdits?: Map<string, number>}} [o] */
function homeModel(db, root, { now = Date.now(), waiting, placeOf, openEdits } = {}) {
  const repo = repoOfRoot(db, root);
  if (!repo) return { repoName: root.split(/[\\/]/).pop(), total: 0, done: 0, active: 0, open: 0, pointers: [], asks: [], askCount: 0, rows: [], loose: [], unread: { edits: 0, sections: [] } };
  const unread = unreadOf(db, repo, openEdits);
  const tasks = taskSummaries(db, repo);
  const done = tasks.filter((t) => t.status === "done").length;
  const live = tasks.filter((t) => t.status !== "dropped");
  const left = db.whereWeLeftOff(repo.id).filter((/** @type {any} */ t) => t.pointer_id);
  const asks = [...db.openAsks({ repoId: repo.id, limit: 1000 }), ...db.openTests({ repoId: repo.id, limit: 1000 })]
    .sort((a, b) => b.created_at - a.created_at);
  const order = { active: 0, open: 1, done: 2, dropped: 3 };
  const byId = new Map(tasks.map((t) => [t.key, t]));
  // The importer's record containers (ADR, PDR, TEST) are no work: last, and not counted (#75).
  const box = (/** @type {any} */ t) => Number(CONTAINERS.includes(t.key));
  return {
    repoName: repo.name,
    total: live.filter((t) => !box(t)).length, done,
    active: tasks.filter((t) => t.status === "active").length,
    open: tasks.filter((t) => t.status === "open" && !box(t)).length,
    pointers: left.slice(0, 6).map((/** @type {any} */ t) => ({ id: byId.get(t.key)?.id, key: t.key, task: t.title, next: t.pointer_title, record: t.pointer_id, mine: t.pointer_owner === "K", status: t.status })),
    asks: asks.slice(0, 5).map((r) => ({ id: r.id, task: r.task_id, kind: r.kind, title: r.title, key: r.task_key, status: byId.get(r.task_key)?.status })),
    askCount: asks.length,
    // Turn-end asks no task was found for: only here, now that there is no Waiting on you tab.
    loose: turnAsks(db, root, { now, waiting, placeOf }).get(0) ?? [],
    // Not read yet (#92): the repo's edits not accepted and its changed sections.
    unread: { edits: unread.edits, sections: unread.sections.map(sectionPlace) },
    rows: [...tasks].sort((a, b) => box(a) - box(b) || (order[/** @type {keyof typeof order} */ (a.status)] - order[/** @type {keyof typeof order} */ (b.status)]) || b.updated_at - a.updated_at)
      .map((t) => ({ ...t, when: day(t.updated_at), age: age(t.updated_at, now) })),
  };
}

// ---- HTML: each block has a data-k key; the page swaps only the blocks that changed ----

/** @param {string} status */
const statusChip = (status) => `<span class="st st-${esc(status)}">${esc(STATUS_TR[/** @type {keyof typeof STATUS_TR} */ (status)] ?? status)}</span>`;
const KIND_LABEL = { question: "Question", todo: "Your to-do", test: "Manual test", decision: "Decision", adr: "ADR", pdr: "PDR", note: "Note", fixme: "Fixme", answer: "Answer" };
/** @param {string} kind @param {string} [label] */
const kindChip = (kind, label) => `<span class="kchip k-${esc(kind)}">${esc(label ?? KIND_LABEL[/** @type {keyof typeof KIND_LABEL} */ (kind)] ?? kind)}</span>`;
/** @param {number} id @param {string} status @param {string} key */
const openTask = (id, status, key, cls = "mono key") => `<a href="#" class="${cls}" data-act="open" data-id="${id}" data-f="${bucketOf(status)}">${esc(key)}</a>`;

/**
 * A record's body as Markdown (raw HTML in it stays text: docsView's renderer); its
 * "- [ ] step" lines are checkboxes the user ticks (recStep), kept in the body itself.
 * @param {string} text @param {number} id the record's
 */
const mdBody = (text, id) => `<div class="body md" data-body="${id}">${require("./docsView.js").renderMarkdown(text, { steps: true })}</div>`;
/** "2/5 steps" for a body with steps, else "". @param {string | null | undefined} text */
const stepCount = (text) => {
  const steps = require("./docsView.js").stepsOf(text);
  return steps.length ? `<span class="steps${steps.every((x) => x.done) ? " all" : ""}">${steps.filter((x) => x.done).length}/${steps.length} steps</span>` : "";
};

/**
 * One thing that waits on the user: a question to answer, a todo or a manual test to finish.
 * @param {any} r @param {{flash?: number}} [o]
 */
function askCard(r, o = {}) {
  if (r.turn) return turnCard(r);
  // On a task page an open todo of yours shows twice (here and in To-dos): this copy gets its own id.
  const id = `${o.prefix ?? "rec"}-${r.id}`;
  const k = r.kind === "test" ? "test" : r.kind;
  const head = `<div class="row1">${kindChip(k)}<span class="ttl">${esc(r.title)}</span>${stepCount(r.body)}<span class="age">${esc(r.age ?? "")}</span></div>`;
  const body = r.body ? mdBody(r.body, r.id) : "";
  const q = `data-q="${esc([r.title, r.body, r.task_key, r.task_title].filter(Boolean).join(" "))}" data-b="${r.done ? "done" : esc(k)}"`;
  if (r.done)
    return `<article class="card ask done" id="${id}" data-k="r${r.id}" data-nav tabindex="0" ${q}>${head}<span class="okline">${icon("check", 14)} Done — the agent will see it next turn · <a href="#" data-act="rec" data-op="open" data-id="${r.id}">undo</a></span></article>`;
  const action = r.kind === "question"
    ? `<div class="answer"><textarea rows="2" data-draft="ans-${r.id}" placeholder="Write your answer (Ctrl+Enter sends)" aria-label="Your answer"></textarea><button class="primary" data-act="answer" data-id="${r.id}">Answer</button></div>`
    : `<div class="acts"><button class="primary" data-act="rec" data-op="done" data-id="${r.id}">${r.kind === "test" ? "Passed" : "Done it"}</button></div>`;
  return `<article class="card ask${o.flash === r.id ? " flash" : ""}" id="${id}" data-k="r${r.id}" data-nav data-rec="${r.id}" tabindex="0" ${q}>${head}${body}${action}</article>`;
}

/**
 * A turn-end ask as a card: asked in the chat, not a record. Its button ticks the
 * step in the session's waiting log (the panel's "check").
 * @param {any} r
 */
function turnCard(r) {
  const at = `data-session="${esc(r.session)}" data-item="${esc(r.item)}" data-i="${r.i}"`;
  const head = `<div class="row1">${kindChip(r.kind)}<span class="ttl">${esc(r.title)}</span><span class="src" title="The agent asked this in the chat at the end of its turn">end of turn</span><span class="age">${esc(r.age ?? "")}</span></div>`;
  const q = `data-q="${esc([r.title, r.why, r.prompt, r.task_key, r.task_title].filter(Boolean).join(" "))}" data-b="${r.done ? "done" : esc(r.kind)}"`;
  const card = `class="card ask turn${r.done ? " done" : ""}" data-k="w${esc(r.session)}:${esc(r.item)}:${r.i}" data-nav tabindex="0" ${q}`;
  if (r.done)
    return `<article ${card}>${head}<span class="okline">${icon("check", 14)} Done — the agent will see it next turn · <a href="#" data-act="turn" data-on="0" ${at}>undo</a></span></article>`;
  const more = [
    r.why ? `<p class="body">${esc(r.why)}</p>` : "",
    r.prompt ? `<p class="body dim">Request: ${esc(r.prompt)}</p>` : "",
    r.detail && r.detail !== r.title ? `<details class="full"><summary>Full message</summary><pre>${esc(r.detail)}</pre></details>` : "",
  ].join("");
  const label = r.kind === "test" ? "Passed" : r.kind === "question" ? "Answered" : "Done it";
  return `<article ${card}>${head}${more}<div class="acts"><button class="primary" data-act="turn" data-on="1" ${at}>${label}</button></div></article>`;
}

/**
 * What the user has not read yet (#92): the edits to accept (on Agent changes) and the
 * sections changed since they read them. On Home a single line; on a task's page each
 * section of that task, to open or mark read.
 * @param {{edits: number, sections: any[]}} u @param {string} [key] the task's: its edits alone
 */
function unreadHtml(u, key) {
  if (!u.edits && !u.sections.length) return "";
  const edits = u.edits ? `<button class="mini" data-act="edits" data-key="${esc(key ?? "")}">${u.edits} edit${u.edits === 1 ? "" : "s"} not accepted ${icon("arrow", 12)}</button>` : "";
  // Home (no task): one line, however many changed; the sections themselves are on Analysis,
  // each with its Unread mark. A rewrite of a whole document must not bury Where we left off.
  if (key === undefined) {
    const first = u.sections[0];
    const n = u.sections.length;
    const docs = first ? `<a href="#" class="ulink" data-act="readGo" data-tab="${esc(first.tab)}" data-key="${esc(first.tab === "analysis" ? first.scope : first.key)}">${n} section${n === 1 ? "" : "s"} changed in the docs since you last read ${icon("arrow", 12)}</a>` : "";
    const markAll = n ? `<button class="link" data-act="read" data-ids="${u.sections.map((s) => s.id).join(",")}">Mark as read</button>` : "";
    return `<div class="unread compact" data-k="unread"><div class="uhead"><span class="lbl">Unread</span>${edits}${docs}${markAll}</div></div>`;
  }
  const all = u.sections.length > 1 ? `<button class="link" data-act="read" data-ids="${u.sections.map((s) => s.id).join(",")}">Mark all as read</button>` : "";
  const rows = u.sections.map((s) => `<div class="urow" data-k="u${s.id}"><a href="#" data-act="readGo" data-tab="${esc(s.tab)}" data-key="${esc(s.tab === "analysis" ? s.scope : s.key)}"><span class="dim">${esc(s.label)}</span> ${esc(s.title)}</a><button class="mini" data-act="read" data-ids="${s.id}">Mark as read</button></div>`).join("");
  return `<div class="unread" data-k="unread"><div class="uhead"><span class="lbl">Unread · ${u.edits + u.sections.length}</span>${edits}${all}</div>${rows}</div>`;
}

/** @param {ReturnType<typeof tasksPage>} m */
function tasksHtml(m) {
  const f = (/** @type {string} */ id, /** @type {string} */ label) =>
    `<button class="fpill${m.filter === id ? " on" : ""}" data-act="filter" data-f="${id}" aria-pressed="${m.filter === id}">${label} · ${m.counts[/** @type {keyof typeof m.counts} */ (id)]}</button>`;
  const row = (/** @type {any} */ t) => `<button class="trow${t.id === m.sel ? " on" : ""}" id="t-${t.id}" data-k="t${t.id}" data-act="sel" data-id="${t.id}" data-nav data-q="${esc(t.q)}"${t.id === m.sel ? ' aria-current="true"' : ""}>
<span class="sdot s-${esc(t.status)}" aria-hidden="true"></span><span class="tcol"><span class="tmeta"><span class="mono">${esc(t.key)}</span><span>${esc(STATUS_TR[/** @type {keyof typeof STATUS_TR} */ (t.status)] ?? t.status)}</span></span><span class="tttl">${esc(t.title || t.key)}</span><span class="tmeta">${t.asks ? `<b class="mine">${t.asks} on you</b>` : ""}${t.unread ? `<b class="unr">${t.unread} unread</b>` : ""}<span>${esc(todoLine(t))}</span></span></span></button>`;
  const rows = m.groups.length
    ? m.groups.map((g) => `<div class="grp" data-k="g${g.repo.id}">${m.all || g.global ? `<div class="grp-h">${esc(g.global && !m.all ? "Global (~)" : g.repo.name)}</div>` : ""}${g.tasks.map(row).join("")}</div>`).join("")
    : `<p class="empty" data-k="empty">No tasks in this filter.</p>`;
  const list = `<aside class="tlist" data-k="list" data-scroll="tlist" aria-label="Tasks"><div class="pills" data-k="filters" role="group" aria-label="Status">${f("active", "Active")}${f("open", "Open")}${f("done", "Done")}</div><div class="tl-head" data-k="head"><span>${esc(m.all ? "All repos" : m.repoName)}</span><button class="link" data-act="scope" data-all="${m.all ? 0 : 1}">${m.all ? "This repo" : "All repos"}</button></div><div class="rows" data-k="rows" data-navgroup="list">${rows}</div><button class="dashed" data-k="new" data-act="newTask">${icon("plus")} New task</button></aside>`;
  const c = m.cur;
  if (!c) return `<div class="tl" data-k="tl">${list}<main class="tpage" data-k="page"><div class="emptyhero" data-k="none">${require("./mascot.js").mascot(56)}<p>No tasks in this repo yet: the agent adds them through Imprimatur's MCP tools, or use "New task" on the left.</p></div></main></div>`;
  return `<div class="tl" data-k="tl">${list}<main class="tpage" data-k="page">${taskBlocks(c)}</main>${railHtml(c)}</div>`;
}

/** The task page's blocks. @param {NonNullable<ReturnType<typeof tasksPage>["cur"]>} c */
function taskBlocks(c) {
  const fl = (/** @type {number} */ id) => (c.flash === id ? " flash" : "");
  const head = `<section class="thead" data-k="head-${c.id}"><div class="meta"><span class="mono key">${esc(c.key)}</span>${statusChip(c.status)}${c.epic ? `<span class="dim">Epic ${openTask(c.epic.id, c.epic.status, c.epic.key, "mono")}</span>` : ""}${c.url ? `<a href="#" class="ext" data-act="url" data-url="${esc(c.url)}">Open on GitHub ${icon("external", 13)}</a>` : ""}${c.analysis?.files.length || c.analysis?.study ? `<button class="mini analink" data-act="anaGo" data-key="${esc(c.key)}" title="This task's analyses are in the Analysis tab">${icon("analysis", 12)} Analysis · ${[c.analysis.files.length ? `${c.analysis.files.length} file${c.analysis.files.length === 1 ? "" : "s"}` : "", c.analysis.study ? "study note" : ""].filter(Boolean).join(" · ")} ${icon("arrow", 12)}</button>` : ""}</div>
<h1>${esc(c.title || c.key)}</h1>${c.summary ? `<p class="sum">${esc(c.summary)}</p>` : ""}${c.pointer ? `<div class="callout${fl(c.pointer.id)}" id="ptr-${c.pointer.id}">${icon("arrow", 20)}<div><span class="lbl">Where we left off</span><span class="ptitle">${esc(c.pointer.title)}</span><span class="dim">${c.pointer.owner === "K" ? "Waiting on you" : c.pointer.owner === "C" ? "Agent's job" : esc(KIND_TR[/** @type {keyof typeof KIND_TR} */ (c.pointer.kind)] ?? c.pointer.kind)} · ${esc(day(c.pointer.at))}</span></div></div>` : ""}${unreadHtml(c.unread, c.key)}</section>`;
  const asks = c.asks.length
    ? `<section class="blk" data-k="asks" data-navgroup="asks" aria-label="Waiting on you"><h2><span class="odot" aria-hidden="true"></span>Waiting on you <span class="dim">· ${c.asks.length}</span></h2>${c.asks.map((r) => askCard(r, { prefix: "ask", flash: TODO_KINDS.includes(r.kind) ? undefined : c.flash })).join("")}</section>`
    : "";
  const todo = (/** @type {any} */ r) => {
    const done = r.status !== "open";
    const mine = r.owner === "K";
    return `<div class="trec${done ? " done" : ""}${fl(r.id)}" id="rec-${r.id}" data-k="r${r.id}" data-nav data-todo="${r.id}" tabindex="0" data-q="${esc(r.title)}"${r.body ? ` title="${esc(r.body)}"` : ""}>
<button class="check${done ? " on" : ""}" data-act="rec" data-op="${done ? "open" : "done"}" data-id="${r.id}" aria-label="${done ? "Reopen" : "Mark as done"}">${done ? icon("check", 12) : ""}</button><span class="ttl">${esc(r.title)}</span>${r.kind === "fixme" ? kindChip("fixme") : ""}${r.pointer ? `<span class="next">${icon("arrow", 12)} next</span>` : !done ? `<button class="mini" data-act="rec" data-op="pointer" data-id="${r.id}" title="Move where we left off here">make next</button>` : ""}<span class="owner${mine ? " me" : ""}">${mine ? "You" : r.owner === "C" ? "Agent" : "—"}</span></div>`;
  };
  const todos = `<section class="blk" data-k="todos" data-navgroup="todos" aria-label="To-dos"><div class="h2row" data-k="h"><h2>To-dos <span class="dim">· ${c.openTodos} open</span></h2>${c.hiddenDone || c.showDone ? `<button class="ghost" data-act="showDone" data-task="${c.id}">${c.showDone ? "Hide done" : `Show done (${c.hiddenDone})`}</button>` : ""}</div><div class="todos" data-k="list">${c.todos.map(todo).join("") || '<p class="empty" data-k="none">No open to-dos.</p>'}</div>
<label class="quick" data-k="add">${icon("plus")}<input data-draft="add-${c.id}" data-add data-task="${c.id}" placeholder="Add… ( ? question · ! decision · # note · @me yours )" aria-label="New record"></label></section>`;
  const notes = c.notes.length
    ? `<section class="blk" data-k="notes" aria-label="Notes and answered questions"><h2>Notes and answered questions <span class="dim">· ${c.notes.length}</span></h2>${c.notes.map((r) => `<div class="note${fl(r.id)}" id="rec-${r.id}" data-k="r${r.id}" data-q="${esc(r.title)}">${kindChip(r.kind)}<div class="ncol"><span class="ttl">${esc(r.title)}</span>${r.body ? mdBody(r.body, r.id) : ""}${r.answers.map((/** @type {any} */ a) => `<div class="ans">${icon("arrow", 12)} ${esc(a.title)}${a.body && a.body !== a.title ? mdBody(a.body, a.id) : ""}</div>`).join("")}</div></div>`).join("")}</section>`
    : "";
  const decisions = c.decisions.length
    ? `<section class="blk" data-k="dec" aria-label="Decisions and design"><h2>Decisions and design <span class="dim">· ${c.decisions.length}</span></h2><div class="grid">${c.decisions.map((r) => `<details class="card dec${fl(r.id)}" id="rec-${r.id}" data-k="r${r.id}" data-q="${esc(r.title)}"${c.flash === r.id ? " open" : ""}><summary><span class="meta">${kindChip(r.kind)}<span class="dim">${esc(r.date)}</span><span class="dim">${esc(r.who)}</span></span><span class="ttl">${esc(r.title)}</span></summary>${r.body ? mdBody(r.body, r.id) : '<p class="body dim">No description.</p>'}</details>`).join("")}</div></section>`
    : "";
  const testState = (/** @type {string} */ s) => (s === "done" ? ["pass", "Passed"] : s === "dropped" ? ["skip", "Dropped"] : ["wait", "Waiting"]);
  const tests = c.tests.length
    ? `<section class="blk" data-k="tests" aria-label="Manual tests"><h2>Manual tests <span class="dim">· ${c.tests.length}</span></h2>${c.tests.map((r) => {
      const [cls, label] = testState(r.status);
      const code = /^([A-Z]{2,}(?:-[A-Z0-9]+)*-\d+)\b/.exec(r.title)?.[1];
      return `<div class="test${fl(r.id)}" id="rec-${r.id}" data-k="r${r.id}" data-q="${esc(r.title)}">${code ? `<span class="mono dim">${esc(code)}</span>` : ""}<span class="ttl">${esc(code ? r.title.slice(code.length).replace(/^[\s:·–—-]+/, "") : r.title)}</span><span class="tstate t-${cls}">${label}</span></div>`;
    }).join("")}</section>`
    : "";
  const activity = `<section class="blk" data-k="act" aria-label="Activity"><h2>Activity</h2>${c.activity.map((v, i) => `<div class="ev" data-k="e${i}"><span class="when">${esc(when(v.at))}</span><span class="who w-${esc(v.kind)}">${esc(v.who)}</span><span class="what">${esc(v.what)}</span></div>`).join("") || '<p class="empty" data-k="none">No events yet.</p>'}${c.older || c.showOld ? `<button class="link" data-k="more" data-act="old" data-task="${c.id}">${c.showOld ? "Hide older events" : `Show ${c.older} older event${c.older === 1 ? "" : "s"}`}</button>` : ""}</section>`;
  const recBlocks = (c.audit ? auditBlock(c.audit) : "") + (c.best ? bestBlock(c.best) : "");
  // The tabs right under the head (and Where we left off): what waits on the user is the first, open by default.
  return head + taskTabs(c, [
    { k: "asks", label: "Waiting on you", n: c.asks.length, html: asks },
    { k: "todos", label: recBlocks ? "Recommendations" : "To-dos", n: c.openTodos, html: recBlocks || todos },
    { k: "dec", label: "Decisions", n: c.decisions.length, html: decisions },
    { k: "notes", label: "Notes", n: c.notes.length, html: notes },
    { k: "tests", label: "Tests", n: c.tests.length, html: tests },
    { k: "act", label: "Activity", n: 0, html: activity },
  ]);
}

/**
 * The task page under its head as tabs, Waiting on you first. Every pane is drawn; the page
 * shows the one chosen for this task (state.ttabs), else the first; all of them while the
 * search box filters. A tab with nothing in it is left out; the one holding a record to
 * flash opens.
 * @param {any} c @param {{k: string, label: string, n: number, html: string}[]} tabs
 */
function taskTabs(c, tabs) {
  const shown = tabs.filter((t) => t.html);
  const flash = c.flash ? shown.find((t) => t.html.includes(`id="rec-${c.flash}"`))?.k : undefined;
  const strip = shown.map((t) => `<button class="ttab" role="tab" data-act="ttab" data-tp="${t.k}">${esc(t.label)}${t.n ? ` <span class="n">${t.n}</span>` : ""}</button>`).join("");
  return `<div class="ttabs" role="tablist" data-k="ttabs" data-task="${c.id}" data-def="${shown[0]?.k ?? ""}"${flash ? ` data-flash="${flash}"` : ""}>${strip}</div>${shown.map((t) => `<div class="tpane" role="tabpanel" data-k="tp-${t.k}" data-tp="${t.k}">${t.html}</div>`).join("")}`;
}

/**
 * The Analysis tab's sub-pages, over each of them: Architecture, Product, Glossary, Task analyses (how many tasks have one).
 * @param {any} db @param {string} root @param {string} cur
 */
function hubNav(db, root, cur) {
  const repo = repoOfRoot(db, root);
  const n = repo ? db.taskDocs(repo.id).filter((/** @type {any} */ d) => d.sections > 0).length : 0;
  return `<nav class="hubnav" data-k="hubnav" aria-label="Analysis">${ANALYSIS_TABS.map(([t, label]) => `<button class="ttab${t === cur ? " on" : ""}" data-act="tab" data-tab="${t}"${t === cur ? ' aria-current="page"' : ""}>${icon(/** @type {any} */ (t), 14)} ${esc(label)}${t === "analysis" && n ? ` <span class="n">${n}</span>` : ""}</button>`).join("")}</nav>`;
}

/**
 * Task analyses (TASK-ANALYSIS): the repo's tasks that have an analysis, newest first, each
 * with its files; and the analysis files no task was found for, each to be given one.
 * @param {any} db @param {string} root
 */
function analysisHub(db, root) {
  const repo = repoOfRoot(db, root);
  if (!repo) return { repo: undefined, docs: [], orphans: [], tasks: [] };
  const docs = db.taskDocs(repo.id).filter((/** @type {any} */ d) => d.sections > 0).map((/** @type {any} */ d) => {
    const task = db.taskByKey(repo.id, d.scope);
    const { files, study } = analysisOf(db, repo.id, d.scope);
    return { key: d.scope, at: d.updated_at, task: task ? { id: task.id, title: task.title, status: task.status } : undefined, files, study };
  });
  const orphans = Object.entries(require("./analysis.js").orphans(db, repo.id)).sort((a, b) => b[1] - a[1]).map(([source, at]) => ({ source, at }));
  const tasks = db.tasksOf(repo.id).filter((/** @type {any} */ t) => !CONTAINERS.includes(t.key) && (t.status === "open" || t.status === "active"))
    .map((/** @type {any} */ t) => ({ id: t.id, key: t.key, title: t.title }));
  return { repo: { id: repo.id, name: repo.name }, docs, orphans, tasks };
}

/**
 * A title as text: a Markdown link keeps its text ("[#620](https://…) — T6: x" → "#620 — T6: x"),
 * and a key the title starts with goes when the page already shows it ("T6: x").
 * @param {string | undefined} title @param {string} [key]
 */
function plainTitle(title, key) {
  // Links, then emphasis and code marks (not "_": snake_case names keep theirs).
  let t = String(title ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|\*|`)(?=\S)(.*?\S)\1/g, "$2").replace(/\s+/g, " ").trim();
  if (key && t.toLowerCase().startsWith(key.toLowerCase())) {
    const rest = t.slice(key.length).replace(/^[\s:;,·–—|/-]+/, "");
    if (rest) t = rest;
  }
  return t;
}

/**
 * A heading in two languages ("Background / *Context*", #97: some older documents have headings in two languages): the first half, and the other
 * as a quiet second; a heading with no " / " is one.
 * @param {string} title @param {string} [key] @returns {{main: string, alt?: string}}
 */
function titleParts(title, key) {
  const m = /^(.+?)\s+\/\s+(.+)$/.exec(String(title ?? ""));
  if (!m) return { main: plainTitle(title, key) };
  const main = plainTitle(m[1], key);
  const alt = plainTitle(m[2]);
  return main ? { main, ...(alt && { alt }) } : { main: alt };
}

/** @param {string} title @param {string} [key] */
const titleHtml = (title, key) => {
  const t = titleParts(title, key);
  return `${esc(t.main)}${t.alt ? ` <span class="talt">· ${esc(t.alt)}</span>` : ""}`;
};

/** A file's own table of contents: the panel's tree does its work. @param {string} title */
const isContents = (title) => {
  const t = titleParts(title);
  return [t.main, t.alt].some((x) => /^(table of contents|contents|içindekiler|toc)$/i.test(x ?? ""));
};

/** The "###" headings of a section's text, outside code fences, in order. @param {string} body */
function subHeads(body) {
  const out = [];
  let fence = false;
  for (const l of String(body ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^###\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Task analyses laid out like Architecture and Product (TASK-ANALYSIS): on the left the tasks and,
 * under the chosen one, its contents; on the right its files in full, each section a
 * document section. Every task is drawn; the page shows the chosen one (state.asel).
 * @param {ReturnType<typeof analysisHub>} m
 */
function analysisHubHtml(m) {
  if (!m.docs.length && !m.orphans.length) {
    return `<div class="emptyhero" data-k="none">${require("./mascot.js").mascot(56)}<p>No task analyses in this repo yet. When the agent writes an analysis, plan or research note for a task, it shows up here; for past sessions, use "Imprimatur: Take Task Analyses from Past Sessions".</p></div>`;
  }
  const { renderMarkdown } = require("./docsView.js");
  const name = (/** @type {string} */ src) => (src.startsWith("plan:") ? "Plan (plan mode)" : src || "Analysis");
  // The tree (#97): each file (its own title), its "##" sections, their "###" headings.
  const isOverview = (/** @type {any} */ s) => /(^|--)overview$/.test(s.key ?? "");
  const goTo = (/** @type {string} */ key, /** @type {string} */ label) => `<a href="#sec-${key}" data-act="docGo" data-key="${key}">${label}</a>`;
  const subs = (/** @type {any} */ s) => {
    const hs = subHeads(s.body);
    return hs.length ? `<ol class="asub">${hs.map((h, n) => `<li data-k="t${s.id}h${n}">${goTo(`a${s.id}-h${n}`, titleHtml(h))}</li>`).join("")}</ol>` : "";
  };
  const fileToc = (/** @type {any} */ f) => {
    const head = isOverview(f.sections[0]) ? f.sections[0] : undefined;
    const rest = f.sections.filter((/** @type {any} */ s) => s !== head && !isContents(s.title));
    const label = head ? titleHtml(head.title) : esc(name(f.source));
    const kids = [...(head ? [subs(head)] : []), rest.length ? `<ol class="asub">${rest.map((/** @type {any} */ s) => `<li data-k="t${s.id}">${goTo(`a${s.id}`, titleHtml(s.title))}${subs(s)}</li>`).join("")}</ol>` : ""].join("");
    return `<li class="afile" data-k="tf-${esc(f.source)}">${goTo(`a${f.sections[0].id}`, label)}${kids}</li>`;
  };
  const studyToc = (/** @type {any} */ d) => (d.study ? `<li class="afile astudy" data-k="tstudy-${esc(d.key)}">${goTo(`a${d.study.id}`, `${icon("analysis", 12)} ${titleHtml(d.study.title)}`)}${subs(d.study)}</li>` : "");
  const toc = (/** @type {any} */ d) => `<ol class="atoc" data-k="toc-${esc(d.key)}" data-ak="${esc(d.key)}">${d.files.map(fileToc).join("")}${studyToc(d)}</ol>`;
  const item = (/** @type {any} */ d) => `<button class="aitem" data-act="asel" data-key="${esc(d.key)}" data-nav data-q="${esc(`${d.key} ${d.task?.title ?? ""} ${d.files.map((/** @type {any} */ f) => f.source).join(" ")}`)}"><span class="mono key">${esc(d.key)}</span><span class="ttl">${titleHtml(d.task?.title, d.key) || esc(d.key)}</span><span class="dim">${d.files.length} file${d.files.length === 1 ? "" : "s"}${d.study ? " · study note" : ""} · ${esc(day(d.at))}</span></button>${toc(d)}`;
  const aside = `<aside class="dtoc alist" data-k="alist" data-scroll="dtoc" data-navgroup="analysis"><div class="lbl" data-k="h">Tasks · ${m.docs.length}</div>${m.docs.map(item).join("")}${m.orphans.length ? `<button class="aitem orph" data-act="asel" data-key="__orphans" data-nav><span class="ttl">Analyses without a task</span><span class="dim">${m.orphans.length} file${m.orphans.length === 1 ? "" : "s"}</span></button>` : ""}</aside>`;
  // No file names here: the text is the point. A file's first section opens it (its path in the tooltip).
  const open = (/** @type {any} */ f) => (f.local && !f.source.startsWith("plan:") ? `<div class="dacts"><button class="mini aopen" data-act="anaOpen" data-file="${esc(f.source)}" data-repo="${m.repo?.id ?? ""}" title="Open the file: ${esc(name(f.source))}">${icon("external", 12)} open</button></div>` : "");
  // "###" headings get ids, for the tree's links.
  const bodyHtml = (/** @type {any} */ s) => {
    let n = 0;
    return renderMarkdown(s.body).replace(/<h3>/g, () => `<h3 id="sec-a${s.id}-h${n++}">`);
  };
  const article = (/** @type {any} */ f, /** @type {any} */ s, /** @type {number} */ j) => isContents(s.title)
    ? `<details class="dsec acontents" id="sec-a${s.id}" data-k="s${s.id}"><summary>${titleHtml(s.title)}</summary>${s.body ? `<div class="md">${bodyHtml(s)}</div>` : ""}</details>`
    : `<article class="dsec${j === 0 && /(^|--)overview$/.test(s.key ?? "") ? " afirst" : ""}" id="sec-a${s.id}" data-k="s${s.id}" data-nav tabindex="0"><div class="dsec-h"><h2>${titleHtml(s.title)}</h2>${j === 0 ? open(f) : ""}</div>${s.body ? `<div class="md">${bodyHtml(s)}</div>` : '<p class="empty">This section is empty.</p>'}</article>`;
  // The /study note under the analysis (#100), with how the last study went.
  const studyHtml = (/** @type {any} */ d) => {
    if (!d.study) return "";
    const m = d.study.mastery;
    const how = m
      ? `<p class="amastery"><b>Last study · ${esc(day(m.at))} · ${m.full}/${m.total} full</b>${m.weak.length ? `<br><span class="dim">Weak: ${m.weak.map((/** @type {string} */ q) => esc(q)).join(" · ")}</span>` : ""}</p>`
      : `<p class="amastery dim">You have not quizzed yourself yet: in Claude Code, run <span class="mono">/study ${esc(d.key)}</span></p>`;
    return `${d.files.length ? `<hr class="afsep" data-k="fs-study">` : ""}<article class="dsec astudy" id="sec-a${d.study.id}" data-k="s${d.study.id}" data-nav tabindex="0"><div class="dsec-h"><h2>${icon("analysis", 16)} ${titleHtml(d.study.title)}</h2></div>${how}${d.study.body ? `<div class="md">${bodyHtml(d.study)}</div>` : ""}</article>`;
  };
  const file = (/** @type {any} */ f, /** @type {number} */ i) => `${i ? `<hr class="afsep" data-k="fs-${esc(f.source)}">` : ""}${f.sections.map((/** @type {any} */ s, /** @type {number} */ j) => article(f, s, j)).join("")}`;
  const pane = (/** @type {any} */ d) => `<div class="apane" data-k="ap-${esc(d.key)}" data-ak="${esc(d.key)}"><section class="dhead" data-k="head"><span class="lbl">Task analysis · <span class="mono">${esc(d.key)}</span> · ${esc(m.repo?.name ?? "")}</span><h1>${titleHtml(d.task?.title, d.key) || esc(d.key)}</h1><p class="lead">Last updated · ${esc(when(d.at))} · ${d.files.length} file${d.files.length === 1 ? "" : "s"}${d.task ? ` · <button class="link" data-act="open" data-id="${d.task.id}" data-f="${bucketOf(d.task.status)}">Go to task ${icon("arrow", 12)}</button>` : ""}</p></section>${d.files.map(file).join("")}${studyHtml(d)}</div>`;
  const options = m.tasks.map((/** @type {any} */ t) => `<option value="${t.id}">${esc(t.key)} · ${esc((t.title || "").slice(0, 60))}</option>`).join("");
  const orphans = m.orphans.length
    ? `<div class="apane" data-k="ap-orphans" data-ak="__orphans"><section class="dhead" data-k="head"><span class="lbl">Task analysis · ${esc(m.repo?.name ?? "")}</span><h1>Analyses without a task</h1><p class="lead">Analysis files no task was found for: assign one to a task and it moves into that task's analysis.</p></section>${m.orphans.map((o) => `<div class="orow dsec" data-k="o-${esc(o.source)}" data-q="${esc(o.source)}"><span class="mono">${esc(o.source)}</span><span class="dim">${esc(day(o.at))}</span><select data-change="anaAssign" data-file="${esc(o.source)}" aria-label="Assign to a task"><option value="">Assign to a task…</option>${options}</select></div>`).join("")}</div>`
    : "";
  return `<div class="doc ahub" data-k="ahub">${aside}<main class="dpage adoc" data-k="adoc">${m.docs.map(pane).join("")}${orphans}</main></div>`;
}

const SEV_TR = { high: "high", medium: "medium", low: "low" };
/**
 * The BEST task's recommendations (#86): status → (reason) → category → component → recommendation,
 * each with its source, evidence and next step, and Applied / Dismiss / Reopen; then
 * the source map they were read from.
 * @param {{groups: any[], map?: any}} best
 */
function bestBlock(best) {
  const rec = (/** @type {any} */ r) => {
    const b = r.links.best;
    const open = r.status === "open";
    const last = best.map?.lastRun?.[b.category ?? b.pillar];
    const stale = open && b.seen && last && b.seen < last;
    const acts = open
      ? `<button class="primary" data-act="rec" data-op="done" data-id="${r.id}">Applied</button><button class="ghost" data-act="recDismiss" data-id="${r.id}">Dismiss…</button>`
      : `<button class="ghost" data-act="rec" data-op="open" data-id="${r.id}">Reopen</button>`;
    return `<div class="bfind s-${esc(r.status)}" id="rec-${r.id}" data-k="r${r.id}" data-q="${esc(r.title)}"><div class="row1"><span class="sev sev-${esc(b.severity)}">${esc(SEV_TR[/** @type {keyof typeof SEV_TR} */ (b.severity)] ?? b.severity)}</span><span class="ttl">${esc(r.title)}</span>${stale ? '<span class="dim">not seen in the last run</span>' : ""}</div>
<div class="bwhy">${esc(r.body?.split("\n\n")[0] ?? "")}</div>
<div class="bmeta"><span><b>Next step:</b> ${esc(b.next_step ?? "")}</span><span><b>Evidence:</b> <span class="mono">${esc((b.evidence ?? []).join(", "))}</span></span><span><b>Source:</b> <a href="#" data-act="url" data-url="${esc(b.source?.url ?? "")}">${esc(b.source?.title ?? b.source?.url ?? "")}</a> <span class="dim">(${esc(b.source?.version_or_date ?? "")})</span></span>${b.decision_ids?.length ? `<span><b>Related decisions:</b> ${b.decision_ids.map((/** @type {number} */ id) => `<a href="#" data-act="showRecord" data-id="${id}">#${id}</a>`).join(", ")}</span>` : ""}</div>
<div class="acts">${acts}</div></div>`;
  };
  const group = (/** @type {any} */ g, /** @type {number} */ depth) =>
    `<details class="agrp d${depth}" data-k="${esc(g.key)}"${g.key === "st:open" || (depth === 1 && g.key.startsWith("cat:")) ? " open" : ""}><summary><span class="alabel">${esc(g.label)}</span><span class="dim">${g.count}</span></summary><div class="abody">${g.children ? g.children.map((/** @type {any} */ c) => group(c, depth + 1)).join("") : g.records.map(rec).join("")}</div></details>`;
  const open = best.groups.find((g) => g.key === "st:open")?.count ?? 0;
  const map = best.map
    ? `<details class="agrp d0" data-k="srcmap"><summary><span class="alabel">Source map</span><span class="dim">${best.map.components.length} component${best.map.components.length === 1 ? "" : "s"}</span></summary><div class="abody">${best.map.components.map((/** @type {any} */ c) => `<div class="afind"><span class="ttl"><b>${esc(c.name)}</b> <span class="dim">${esc(c.version)}</span></span><span class="dim">${[c.context7 && `Context7 ${esc(c.context7)}`, c.vendor && c.vendor !== "other" && `${esc(c.vendor)} docs MCP`, c.changelog_url && `<a href="#" data-act="url" data-url="${esc(c.changelog_url)}">changelog</a>`].filter(Boolean).join(" · ") || "no source"}</span></div>`).join("")}</div></details>`
    : "";
  return `<section class="blk" data-k="best" aria-label="Project"><div class="h2row" data-k="h"><h2>Project <span class="dim">· ISO/IEC 25010 + NIST SSDF · ${open} open</span></h2><button class="ghost" data-act="bestRun">Review again</button></div>${best.groups.map((g) => group(g, 0)).join("") || '<p class="empty" data-k="none">No recommendations yet.</p>'}${map}</section>`;
}

const AUDIT_LEVEL_TR = { error: "error", warning: "warning", info: "info" };
/**
 * The AUDIT task's findings (#77): status → (reason) → source → category → rule → finding,
 * as nested <details>; the open findings start unfolded.
 * @param {any[]} groups auditGroups(…, {lang: "tr"})
 */
function auditBlock(groups) {
  const levels = (/** @type {Record<string, number>} */ n) =>
    ["error", "warning", "info"].filter((l) => n[l]).map((l) => `<span class="alv a-${l}">${n[l]} ${AUDIT_LEVEL_TR[/** @type {keyof typeof AUDIT_LEVEL_TR} */ (l)]}</span>`).join("");
  const finding = (/** @type {any} */ r) => {
    const a = r.links.audit;
    const where = `${String(a.file).replace(/^.*?[\\/]\.claude[\\/]/, "~/.claude/")}${a.line ? `:${a.line}` : ""}`;
    const act = r.status === "open" ? `<button class="link" data-act="recDismiss" data-id="${r.id}">Dismiss…</button>` : `<button class="link" data-act="rec" data-op="open" data-id="${r.id}">Reopen</button>`;
    return `<div class="afind s-${esc(r.status)}" id="rec-${r.id}" data-k="r${r.id}" data-q="${esc(r.title)}"${r.body ? ` title="${esc(r.body)}"` : ""}><span class="adot a-${esc(a.level)}" aria-hidden="true"></span><span class="ttl">${esc(r.title.replace(/^[^:]+:\s*/, ""))}</span><span class="mono dim">${esc(where)}</span>${act}</div>`;
  };
  const group = (/** @type {any} */ g, /** @type {number} */ depth) =>
    `<details class="agrp d${depth}" data-k="${esc(g.key)}"${g.key === "st:open" || (depth === 1 && g.key.startsWith("src:") && g.count <= 50) ? " open" : ""}><summary><span class="alabel">${esc(g.label)}</span><span class="dim">${g.count}</span>${levels(g.levels)}</summary><div class="abody">${g.children ? g.children.map((c) => group(c, depth + 1)).join("") : g.records.map(finding).join("")}</div></details>`;
  const open = groups.find((g) => g.key === "st:open")?.count ?? 0;
  return `<section class="blk" data-k="audit" aria-label="Agent setup"><h2>Agent setup <span class="dim">· agnix · ${open} open</span></h2>${groups.map((g) => group(g, 0)).join("") || '<p class="empty" data-k="none">No findings.</p>'}</section>`;
}

/** The properties rail. @param {NonNullable<ReturnType<typeof tasksPage>["cur"]>} c */
function railHtml(c) {
  const prop = (/** @type {string} */ label, /** @type {string} */ value) => `<div class="prop"><span class="lbl">${label}</span><span class="val">${value}</span></div>`;
  const status = `<select data-change="taskStatus" data-task="${c.id}" aria-label="Status">${TASK_STATUSES.map((s) => `<option value="${s}"${s === c.status ? " selected" : ""}>${STATUS_TR[/** @type {keyof typeof STATUS_TR} */ (s)]}</option>`).join("")}</select>`;
  return `<aside class="rail" data-k="rail-${c.id}" aria-label="Properties">${prop("Status", status)}${prop("Repo", esc(c.repo?.name ?? "—"))}${prop("Epic", c.epic ? `${openTask(c.epic.id, c.epic.status, c.epic.key, "mono")} ${esc(c.epic.title)}` : "—")}${prop("Records", `${c.openCount} open / ${c.recordCount}`)}${prop("Last change", c.last ? `${esc(when(c.last.at))}${c.last.who ? ` · ${esc(c.last.who.toLowerCase())}` : ""}` : "—")}
<div class="links"><span class="lbl">On this task</span><a href="#" data-act="edits" data-key="${esc(c.key)}">Show in Agent changes</a>${c.url ? `<a href="#" data-act="url" data-url="${esc(c.url)}">Open on GitHub ${icon("external", 13)}</a>` : ""}</div></aside>`;
}

/** @param {ReturnType<typeof inboxModel>} m */
function inboxHtml(m) {
  const seg = `<div class="seg" role="group" aria-label="Scope"><button class="fpill${m.all ? "" : " on"}" data-act="scope" data-all="0" aria-pressed="${!m.all}">This repo</button><button class="fpill${m.all ? " on" : ""}" data-act="scope" data-all="1" aria-pressed="${m.all}">All repos</button></div>`;
  const top = `<div class="toprow" data-k="top"><div><h1>Waiting on you</h1><p class="lead">Everything the agent is waiting on from you, task by task. When you answer or do it, the agent sees it on its next turn.</p></div>${seg}</div>`;
  // A click on a bucket shows its kind alone (the page script filters), again shows all.
  const buckets = `<div class="buckets" role="group" aria-label="Kind" data-k="buckets">${m.buckets.map((b) => `<button class="bucket b-${b.id}" data-k="${b.id}" data-act="ibucket" data-b="${b.id}" aria-pressed="false"><span class="n">${b.n}</span><span class="bl">${b.label}</span><span class="dim">${b.hint}</span></button>`).join("")}</div>`;
  // One chip per task, with what is still open on it: a click shows that task alone (the page script filters).
  const chips = m.groups.length > 1
    ? `<div class="seg itasks" role="group" aria-label="Task" data-k="itasks">${m.groups.map((g) => `<button class="fpill" data-act="itask" data-id="${g.task?.id ?? -1}" aria-pressed="false" title="${esc(g.task?.title ?? "End-of-turn asks with no known task")}"><span class="mono">${esc(g.task?.key ?? "No task")}</span> <span class="dim cnt">${g.items.filter((r) => !r.done).length}</span></button>`).join("")}</div>`
    : "";
  const groups = m.groups.length
    ? m.groups.map((g) => `<section class="igrp" data-k="g${g.task?.id ?? "none"}" data-task="${g.task?.id ?? -1}"><h2 data-k="h">${g.task ? `${openTask(g.task.id, g.task.status, g.task.key)}<span>${esc(g.task.title)}</span>` : `<span>No task</span><span class="dim">asked by the agent at the end of a turn, with no task</span>`}<span class="dim">${esc(g.repo?.name ?? "")}</span></h2>${g.items.map((r) => askCard(r)).join("")}</section>`).join("")
    : `<div class="emptyhero" data-k="none">${require("./mascot.js").mascot(56)}<p><b>All good.</b><br>Nothing is waiting on you.</p></div>`;
  return `<div class="inbox" data-k="inbox">${top}${buckets}${chips}<div class="igroups" data-k="groups" data-navgroup="inbox">${groups}<p class="empty" id="ifnone" data-k="ifnone" hidden>Nothing in this filter is waiting on you.</p></div></div>`;
}

/** @param {ReturnType<typeof homeModel>} m */
function homeHtml(m) {
  const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
  const top = `<div data-k="top"><h1>${esc(m.repoName)}</h1><p class="lead">${m.done} / ${m.total} tasks done · ${m.active} in progress · ${m.open} open</p><div class="progress" role="progressbar" aria-label="Task progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width: ${pct}%"></div></div></div>`;
  const pointers = `<section class="card left" aria-label="Where we left off"><h2 class="cap">${icon("arrow", 18)}Where we left off</h2>${m.pointers.map((p) => `<a href="#" class="ptr" data-act="open" data-id="${p.id}" data-f="${bucketOf(p.status)}" data-rec="${p.record}"><span class="pm"><span class="mono">${esc(p.key)}</span><span class="dim">${esc(p.task)}</span></span><span class="ptitle">${esc(p.next)}${p.mine ? ' <b class="mine">(on you)</b>' : ""}</span></a>`).join("") || '<p class="empty">None of the open tasks has where we left off marked.</p>'}</section>`;
  const asks = `<section class="card" aria-label="Waiting on you"><h2 class="cap row"><span>Waiting on you</span><span class="dim">${m.askCount}</span></h2>${m.asks.map((a) => `<a href="#" class="hask" data-act="open" data-id="${a.task}" data-f="${bucketOf(a.status ?? "active")}" data-rec="${a.id}">${kindChip(a.kind, a.kind === "question" ? "Question" : a.kind === "test" ? "Test" : "To-do")}<span class="ttl">${esc(a.title)}</span><span class="mono dim">${esc(a.key)}</span></a>`).join("") || '<p class="empty">Nothing is waiting on you.</p>'}</section>`;
  const head = `<tr><th>Task</th><th>Status</th><th>Where we left off</th><th>On you</th><th>To-dos</th><th>Last change</th></tr>`;
  const rows = m.rows.map((t) => `<tr data-k="t${t.id}" id="h-${t.id}" data-nav tabindex="0" data-act="open" data-id="${t.id}" data-f="${bucketOf(t.status)}" data-q="${esc(t.q)}"><td><span class="mono key">${esc(t.key)}</span> <b>${esc(t.title)}</b></td><td>${statusChip(t.status)}</td><td class="dim">${esc(t.pointer ?? "—")}</td><td class="${t.asks ? "mine" : "dim"}">${t.asks || "—"}</td><td>${t.todos ? `${t.openTodos} / ${t.todos}` : "no plan"}</td><td class="dim">${esc(t.when)}</td></tr>`).join("");
  const table = `<section class="blk" data-k="table" aria-label="Tasks"><h2>Tasks</h2><div class="tablewrap"><table class="htable"><thead>${head}</thead><tbody data-navgroup="home">${rows || '<tr><td colspan="6" class="empty">No tasks in this repo yet.</td></tr>'}</tbody></table></div></section>`;
  const loose = m.loose.length
    ? `<section class="blk" data-k="loose" data-navgroup="loose" aria-label="Waiting on you, no task"><h2><span class="odot" aria-hidden="true"></span>Waiting on you, no task <span class="dim">· ${m.loose.length} · asked by the agent at the end of a turn, with no task</span></h2>${m.loose.map((r) => askCard(r)).join("")}</section>`
    : "";
  return `<div class="home" data-k="home">${top}${unreadHtml(m.unread)}<div class="grid2" data-k="cards">${pointers}${asks}</div>${loose}${table}</div>`;
}

/**
 * The visible tab's HTML (not the edits graph, which graphView.js draws).
 * @param {any} db @param {string} root @param {any} view
 * @param {{waiting?: any[], linkOf?: (root: string, key: string) => string | undefined, now?: number}} [o]
 */
function paneHtml(db, root, view, o = {}) {
  if (!db) return `<p class="empty" data-k="nodb">Could not open the Imprimatur database: ${esc(o.error ?? "unavailable")}</p>`;
  if (view.tab === "home") return homeHtml(homeModel(db, root, o));
  if (view.tab === "tasks") return tasksHtml(tasksPage(db, root, view, o));
  if (view.tab === "inbox") return inboxHtml(inboxModel(db, root, { all: view.all, waiting: o.waiting, now: o.now, placeOf: o.placeOf }));
  if (view.tab === "architecture" || view.tab === "product" || view.tab === "glossary") {
    const docs = require("./docsView.js");
    return hubNav(db, root, view.tab) + docs.docHtml(docs.docModel(db, root, view.tab, view));
  }
  if (view.tab === "analysis") return hubNav(db, root, "analysis") + analysisHubHtml(analysisHub(db, root));
  if (view.tab === "exercises") {
    const x = require("./exerciseView.js");
    return x.exerciseHtml(x.exerciseModel(db));
  }
  return "";
}

/** Record actions from the page and the status each sets (a Map: no inherited keys). */
const RECORD_OPS = new Map([["done", "done"], ["open", "open"], ["drop", "dropped"]]);

const num = (/** @type {any} */ v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Imprimatur: bad id ${v}`);
  return n;
};

/**
 * A write from the panel, as the user: a record's status or 👉, an answer to a
 * question (an answer record under it, the question done), a quick-add, a task's status.
 * Document sections (#72) go to docsView.js with the panel's repo.
 * @param {any} db @param {any} m the page's message @param {{kind: "user", id?: string}} actor @param {string} [root]
 */
function applyMessage(db, m, actor, root) {
  switch (m?.type) {
    case "docSave":
    case "docNew":
    case "docStatus":
      return require("./docsView.js").applyDocMessage(db, m, actor, root);
    case "exStep":
    case "exNote":
    case "exDrop":
    case "exResume":
      // The user's exercises (#108): of no repo.
      return require("./exerciseView.js").applyExerciseMessage(db, m);
    case "read":
      // Sections the user read (#92).
      if (!Array.isArray(m.ids) || !m.ids.length || m.ids.length > 500) throw new Error("Imprimatur: bad section ids");
      return db.markSectionsRead(m.ids.map(num));
    case "rec": {
      const id = num(m.id);
      if (m.op === "pointer") return db.setPointer(id, actor);
      const status = RECORD_OPS.get(m.op);
      if (!status) throw new Error(`Imprimatur: unknown record action ${String(m.op)}`);
      return db.updateRecord(id, { status }, actor);
    }
    case "recStep": {
      // A step ticked in the body: that line's box rewritten; a line that is no step (the body changed since) is left.
      const id = num(m.id);
      const rec = db.record(id);
      if (!rec) throw new Error(`Imprimatur: no record ${m.id}`);
      const body = require("./docsView.js").toggleStep(rec.body ?? "", Number.isInteger(m.line) && m.line >= 0 ? m.line : -1, !!m.done);
      return body === (rec.body ?? "") ? rec : db.updateRecord(id, { body }, actor);
    }
    case "answer": {
      const id = num(m.id);
      const parts = splitText(m.text);
      if (!parts) throw new Error("Imprimatur: the answer is empty");
      // The answer and the question's "done" commit together, or neither does.
      return db.answerQuestion(id, parts, actor);
    }
    case "add": {
      const task = db.taskById(num(m.task));
      if (!task) throw new Error(`Imprimatur: no task ${m.task}`);
      const fields = parseQuickAdd(m.text);
      if (!fields) throw new Error("Imprimatur: nothing to add");
      return db.addRecord(task.id, fields, actor);
    }
    case "anaAssign": {
      // An analysis file with no task given this one: only a file in the repo's orphans list.
      const task = db.taskById(num(m.task));
      if (!task) throw new Error(`Imprimatur: no task ${m.task}`);
      const repo = db.repos().find((/** @type {any} */ r) => r.id === task.repo_id);
      const a = require("./analysis.js");
      if (typeof m.file !== "string" || !Object.hasOwn(a.orphans(db, task.repo_id), m.file)) throw new Error(`Imprimatur: ${m.file} is not an analysis waiting for a task`);
      return a.assign(db, task.repo_id, repo.root, m.file, task.key, actor);
    }
    case "taskStatus": {
      const task = db.taskById(num(m.task));
      if (!task) throw new Error(`Imprimatur: no task ${m.task}`);
      if (!TASK_STATUSES.includes(m.status)) throw new Error(`Imprimatur: bad task status ${m.status}`);
      return db.upsertTask(task.repo_id, task.key, { status: m.status }, actor);
    }
    default:
      throw new Error(`Imprimatur: unknown panel message ${m?.type}`);
  }
}

/**
 * The page's view state, kept to what is allowed (it comes from the webview).
 * @param {any} v @returns {Record<string, any>}
 */
function cleanView(v) {
  if (!v || typeof v !== "object") return {};
  const ids = (/** @type {any} */ a) => (Array.isArray(a) ? a.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100) : undefined);
  /** @type {Record<string, any>} */
  const out = {};
  // Waiting on you is gone: a view saved on it opens Home.
  if (v.tab === "inbox") out.tab = "home";
  else if (TABS.includes(v.tab)) out.tab = v.tab;
  if (v.sel === null || (Number.isInteger(Number(v.sel)) && Number(v.sel) > 0)) out.sel = v.sel === null ? null : Number(v.sel);
  if (FILTERS.includes(v.filter)) out.filter = v.filter;
  if (typeof v.all === "boolean") out.all = v.all;
  if (ids(v.showDone)) out.showDone = ids(v.showDone);
  if (ids(v.old)) out.old = ids(v.old);
  // The section open for editing on a document tab (#72): "architecture:12", "product:new", "glossary:3".
  if (v.edit === null || (typeof v.edit === "string" && /^(architecture|product|glossary):(new|\d+)$/.test(v.edit))) out.edit = v.edit;
  return out;
}

/** Styles of the tabs: theme.js's tokens (accent, surfaces, radii, type) over the theme's own colours. */
const TASKS_CSS = `
  [hidden] { display: none !important; }
  .ic { flex: none; vertical-align: -3px; }
  .mono { font-family: var(--vscode-editor-font-family); font-size: 12px; font-weight: 600; }
  .dim { color: var(--vscode-descriptionForeground); }
  .mine { color: var(--acc); font-weight: 700; }
  .unr { color: var(--vscode-editorInfo-foreground, var(--acc)); font-weight: 700; }
  .unread { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); }
  .unread .uhead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; } .unread .lbl { font-weight: 700; }
  .unread .urow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 2px 0; }
  .unread.compact { padding: 8px 14px; } .unread .ulink { font-weight: 600; } .unread .urow a { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  #pane { --card: var(--surface); line-height: 1.5; padding-bottom: 32px; }
  #pane h1 { margin: 0; font-size: var(--fs-h1); line-height: 1.25; font-weight: 800; letter-spacing: -.01em; }
  #pane h2 { margin: 0; font-size: var(--fs-h3); font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  #pane a { color: var(--vscode-textLink-foreground); text-decoration: none; } #pane a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  #pane button { font: inherit; color: inherit; cursor: pointer; }
  #pane :focus-visible, #pane .trow:focus-visible, #pane [data-nav]:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .lead { margin: 4px 0 0; color: var(--vscode-descriptionForeground); }
  #pane .empty { color: var(--vscode-descriptionForeground); padding: 8px 0; margin: 0; opacity: 1; }
  .fpill { padding: 3px 10px; border-radius: 14px; border: 1px solid var(--line); background: transparent; font-weight: 600; font-size: 12px; }
  .fpill:hover { background: var(--vscode-list-hoverBackground); }
  .fpill.on { border-color: var(--acc); background: color-mix(in srgb, var(--acc) 18%, transparent); }
  .pills, .seg { display: flex; flex-wrap: wrap; gap: 6px; }
  .link { background: none; border: 0; padding: 2px 4px; color: var(--vscode-textLink-foreground) !important; font-weight: 600; font-size: 12px; }
  .ghost { padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; font-size: 12px; font-weight: 600; }
  .ghost:hover, .dashed:hover { background: var(--vscode-list-hoverBackground); }
  .dashed { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px dashed var(--line); border-radius: 6px; background: transparent; font-weight: 600; }
  .primary { padding: 6px 14px; border: 0; border-radius: var(--r-md); background: var(--acc); color: var(--acc-ink) !important; font-weight: 700; }
  .primary:hover { background: color-mix(in srgb, var(--acc) 88%, var(--vscode-foreground)); }
  .mini { padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-pill); background: transparent; font-size: var(--fs-xs); font-weight: 600; opacity: 0; }
  .trec:hover .mini, .trec:focus-within .mini { opacity: .9; }
  .st { display: inline-flex; padding: 1px 9px; border-radius: 10px; font-weight: 700; font-size: 12px; border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
  .st-active { --c: var(--vscode-charts-blue); } .st-open { --c: var(--vscode-descriptionForeground); } .st-done { --c: var(--vscode-charts-green); } .st-dropped { --c: var(--vscode-disabledForeground); }
  .kchip { flex: none; display: inline-flex; padding: 0 8px; border-radius: 10px; font-size: 12px; font-weight: 700; border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 18%, transparent); }
  .k-question { --c: var(--acc); } .k-todo { --c: var(--vscode-charts-blue); } .k-test { --c: var(--vscode-charts-yellow); }
  .k-decision { --c: var(--vscode-charts-purple); } .k-adr { --c: var(--vscode-charts-green); } .k-pdr { --c: var(--vscode-charts-yellow); }
  .k-note, .k-answer { --c: var(--vscode-descriptionForeground); } .k-fixme { --c: var(--vscode-charts-red); }
  .card { padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--card); box-shadow: var(--shadow); }
  body.vscode-high-contrast .card, body.vscode-high-contrast-light .card { border-color: var(--vscode-contrastBorder); }
  .card.ask { display: flex; flex-direction: column; gap: 8px; }
  .row1 { display: flex; align-items: flex-start; gap: 10px; } .row1 .ttl { flex: 1; font-weight: 600; min-width: 0; } .age { flex: none; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .body { white-space: pre-wrap; color: var(--vscode-descriptionForeground); font-size: 13px; }
  .steps { font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--line); white-space: nowrap; } .steps.all { border-color: var(--acc); color: var(--acc); }
  .body.md { white-space: normal; font-size: 13px; line-height: 1.5; min-width: 0; max-width: 100%; } .body.md pre { white-space: pre; } .body.md p { margin: 6px 0; } .body.md ul, .body.md ol { margin: 6px 0; padding-left: 20px; }
  .answer { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
  .answer textarea { flex: 1 1 320px; resize: vertical; min-height: 40px; padding: 7px 10px; border-radius: 6px; font: inherit;
    border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .acts { display: flex; gap: 8px; }
  .card.ask.done { box-shadow: none; } .card.ask.done .ttl { text-decoration: line-through; }
  .okline { font-size: 13px; font-weight: 600; color: var(--vscode-testing-iconPassed); display: inline-flex; align-items: center; gap: 6px; }
  .card.sent { opacity: .6; }
  .row1 .src { flex: none; font-size: 12px; padding: 0 8px; border-radius: 10px; border: 1px dashed var(--line); color: var(--vscode-descriptionForeground); }
  .card.turn p.body { margin: 0; }
  .card.turn details.full summary { cursor: pointer; font-size: 13px; color: var(--vscode-descriptionForeground); } .card.turn details.full pre { white-space: pre-wrap; font-size: 12px; max-height: 320px; overflow: auto; }
  .flash { animation: flash 1.6s ease-out 1; }
  @keyframes flash { 0%, 30% { box-shadow: 0 0 0 2px var(--acc); background: color-mix(in srgb, var(--acc) 22%, transparent); } 100% { box-shadow: 0 0 0 0 transparent; } }
  /* Tasks */
  .tl { display: flex; flex-wrap: wrap; align-items: stretch; margin: 0 -12px; border-top: 1px solid var(--line); min-height: calc(100vh - var(--appbar-h, 52px)); }
  .tlist { flex: 1 1 260px; max-width: 320px; min-width: 0; padding: 14px 10px; background: var(--vscode-sideBar-background); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 12px; max-height: calc(100vh - var(--appbar-h, 52px)); overflow: auto; position: sticky; top: var(--appbar-h, 52px); box-sizing: border-box; }
  .tl-head { display: flex; justify-content: space-between; align-items: center; padding: 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .tl-head .link { text-transform: none; letter-spacing: 0; }
  .rows { display: flex; flex-direction: column; gap: 2px; } .grp { display: flex; flex-direction: column; gap: 2px; }
  .grp-h { padding: 8px 8px 2px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .trow { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; }
  .trow:hover { background: var(--vscode-list-hoverBackground); }
  .trow.on { background: var(--acc-soft); box-shadow: inset 3px 0 0 var(--acc); color: var(--vscode-foreground) !important; }
  .sdot { margin-top: 5px; width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--c); }
  .s-active { --c: var(--vscode-charts-blue); } .s-open { --c: var(--vscode-descriptionForeground); } .s-done { --c: var(--vscode-charts-green); } .s-dropped { --c: var(--vscode-disabledForeground); }
  .tcol { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .tmeta { display: flex; gap: 8px; font-size: var(--fs-sm); color: var(--muted); } .trow.on .tmeta { color: inherit; } .tttl { font-weight: 600; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .tpage { flex: 999 1 520px; min-width: 0; padding: 20px 28px 40px; display: flex; flex-direction: column; gap: 22px; box-sizing: border-box; }
  .thead { display: flex; flex-direction: column; gap: 8px; } .thead .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .thead .key { font-size: 13px; color: var(--vscode-descriptionForeground); } .sum { margin: 0; max-width: 820px; white-space: pre-line; color: var(--vscode-descriptionForeground); }
  .ext { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; font-size: 13px; }
  .callout { display: flex; align-items: flex-start; gap: 12px; margin-top: 4px; padding: 11px 15px; border-radius: 8px; border: 1px solid var(--acc); background: color-mix(in srgb, var(--acc) 12%, transparent); color: var(--acc); }
  .callout > div { display: flex; flex-direction: column; gap: 1px; color: var(--vscode-foreground); }
  .lbl { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .callout .lbl { color: var(--acc); } .ptitle { font-weight: 600; }
  .blk { display: flex; flex-direction: column; gap: 6px; }
  .odot { width: 8px; height: 8px; border-radius: 50%; background: var(--acc); }
  .h2row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .todos { display: flex; flex-direction: column; gap: 1px; }
  .trec { display: flex; align-items: flex-start; gap: 10px; padding: 6px 10px; border-radius: 6px; }
  .trec:hover { background: var(--vscode-list-hoverBackground); }
  .trec .ttl { flex: 1; min-width: 0; } .trec.done .ttl { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .check { flex: none; margin-top: 2px; width: 18px; height: 18px; padding: 0; border-radius: 4px; border: 2px solid var(--vscode-checkbox-border, var(--vscode-descriptionForeground)); background: transparent;
    display: flex; align-items: center; justify-content: center; }
  .check:hover { border-color: var(--acc); }
  .check.on { border-color: var(--vscode-testing-iconPassed); background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background) !important; }
  .check .ic { stroke-width: 4; }
  .next { flex: none; display: inline-flex; align-items: center; gap: 3px; padding: 0 8px; border-radius: 10px; font-size: 12px; font-weight: 700; color: var(--acc); background: color-mix(in srgb, var(--acc) 16%, transparent); }
  .owner { flex: none; padding: 0 8px; border-radius: 10px; border: 1px solid var(--line); font-size: 12px; font-weight: 700; }
  .owner.me { border-color: var(--acc); color: var(--acc); }
  .quick { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border: 1px dashed var(--line); border-radius: 6px; color: var(--vscode-descriptionForeground); }
  .quick input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--vscode-foreground); font: inherit; outline: none; }
  .quick:focus-within { border-color: var(--vscode-focusBorder); border-style: solid; }
  .note { display: flex; align-items: flex-start; gap: 10px; padding: 4px 10px; } .ncol { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ans { display: block; padding-left: 4px; color: var(--vscode-foreground); } .ans .ic { color: var(--acc); } .ans .body { display: block; }
  #waiting { max-width: 1000px; margin: 0 auto; }
  #pane.stale > * { opacity: .4; pointer-events: none; }
  #pane.stale::before { content: "Loading…"; display: block; padding: 12px 0; color: var(--vscode-descriptionForeground); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .bfind { padding: 8px 0 8px 16px; border-bottom: 1px solid var(--vscode-widget-border, transparent); } .bfind .row1 { display: flex; gap: 8px; align-items: baseline; }
  .bfind .ttl { font-weight: 600; } .bfind.s-done .ttl, .bfind.s-dropped .ttl { color: var(--muted); } .bwhy { margin: 4px 0; }
  .bmeta { display: flex; flex-direction: column; gap: 2px; font-size: .92em; } .bfind .acts { display: flex; gap: 8px; margin-top: 6px; }
  .sev { font-size: .8em; font-weight: 700; padding: 1px 6px; border-radius: 8px; } .sev-high { background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.2)); }
  .sev-medium { background: var(--vscode-inputValidation-warningBackground, rgba(255,165,0,.2)); } .sev-low { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .agrp { margin: 2px 0; } .agrp > summary { cursor: pointer; display: flex; gap: 8px; align-items: baseline; padding: 4px 0; font-weight: 600; }
  .agrp .agrp { margin-left: 16px; } .agrp.d0 > summary { font-size: 1.05em; } .abody { padding-left: 2px; }
  .afind { display: flex; gap: 8px; align-items: baseline; padding: 3px 0 3px 16px; } .afind .ttl { flex: 1; } .afind.s-done .ttl, .afind.s-dropped .ttl { color: var(--muted); }
  .adot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; } .adot.a-error { background: var(--vscode-problemsErrorIcon-foreground); }
  .adot.a-warning { background: var(--vscode-problemsWarningIcon-foreground); } .adot.a-info { background: var(--vscode-problemsInfoIcon-foreground); }
  .alv { font-size: .85em; font-weight: 500; } .alv.a-error { color: var(--vscode-problemsErrorIcon-foreground); } .alv.a-warning { color: var(--vscode-problemsWarningIcon-foreground); } .alv.a-info { color: var(--vscode-problemsInfoIcon-foreground); }
  .ttabs { display: flex; flex-wrap: wrap; gap: 4px; margin: 14px 0 4px; border-bottom: 1px solid var(--line); }
  .ttab { padding: 7px 12px; border: 0; border-bottom: 3px solid transparent; background: transparent; color: inherit; font: inherit; font-size: var(--fs-body); font-weight: 700; cursor: pointer; margin-bottom: -1px; }
  .ttab:hover { color: var(--acc); } .ttab.on { border-bottom-color: var(--acc); color: var(--acc); }
  .ttab .n { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: var(--r-pill); background: var(--acc-soft); color: var(--acc); font-size: var(--fs-xs); text-align: center; }
  .hubnav { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 14px; border-bottom: 1px solid var(--line); }
  .alist .aitem { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 8px 10px; border: 1px solid transparent; border-radius: var(--r-md, 8px); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .alist .aitem:hover { background: var(--acc-soft); } .alist .aitem.on { border-color: var(--acc); background: var(--acc-soft); }
  .alist .aitem .ttl { font-weight: 700; overflow-wrap: anywhere; } .alist { overflow-x: hidden; } .alist .aitem.orph { margin-top: 8px; }
  .atoc { list-style: none; margin: 4px 0 10px 10px; padding: 0 0 0 10px; border-left: 2px solid var(--acc-line); display: flex; flex-direction: column; gap: 2px; }
  .atoc a { display: block; padding: 3px 6px; border-radius: 6px; color: inherit !important; } .atoc a:hover { background: var(--acc-soft); text-decoration: none !important; }
  .atoc .asep { height: 0; margin: 6px 0; border-top: 1px dashed var(--line); }
  .atoc .afile > a { font-weight: 700; } .atoc .afile + .afile { margin-top: 6px; }
  .atoc li:has(> .asub) > a { position: relative; padding-left: 18px; } .atoc li:has(> .asub) > a::before { content: "▾"; position: absolute; left: 4px; color: var(--vscode-descriptionForeground); }
  .atoc li.shut > a::before { content: "▸"; } .atoc li.shut > .asub { display: none; }
  .alist .aitem .key::after { content: " ▾"; color: var(--vscode-descriptionForeground); } .alist .aitem.folded .key::after { content: " ▸"; }
  .atoc .asub { list-style: none; margin: 2px 0 2px 8px; padding: 0 0 0 8px; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 1px; }
  .atoc .asub a { font-weight: 600; } .atoc .asub .asub a { font-weight: 400; font-size: 12px; color: var(--vscode-descriptionForeground) !important; }
  .talt { font-weight: 400; color: var(--vscode-descriptionForeground); }
  .dsec.astudy { border-color: var(--acc-line); } .amastery { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--acc-soft); }
  .dsec.afirst h2 { font-size: 19px !important; } .acontents summary { cursor: pointer; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .adoc .apane { display: flex; flex-direction: column; gap: 18px; }
  .afsep { width: 100%; margin: 6px 0; border: 0; border-top: 1px dashed var(--line); }
  .aopen { opacity: 1; padding: 2px 10px; border-color: var(--acc); color: var(--acc); font-size: var(--fs-sm); font-weight: 700; cursor: pointer; }
  .orow.dsec { flex-direction: row; align-items: center; }
  .analink { opacity: 1; border-color: var(--acc); color: var(--acc); font-size: var(--fs-sm); font-weight: 700; cursor: pointer; padding: 2px 10px; }
  .orow select { margin-left: auto; max-width: 280px; }
  .aorph { margin-top: 10px; } .orow { display: flex; gap: 8px; align-items: center; padding: 4px 0; } .orow .mini { margin-left: auto; }
  .ana .mini, .orow .mini { opacity: 1; padding: 2px 10px; border-color: var(--acc); color: var(--acc); font-size: var(--fs-sm); font-weight: 700; cursor: pointer; }
  .ana .mini:hover, .orow .mini:hover { background: var(--acc-soft); }
  .dec summary { cursor: pointer; list-style: none; display: flex; flex-direction: column; gap: 6px; } .dec summary::-webkit-details-marker { display: none; }
  .dec .meta { display: flex; gap: 8px; align-items: center; } .dec .ttl { font-weight: 600; } .dec .body { margin: 8px 0 0; }
  .test { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; } .test .ttl { flex: 1 1 240px; min-width: 0; }
  .tstate { padding: 0 8px; border-radius: 10px; font-size: 12px; font-weight: 700; border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 18%, transparent); }
  .t-pass { --c: var(--vscode-testing-iconPassed); } .t-wait { --c: var(--vscode-testing-iconQueued, var(--vscode-charts-yellow)); } .t-skip { --c: var(--vscode-testing-iconSkipped, var(--vscode-disabledForeground)); }
  .ev { display: flex; gap: 12px; padding: 3px 10px; font-size: 13px; } .ev .when { flex: none; width: 104px; color: var(--vscode-descriptionForeground); }
  .ev .who { flex: none; font-weight: 700; } .w-user { color: var(--acc); } .w-agent { color: var(--vscode-charts-blue); } .ev .what { flex: 1; min-width: 0; }
  .rail { flex: 1 1 220px; max-width: 280px; min-width: 0; padding: 22px 18px; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 14px; font-size: 13px; box-sizing: border-box; }
  .prop { display: flex; flex-direction: column; gap: 2px; } .prop .val { font-weight: 600; }
  .prop select { font: inherit; padding: 3px 6px; border-radius: 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--line)); }
  .links { margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; } .links a { font-weight: 600; }
  /* Waiting on you */
  .inbox, .home { max-width: 1000px; margin: 0 auto; padding: 22px 12px 0; display: flex; flex-direction: column; gap: 20px; }
  .home { max-width: 1180px; gap: 26px; }
  .toprow { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
  .buckets { display: flex; flex-wrap: wrap; gap: 10px; }
  .bucket { flex: 1 1 170px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--card); box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 1px; font: inherit; color: inherit; text-align: left; cursor: pointer; }
  .bucket:hover { border-color: var(--c); } .bucket.on { border-color: var(--c); box-shadow: inset 0 0 0 1px var(--c); background: color-mix(in srgb, var(--c) 12%, var(--card)); }
  .bucket .n { opacity: 1; font-size: 28px; font-weight: 800; line-height: 1.1; color: var(--c); } .bucket .bl { font-weight: 600; } .bucket .dim { font-size: 12px; }
  .b-question { --c: var(--acc); } .b-todo { --c: var(--vscode-charts-blue); } .b-test { --c: var(--vscode-charts-yellow); } .b-done { --c: var(--vscode-charts-green); }
  .igroups { display: flex; flex-direction: column; gap: 18px; } .igrp { display: flex; flex-direction: column; gap: 8px; }
  .igrp h2 { align-items: baseline; gap: 10px; }
  .turn-h { margin-top: 8px !important; }
  /* Home */
  .progress { margin-top: 12px; height: 10px; border-radius: var(--r-pill); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line); max-width: 520px; overflow: hidden; }
  .progress div { height: 10px; border-radius: var(--r-pill); background: linear-gradient(90deg, color-mix(in srgb, var(--acc) 65%, var(--vscode-editor-background)), var(--acc)); }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .grid2 .card { display: flex; flex-direction: column; gap: 8px; padding: 16px 18px; }
  .card.left { border-color: var(--acc); background: color-mix(in srgb, var(--acc) 9%, var(--card)); }
  .cap { font-size: 12px !important; letter-spacing: .04em; text-transform: uppercase; } .card.left .cap { color: var(--acc); }
  .cap.row { justify-content: space-between; } .cap a { text-transform: none; letter-spacing: 0; }
  .ptr { display: flex; flex-direction: column; gap: 1px; padding: 7px 10px; border-radius: 6px; background: var(--vscode-editor-background); color: var(--vscode-foreground) !important; }
  .ptr:hover { text-decoration: none !important; background: var(--vscode-list-hoverBackground); } .pm { display: flex; gap: 8px; font-size: 12px; } .pm .mono { color: var(--acc); }
  .hask { display: flex; align-items: flex-start; gap: 10px; color: var(--vscode-foreground) !important; } .hask .ttl { flex: 1; min-width: 0; }
  .tablewrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--shadow); }
  .htable { width: 100%; min-width: 720px; border-collapse: collapse; }
  .htable th { padding: 9px 12px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); border: 0; }
  .htable td { height: auto; padding: 8px 12px; white-space: normal; max-width: none; border-top: 1px solid var(--line); }
  .htable tr[data-nav] { cursor: pointer; } .htable tr[data-nav]:hover { background: var(--vscode-list-hoverBackground); }
  .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0; }
  .emptyhero { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border: 1px dashed var(--acc-line); border-radius: var(--r-lg); background: var(--acc-soft); }
  .emptyhero p { margin: 0; } .emptyhero b { font-size: var(--fs-h3); }
`;

module.exports = {
  TABS, ANALYSIS_TABS, FILTERS, plainTitle, titleParts, subHeads, TASKS_CSS, analysisHub, analysisHubHtml, ICON, icon, KIND_LABEL, kindChip, bucketOf, userActor, parseQuickAdd, isAsk, repoOfRoot, scopeRepos, describeVersion,
  tasksPage, inboxModel, inboxCount, openTurn, splitText, TITLE_MAX, BODY_MAX, homeModel, unreadOf, unreadHtml, tasksHtml, inboxHtml, homeHtml, paneHtml, applyMessage, cleanView, esc,
};
