// @ts-check
// The new Imprimatur panel's data (#195, screen map: decision 10582 on #190). Pure: the database and a
// place in, a plain object out, so the panel and the tests share it. Five areas (Home, Tasks, Docs,
// Edits, Setup) and More; a document opens in the one reading layout (its sections, the page,
// "on this page").
"use strict";
const path = require("node:path");

/** The areas of the left nav, in order; g + key jumps there. */
const AREAS = [
  { id: "home", label: "Home", key: "h", icon: "home" },
  { id: "tasks", label: "Tasks", key: "t", icon: "checklist" },
  { id: "docs", label: "Docs", key: "d", icon: "book" },
  { id: "edits", label: "Edits", key: "e", icon: "git-merge" },
  { id: "setup", label: "Setup", key: "s", icon: "settings-gear" },
];
/** Under More: the pages that are not daily work (#202: in this panel, no longer the old one's tabs). */
const MORE = [
  { id: "exercises", label: "Exercises" },
  { id: "meetings", label: "Meetings" },
  { id: "social", label: "Social" },
];
/** The documents of the Docs area, in reading order (Pocock's, then the wiki). */
const DOCS = [
  { id: "project", label: "Project", kind: "project" },
  { id: "capabilities", label: "Capabilities", kind: "capability" },
  { id: "adrs", label: "ADRs", kind: "adr" },
  { id: "glossary", label: "Glossary", kind: "glossary" },
  { id: "out-of-scope", label: "Out of scope", kind: "out-of-scope" },
  { id: "wiki", label: "Wiki", kind: "wiki" },
];

/** A section's first paragraph as one line: the summary shown first. @param {unknown} body */
function summaryOf(body) {
  const para = String(body ?? "").replace(/\r\n/g, "\n").split(/\n\s*\n/).find((p) => p.trim() && !/^(#|```|<!--|\||- \[)/.test(p.trim())) ?? "";
  const s = para.replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
}

/**
 * A document as the reading layout wants it: title, a summary, and its current sections.
 * @param {string} title @param {Array<{key: string, title: string, body?: string | null}>} sections @param {string} [summary]
 */
function reading(title, sections, summary) {
  const list = sections.map((s) => ({ key: s.key, title: s.title, body: s.body ?? "" }));
  return { title, summary: summary ?? summaryOf(list[0]?.body), sections: list };
}

/**
 * The reading model of a Docs page (#195 reads; #198 edits).
 * @param {any} db @param {any} repo @param {string} root @param {string} doc one of DOCS' ids @param {string} [scope] a capability's name
 */
function docReading(db, repo, root, doc, scope) {
  const flag = staleFlags(db, repo, root);
  const current = (/** @type {any} */ d) => (d ? db.docSections(d.id).filter((/** @type {any} */ s) => s.status === "current").map((/** @type {any} */ s) => ({ ...s, body: flag(`section:${s.id}`, s.body) })) : []);
  if (doc === "adrs") {
    const adrs = db.q(`SELECT r.* FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? AND r.kind = 'adr' AND r.status <> 'dropped' ORDER BY r.created_at`).all(repo.id);
    return reading("ADRs", adrs.map((/** @type {any} */ r) => {
      let n;
      try {
        n = JSON.parse(r.links ?? "{}").madr;
      } catch {}
      return { key: `adr-${n ?? r.id}`, title: `${n ? `${String(n).padStart(4, "0")} · ` : ""}${String(r.title).replace(/\s+/g, " ").slice(0, 140)}`, body: flag(`record:${r.id}`, [String(r.title), r.body ?? ""].join("\n\n")) };
    }), "Decisions that are hard to reverse, surprising without their context, and the result of a real trade-off.");
  }
  if (doc === "capabilities") {
    const caps = db.q("SELECT * FROM documents WHERE repo_id = ? AND kind = 'capability' ORDER BY scope").all(repo.id);
    const pick = caps.find((/** @type {any} */ c) => c.scope === scope) ?? caps[0];
    if (!pick) return { ...reading("Capabilities", [], "How the system behaves now. A capability appears when a task with a spec is done and its changes merge."), scopes: [] };
    return { ...reading(`Capability · ${pick.scope}`, current(pick)), scopes: caps.map((/** @type {any} */ c) => c.scope), scope: pick.scope, edit: { kind: "capability", scope: pick.scope } };
  }
  if (doc === "wiki") {
    const fs = require("node:fs");
    const dir = path.join(root, "docs", "wiki");
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((/** @type {string} */ f) => f.endsWith(".md")).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));
    } catch {}
    const pages = names.map((/** @type {string} */ f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^#\s+[^\n]*\n+/, "");
      return { key: f.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-"), title: f === "README.md" ? "Overview" : `${f.replace(/\.md$/, "")}/`, body: text };
    });
    return reading("Wiki", pages, pages.length ? undefined : "No wiki yet: npm run wiki writes it from the code's comments, the ADRs and the glossary.");
  }
  const kind = DOCS.find((d) => d.id === doc)?.kind ?? "project";
  const label = DOCS.find((d) => d.id === doc)?.label ?? "Project";
  const r = reading(label, current(db.docFind(repo.id, kind)), {
    project: "Mission, constraints, tech stack and roadmap.",
    glossary: "The words this project uses, one entry each.",
    "out-of-scope": "What the project decided not to do, and why.",
  }[kind]);
  // The database is the source of these: they are edited here (#198); ADRs live in records, the wiki is generated.
  return { ...r, edit: { kind, chapters: kind === "project" ? require("../db.js").CHAPTERS.project : undefined } };
}

/**
 * Possibly stale parts (#211) as a function that puts a warning over a part's text. Never fails a
 * page: without git, nothing is flagged.
 * @param {any} db @param {any} repo @param {string} root @returns {(key: string, body: string) => string}
 */
function staleFlags(db, repo, root) {
  /** @type {Map<string, any>} */
  let by = new Map();
  try {
    by = new Map(require("../stale-docs.js").staleParts(db, repo, root).map((p) => [`${p.kind === "section" ? "section" : "record"}:${p.id}`, p]));
  } catch {}
  return (key, body) => {
    const p = by.get(key);
    if (!p) return body;
    const c = p.commits[0];
    return `> ⚠ **Possibly stale:** ${p.files.map((/** @type {string} */ f) => `\`${f}\``).join(", ")} changed in ${p.commits.length} commit${p.commits.length === 1 ? "" : "s"} since this was written (newest \`${c.hash}\` ${c.subject}). Agent Setup → Documents lists them.\n\n${body ?? ""}`;
  };
}

/** The spec's gates in order (Kiro's, decided for #179): each approval is a decision record with links.gate. */
const GATES = [
  { id: "stories", label: "Problem and user stories" },
  { id: "design", label: "Design" },
  { id: "analyze", label: "Analysis of gaps" },
  { id: "tickets", label: "Tickets" },
];
const TABS = ["spec", "tickets", "records", "activity"];

/**
 * A task's page (#197): its spec in the reading layout, its tickets, its records, its activity, and
 * the spec's gates with which are approved.
 * @param {any} db @param {any} repo @param {string} key @param {string} [tab] @param {string} [root] the repo's folder, for the stale check (#211)
 */
function taskPage(db, repo, key, tab, root = repo.root ?? "") {
  const task = db.taskByKey(repo.id, key);
  if (!task) return undefined;
  const recs = db.recordsOf(task.id);
  // The agent writes the spec and records each gate itself (the user's choice, 2026-11-12, replacing
  // #197's user-only approval): a gate is passed by its decision record, whoever wrote it.
  const approved = new Set(recs.filter((/** @type {any} */ r) => r.kind === "decision" && r.status === "done" && r.links?.gate).map((/** @type {any} */ r) => r.links.gate));
  const gates = GATES.map((g, i) => ({ ...g, done: approved.has(g.id), next: !approved.has(g.id) && GATES.slice(0, i).every((x) => approved.has(x.id)) }));
  const bucket = isBucket(key);
  const spec = db.taskDocFind(repo.id, key, "spec");
  const chapters = require("../db.js").CHAPTERS.spec;
  const flag = spec ? staleFlags(db, repo, root) : (/** @type {string} */ _k, /** @type {string} */ b) => b;
  const specReading = reading(`Spec · ${key}`, spec ? db.docSections(spec.id).filter((/** @type {any} */ s) => s.status === "current")
    .map((/** @type {any} */ s) => ({ key: s.key, title: `${chapters[s.chapter] ? `${chapters[s.chapter]} · ` : ""}${s.title}${s.delta ? ` (${s.delta})` : ""}`, body: flag(`section:${s.id}`, s.body) })) : [],
    spec ? undefined : "No spec yet: the agent writes it when it starts this task and passes the gates below on its way to tickets.");
  const tickets = db.q("SELECT * FROM tasks WHERE epic_id = ? AND id <> ? ORDER BY id").all(task.id, task.id);
  const activity = db.taskVersions(task.id, { limit: 40 }).list;
  const tabs = bucket ? TABS.filter((x) => x !== "spec") : TABS;
  // What the ticket cost in tokens, from the repo's transcripts (#214); never fails a page.
  let tokens;
  try {
    const tt = require("../ticket-tokens.js");
    tokens = bucket || !root ? undefined : tt.ticketTokens(tt.projectDirOf(root)).get(key);
  } catch {}
  return { task, tab: tabs.includes(/** @type {string} */ (tab)) ? tab : bucket ? "records" : "spec", tabs, gates: bucket ? [] : gates, spec: specReading, tickets, records: recs.filter((/** @type {any} */ r) => r.status !== "dropped"), activity, tokens };
}

/**
 * The agent's edits still under review (#199), one row per file, newest first: how many are open,
 * the latest one's summary and when. Cursor's lesson: the review stays in plain sight.
 * @param {string} root @param {any[]} [rows] graph.js graphRows(root).rows (passed in tests)
 */
function editsQueue(root, rows) {
  let all = rows;
  if (!all) {
    try {
      all = require("../graph.js").graphRows(root).rows;
    } catch {
      all = [];
    }
  }
  /** @type {Map<string, {file: string, open: number, last: string, what: string, items: Array<{n: number, t: string, what: string}>}>} */ const by = new Map();
  for (const r of /** @type {any[]} */ (all)) {
    if (r.accepted || r.gone || r.outside || String(r.file).includes(" · ")) continue;
    const f = by.get(r.file) ?? { file: r.file, open: 0, last: "", what: "", items: [] };
    f.open++;
    // Each edit under review, to accept, diff or go to one at a time (#202; the old change graph's rows).
    if (Number.isInteger(r.n)) f.items.push({ n: r.n, t: String(r.t), what: r.summary || r.intent || r.prompt || r.tool || "edit" });
    if (String(r.t) > f.last) Object.assign(f, { last: String(r.t), what: r.summary || r.intent || r.prompt || "" });
    by.set(r.file, f);
  }
  for (const f of by.values()) f.items.sort((a, b) => b.t.localeCompare(a.t));
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/**
 * One board of the work (#196, after Conductor): what the agent is on (active), what waits on the
 * user (an open question or to-do they own), what finished in the last seven days.
 * @param {any} db @param {number} repoId @param {number} [now]
 */
function boardOf(db, repoId, now = Date.now()) {
  const asks = db.openAsks({ repoId, limit: 200 });
  /** @type {Map<string, any>} */ const needs = new Map();
  for (const r of asks) {
    const n = needs.get(r.task_key) ?? { key: r.task_key, title: db.taskByKey(repoId, r.task_key)?.title ?? "", asks: [] };
    n.asks.push(r.title);
    needs.set(r.task_key, n);
  }
  const active = db.q("SELECT key, title, summary FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC").all(repoId)
    .filter((/** @type {any} */ t) => !needs.has(t.key) && !isBucket(t.key)).slice(0, 20);
  const done = db.q("SELECT key, title, summary FROM tasks WHERE repo_id = ? AND status = 'done' AND done_at > ? ORDER BY done_at DESC LIMIT 20").all(repoId, now - 7 * 86_400_000);
  return { active, needs: [...needs.values()], done };
}

/**
 * A bucket of records (RECS, ADR, PDR: a key that is neither "#58" nor a Jira "PROJ-12") is no piece
 * of work: it is left out of the task lists, and its page has no spec and no gates.
 * @param {string} key
 */
const isBucket = (key) => !/^#\d+$|^[A-Z][A-Z0-9_]*-\d+$/.test(key);

/**
 * The tasks by status, active first, then open, then the last done: the panel's Tasks page and
 * the side bar's Tasks row.
 * @param {any} db @param {number} repoId
 */
function taskLists(db, repoId) {
  const list = (/** @type {string} */ status, /** @type {number} */ n) => db.q(`SELECT key, title, summary, status FROM tasks WHERE repo_id = ? AND status = ? ORDER BY updated_at DESC`).all(repoId, status)
    .filter((/** @type {any} */ t) => !isBucket(t.key)).slice(0, n);
  return [{ id: "active", label: "Active", tasks: list("active", 50) }, { id: "open", label: "Open", tasks: list("open", 80) }, { id: "done", label: "Done", tasks: list("done", 20) }];
}

/**
 * The panel's model for a place.
 * @param {any} db @param {any} repo @param {string} root
 * @param {{area?: string, doc?: string, scope?: string, task?: string, tab?: string, rows?: any[]}} at
 */
function appModel(db, repo, root, at = {}) {
  const area = [...AREAS, ...MORE].some((a) => a.id === at.area) ? /** @type {string} */ (at.area) : "home";
  const waiting = db.openAsks ? db.openAsks({ repoId: repo.id, limit: 200 }).length : 0;
  // Social is off by default, per repo (#109): its page shows only where it is on.
  let social = false;
  try {
    social = require("../docs-export.js").socialOn(root);
  } catch {}
  const more = MORE.filter((x) => x.id !== "social" || social || area === "social");
  const base = { repo: { name: repo.name ?? path.basename(root), root }, areas: AREAS, more, area, waiting };
  if (area === "docs") {
    const doc = DOCS.some((d) => d.id === at.doc) ? /** @type {string} */ (at.doc) : "project";
    return { ...base, docs: DOCS, doc, reading: docReading(db, repo, root, doc, at.scope) };
  }
  if (area === "tasks") {
    const page = at.task ? taskPage(db, repo, at.task, at.tab, root) : undefined;
    if (page) return { ...base, page };
    return { ...base, lists: taskLists(db, repo.id) };
  }
  if (area === "edits") return { ...base, edits: editsQueue(root, at.rows) };
  // Exercises belong to no repo; meetings are this repo's meeting records; social is a document.
  if (area === "exercises") return { ...base, exercises: require("../exercises.js").exerciseModel(db) };
  if (area === "meetings") return { ...base, meetings: require("../meetings.js").meetingsModel(db, root).meetings };
  if (area === "social") {
    const d = db.docFind(repo.id, "social");
    const r = reading("Social", d ? db.docSections(d.id).filter((/** @type {any} */ s) => s.status === "current") : [], "Posts written for each platform after reading its rules (/social-post).");
    return { ...base, reading: { ...r, edit: { kind: "social" } } };
  }
  if (area === "setup") {
    const recs = db.q(`SELECT count(*) AS n FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? AND t.key = 'RECS' AND r.status = 'open'`).get(repo.id)?.n ?? 0;
    return { ...base, setup: { recommendations: recs } };
  }
  if (area === "home") {
    const tasks = db.whereWeLeftOff(repo.id).slice(0, 12);
    // Which tasks have a spec or a map (Pocock's), so Home links them.
    const scoped = db.q("SELECT kind, scope FROM documents WHERE repo_id = ? AND kind IN ('spec', 'map')").all(repo.id);
    for (const t of tasks) t.docs = scoped.filter((/** @type {any} */ d) => d.scope === t.key).map((/** @type {any} */ d) => d.kind);
    return { ...base, tasks, board: boardOf(db, repo.id) };
  }
  return base;
}

module.exports = { appModel, taskLists, isBucket, editsQueue, taskPage, GATES, boardOf, docReading, reading, summaryOf, AREAS, MORE, DOCS };
