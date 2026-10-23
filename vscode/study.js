// @ts-check
// Study mode (#95): everything to learn one topic end to end, in one read, for the /study
// skill: the task (an epic's tasks too), its decisions and notes, the design-document sections
// its records feed, its analysis, the glossary terms it uses, the files its commits changed,
// and the last study's mastery with what changed since. Reads only; the skill writes the
// study note (the task's analysis, section "study") and the mastery record (a note with
// links.study) with the usual tools.
"use strict";
const { execFileSync } = require("node:child_process");

const DESIGN = ["decision", "adr", "pdr"];
const NOTE_KINDS = ["note", "question", "answer"];
/** The analysis section the study note is kept in. */
const NOTE_KEY = "study";
const MAX_COMMITS = 40;
const MAX_FILES = 60;
const NOTE_CUT = 600;

/** A key named in text: "#9" not in "#92" or "PR#9", "PROJ-1" not in "PROJ-12" or "MYPROJ-1". @param {string} key */
const keyPattern = (key) => new RegExp(`(?<![A-Za-z0-9_#-])${escapeRe(key)}(?![0-9])`);
/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The repo's commits that name the task (Closes #n, Refs #n, a branch merge), newest first, with
 * the files each changed. None when the repo is not on this machine or git fails.
 * @param {string} root @param {string} key @param {(args: string[]) => string} [git]
 */
function commitsOf(root, key, git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 })) {
  if (root.startsWith("origin:")) return [];
  let log;
  try {
    // The key with its bounds in git's own search, so -n counts commits that name it ("#1" would
    // otherwise fill it with #10…#199); keyPattern checks again with the message as a whole.
    const ere = `(^|[^A-Za-z0-9_#-])${escapeRe(key)}([^0-9]|$)`;
    log = git(["log", "--no-merges", "-E", `--grep=${ere}`, "--format=%x1e%H%x09%ct%x09%s%x1f%b%x1f", "--numstat", "-n", String(MAX_COMMITS * 2)]);
  } catch {
    return [];
  }
  const re = keyPattern(key);
  /** @type {Array<{hash: string, at: number, subject: string, files: Array<{path: string, added: number, removed: number}>}>} */
  const out = [];
  for (const chunk of log.split("\x1e").slice(1)) {
    const [head, body = "", stat = ""] = chunk.split("\x1f");
    const [hash, ct, ...subject] = head.split("\t");
    const s = subject.join("\t");
    // The message names it (the subject or "Closes #92" below it), not only contains it.
    if (!re.test(`${s}\n${body}`)) continue;
    const files = stat.split("\n").filter(Boolean).map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 };
    });
    out.push({ hash: hash.slice(0, 10), at: Number(ct) * 1000, subject: s, files });
    if (out.length >= MAX_COMMITS) break;
  }
  return out;
}

/** The files of the commits, most changed first. @param {ReturnType<typeof commitsOf>} commits */
function filesOf(commits) {
  /** @type {Map<string, {path: string, added: number, removed: number, commits: number, last: number}>} */
  const by = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      const x = by.get(f.path) ?? { path: f.path, added: 0, removed: 0, commits: 0, last: 0 };
      x.added += f.added;
      x.removed += f.removed;
      x.commits++;
      x.last = Math.max(x.last, c.at);
      by.set(f.path, x);
    }
  }
  return [...by.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, MAX_FILES);
}

/** Question types of the skill; another is "other". The Turkish ones are kept: older mastery records hold them. */
const TYPES = ["understand", "why", "alternative", "where-in-code", "debug", "what-if", "objection", "anlama", "neden", "alternatif", "kodda-nerede", "ya-şöyle-olsaydı", "itiraz"];
/** Free text from a record's links, one line and short: it is data, not a heading. @param {unknown} s */
const line = (s) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 299)}…` : t;
};

/** The latest mastery record of a task: a note with links.study. @param {any[]} recs */
function masteryOf(recs) {
  const m = recs.filter((r) => r.links?.study).sort((a, b) => b.updated_at - a.updated_at)[0];
  if (!m) return undefined;
  const qs = Array.isArray(m.links.study.questions) ? m.links.study.questions : [];
  return {
    record: m.id, at: m.updated_at, topic: m.links.study.topic,
    score: { full: qs.filter((q) => q.result === "full").length, partial: qs.filter((q) => q.result === "partial").length, miss: qs.filter((q) => q.result === "miss").length, total: qs.length },
    // Weak first: asked again before new ones (spaced practice).
    weak: qs.filter((q) => q.result !== "full").map((q) => ({ q: line(q.q), type: TYPES.includes(q.type) ? q.type : "other", result: q.result === "partial" ? "partial" : "miss", ...(q.gap && { gap: line(q.gap) }) })),
  };
}

/**
 * Everything to study a task.
 * @param {any} db @param {{id: number, root: string}} repo @param {any} task
 * @param {{git?: (args: string[]) => string}} [o]
 */
function studyMaterial(db, repo, task, o = {}) {
  const epic = task.epic_id ? db.taskById(task.epic_id) : undefined;
  const children = db.tasksOf(repo.id, { limit: 2000 }).filter((/** @type {any} */ t) => t.epic_id === task.id);
  // An epic is studied with its tasks: their records and commits are its material too.
  const keyOf = new Map([[task.id, task.key], ...children.map((/** @type {any} */ t) => [t.id, t.key])]);
  const own = db.recordsOf(task.id);
  const recs = [...own, ...children.flatMap((/** @type {any} */ t) => db.recordsOf(t.id))];
  const cut = (/** @type {string | null} */ s) => (s && s.length > NOTE_CUT ? `${s.slice(0, NOTE_CUT)}…` : s ?? undefined);
  const from = (/** @type {any} */ r) => (r.task_id === task.id ? {} : { task: keyOf.get(r.task_id) });
  const decisions = recs.filter((/** @type {any} */ r) => DESIGN.includes(r.kind)).map((/** @type {any} */ r) => ({ id: r.id, kind: r.kind, status: r.status, title: r.title, body: r.body ?? undefined, at: r.updated_at, ...from(r) }));
  const notes = recs.filter((/** @type {any} */ r) => NOTE_KINDS.includes(r.kind) && !r.links?.study).map((/** @type {any} */ r) => ({ id: r.id, kind: r.kind, status: r.status, title: r.title, body: cut(r.body), parent_id: r.parent_id ?? undefined, ...from(r) }));
  const todos = recs.filter((/** @type {any} */ r) => r.kind === "todo" || r.kind === "fixme" || r.kind === "test").map((/** @type {any} */ r) => ({ id: r.id, kind: r.kind, status: r.status, owner: r.owner, title: r.title, ...from(r) }));
  // The repo's sections the task's records feed (doc_section_upsert records).
  const ids = recs.map((/** @type {any} */ r) => r.id);
  const linked = ids.length
    ? db.sqlite.prepare(`SELECT DISTINCT s.id, s.key, s.title, s.body, s.updated_at, d.kind FROM doc_section_records x
        JOIN doc_sections s ON s.id = x.section_id JOIN documents d ON d.id = s.doc_id
        WHERE x.record_id IN (${ids.map(() => "?").join(",")}) AND s.status = 'current' AND d.kind IN ('architecture', 'product') ORDER BY d.kind, s.position`).all(...ids)
    : [];
  const anaDoc = db.taskDocFind(repo.id, task.key);
  const analysis = anaDoc ? db.docSections(anaDoc.id).filter((/** @type {any} */ s) => s.status === "current") : [];
  const note = analysis.find((/** @type {any} */ s) => s.key === NOTE_KEY);
  /** @type {Map<string, any>} */
  const byHash = new Map();
  for (const k of keyOf.values()) for (const c of commitsOf(repo.root, k, o.git)) byHash.set(c.hash, c);
  const commits = [...byHash.values()].sort((a, b) => b.at - a.at).slice(0, MAX_COMMITS);
  // Terms the material uses, by their name.
  const text = [task.title, task.summary, ...decisions.map((d) => `${d.title} ${d.body ?? ""}`), ...notes.map((n) => n.title),
    ...linked.map((/** @type {any} */ s) => `${s.title} ${s.body ?? ""}`), ...analysis.map((/** @type {any} */ s) => `${s.title} ${s.body ?? ""}`)].join(" ").toLocaleLowerCase("tr");
  const glossaryDoc = db.docFind(repo.id, "glossary");
  const terms = glossaryDoc ? db.docSections(glossaryDoc.id).filter((/** @type {any} */ s) => s.status === "current" && text.includes(s.title.toLocaleLowerCase("tr"))) : [];
  // The topic's own study: an epic's tasks keep theirs.
  const mastery = masteryOf(own);
  // What changed after the last study: its answers may be out of date.
  const changed = mastery ? [
    ...commits.filter((c) => c.at > mastery.at).map((c) => `commit ${c.hash} ${c.subject}`),
    ...decisions.filter((d) => d.at > mastery.at).map((d) => `${d.kind} [${d.id}] ${d.title}`),
    ...linked.filter((/** @type {any} */ s) => s.updated_at > mastery.at).map((/** @type {any} */ s) => `${s.kind} section ${s.key}`),
  ] : [];
  return {
    task: { key: task.key, title: task.title, status: task.status, summary: task.summary ?? undefined },
    ...(epic && { epic: { key: epic.key, title: epic.title } }),
    tasks: children.map((/** @type {any} */ t) => ({ key: t.key, title: t.title, status: t.status, summary: t.summary ?? undefined })),
    decisions, notes, todos,
    sections: linked.map((/** @type {any} */ s) => ({ kind: s.kind, key: s.key, title: s.title, body: s.body ?? "" })),
    analysis: analysis.filter((/** @type {any} */ s) => s.key !== NOTE_KEY).map((/** @type {any} */ s) => ({ key: s.key, title: s.title, source: s.source ?? undefined, body: s.body ?? "" })),
    terms: terms.map((/** @type {any} */ s) => ({ term: s.title, meaning: s.body ?? "" })),
    commits: commits.map(({ files, ...c }) => ({ ...c, files: files.length })),
    files: filesOf(commits),
    ...(note && { note: { body: note.body ?? "", at: note.updated_at, stale: commits.some((c) => c.at > note.updated_at) || decisions.some((d) => d.at > note.updated_at) } }),
    ...(mastery && { mastery: { ...mastery, changed } }),
  };
}

module.exports = { studyMaterial, commitsOf, filesOf, masteryOf, keyPattern, NOTE_KEY };
