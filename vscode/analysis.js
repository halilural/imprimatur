// @ts-check
// A task's analysis (TASK-ANALYSIS): the Markdown the agent writes while working on a task
// (an analysis, a plan, a spike's result, research notes), wherever it puts it, kept in
// Imprimatur's database as the task's "analysis" document: one section per "##" heading of
// each file, every change a version, synced like the design documents.
// - isCandidate: a Markdown file that is not one Imprimatur already keeps (TODO.md, the
//   design documents, docs/testing, …) nor a repo's own docs (README, CHANGELOG, …).
// - verdictOf: the path and headings decide when they can (todos/<key>/…, docs/research,
//   spikes, ~/.claude/plans, ANALYSIS.md, "## Bulgular", …); else Haiku (askModel), whose
//   answer is kept per file.
// - taskFor: the task folder, a key in the path, the branch, the task the session was
//   writing records of, a key in the request or the file's title. Only tasks Imprimatur
//   has; a file with none waits in the repo's orphans list.
// - ingest: the file's sections into the task's document; sections it no longer has are
//   superseded; the same text twice writes nothing.
// The hook (process.js) ingests on each edit; analysis-backfill.js replays past sessions.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SECTION_BODY_MAX, SECTION_TITLE_MAX } = require("./db.js");
const { taskOfFile, taskKeyIn, normKey, leadKey } = require("./tasks.js");

const CONFIG = path.join(".claude", "imprimatur.json");
/** Tasks that are not work items: their records are Imprimatur's own lists. */
const SPECIAL = new Set(["ADR", "PDR", "TEST", "AUDIT", "BEST", "RECS"]);
/** Files a repo keeps for its readers, or Imprimatur keeps already. */
const NOT_ANALYSIS = /^(README|CHANGELOG|CHANGES|LICENSE|LICENCE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|TODO|CLAUDE|AGENTS|GEMINI|SKILL|ARCHITECTURE|PRODUCT|GLOSSARY|THIRD_PARTY_NOTICES|NOTICE|TEMPLATE)\.mdx?$/i;
/** Folders whose files are something else: Imprimatur's own, tools', dependencies', the design documents', the sprint plans. */
const NOT_UNDER = /(^|\/)(node_modules|\.git|\.claude\/(imprimatur|commands|agents|skills)|\.cursor|\.github|vendor|dist|build|docs\/(design|product|testing)|(docs\/)?todos\/sprints)(\/|$)/;
/** Paths that say "analysis" by themselves. */
const ANALYSIS_PATH = /(^|\/)((docs\/)?todos\/[^/]+\/[^/]+$|docs\/(research|analysis|analiz|spikes?|plans?|rfcs?|adr)\/|spikes?\/|~\/\.claude\/plans\/|plan:)/i;
const ANALYSIS_NAME = /(analy[sz]|analiz|plan|spike|rfc|research|ara[sş]t[iı]rma|findings|bulgular|result|sonu[cç]|investigation|inceleme|discovery|kesif|keşif|design-?notes|post-?mortem|walkthrough)/i;
const ANALYSIS_HEADING = /^#{1,3}\s+(analiz|analysis|bulgular|findings|kapsam|scope|plan\b|yakla[sş][iı]m|approach|k[oö]k neden|root cause|se[cç]enekler|options|[oö]neri|recommendation|sonu[cç]|conclusion|riskler|risks|a[cç][iı]k sorular|open questions)/im;
/** The model's answers are kept this long: a file's kind does not change often. */
const VERDICT_TTL = 30 * 86400_000;
/** A file sent to the model is not sent again for this long (its answer comes, or it failed). */
const PENDING_MS = 10 * 60_000;
/** Larger files are left to the backfill: the hook stays quick. */
const HOOK_MAX = 1_000_000;
/** At most this much of a file goes to the model. */
const MODEL_CHARS = 4000;

const hash = (/** @type {string} */ s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/**
 * The repo's analysis settings: "analysis" in .claude/imprimatur.json. false: none kept;
 * {sync: false}: kept on this machine only; {exclude: [prefix, …]}: paths left out.
 * @param {string} root @returns {{on: boolean, sync: boolean, exclude: string[]}}
 */
function settingsOf(root) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG), "utf8"))?.analysis;
  } catch {}
  if (raw === false || raw === "off") return { on: false, sync: false, exclude: [] };
  const o = raw && typeof raw === "object" ? raw : {};
  return { on: o.on !== false, sync: o.sync !== false, exclude: Array.isArray(o.exclude) ? o.exclude.filter((x) => typeof x === "string") : [] };
}

/**
 * A file's path as Imprimatur keeps it: relative to the repo, "~/…" under the home folder
 * (a plan in ~/.claude/plans), else undefined (elsewhere: not kept).
 * @param {string} root @param {string} file absolute @param {string} [home]
 */
function relPath(root, file, home = os.homedir()) {
  const abs = path.resolve(root, file);
  const inRepo = path.relative(root, abs);
  if (inRepo && !inRepo.startsWith("..") && !path.isAbsolute(inRepo)) return inRepo.split(path.sep).join("/");
  const inHome = path.relative(home, abs);
  if (inHome && !inHome.startsWith("..") && !path.isAbsolute(inHome)) return `~/${inHome.split(path.sep).join("/")}`;
  return undefined;
}

/** The absolute path of a kept path. @param {string} root @param {string} rel @param {string} [home] */
const absPath = (root, rel, home = os.homedir()) => (rel.startsWith("~/") ? path.join(home, rel.slice(2)) : path.join(root, rel));

/**
 * Can this file be a task's analysis at all? Markdown, not one the repo keeps for readers
 * or Imprimatur keeps already, not excluded, not generated by Imprimatur.
 * @param {string} rel @param {string} [text] @param {{exclude?: string[]}} [s]
 */
function isCandidate(rel, text, s = {}) {
  if (rel.startsWith("plan:")) return true;
  if (!/\.mdx?$/i.test(rel)) return false;
  if (NOT_ANALYSIS.test(path.posix.basename(rel))) return false;
  // Out of the repo only a plan: the home folder holds much else.
  if (rel.startsWith("~/") && !rel.startsWith("~/.claude/plans/")) return false;
  if (NOT_UNDER.test(rel.replace(/^~\//, ""))) return false;
  if ((s.exclude ?? []).some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`))) return false;
  if (text !== undefined && text.split("\n", 1)[0].startsWith("<!-- Generated by Imprimatur")) return false;
  return true;
}

/**
 * What the path and headings say: "yes", or undefined when they cannot tell.
 * @param {string} rel @param {string} text
 */
function heuristic(rel, text) {
  if (ANALYSIS_PATH.test(rel)) return "yes";
  if (ANALYSIS_NAME.test(path.posix.basename(rel))) return "yes";
  if (ANALYSIS_HEADING.test(text.slice(0, 20_000))) return "yes";
  return undefined;
}

/** @param {string} rel @param {string} text */
const modelPrompt = (rel, text) => `A coding agent wrote this Markdown file in a software repo. Is it an analysis, plan, investigation, research note, spike result or design note written for a piece of work (a task), as opposed to documentation for the project's readers (a guide, README, API reference, changelog, prompt template, test spec, blog post)?
Answer with one word: YES or NO.

Path: ${rel}
---
${text.slice(0, MODEL_CHARS)}`;

const verdictKey = (/** @type {number} */ repoId, /** @type {string} */ rel) => `analysis:verdict:${repoId}:${rel}`;

/**
 * What is known without the model: the path and headings, else the model's kept answer.
 * @param {any} db @param {number} repoId @param {string} rel @param {string} text @returns {"yes" | "no" | undefined}
 */
function quickVerdict(db, repoId, rel, text) {
  const h = heuristic(rel, text);
  if (h) return h;
  try {
    const kept = JSON.parse(db.meta(verdictKey(repoId, rel)) ?? "null");
    if (kept && Date.now() - kept.at < VERDICT_TTL) return kept.v;
  } catch {}
  return undefined;
}

/**
 * Is the file a task's analysis: "yes", "no", or undefined (the model is needed and not
 * allowed, or failed). The model's answer is kept per file.
 * @param {any} db @param {number} repoId @param {string} rel @param {string} text
 * @param {{ask?: (prompt: string) => Promise<string>, model?: boolean}} [o] model false: never ask
 */
async function verdictOf(db, repoId, rel, text, o = {}) {
  const quick = quickVerdict(db, repoId, rel, text);
  if (quick || o.model === false) return quick;
  const ask = o.ask ?? ((/** @type {string} */ p) => require("./model.js").askModel(p, "haiku"));
  try {
    const reply = String(await ask(modelPrompt(rel, text))).trim().toUpperCase();
    const v = reply.startsWith("YES") ? "yes" : reply.startsWith("NO") ? "no" : undefined;
    if (v) db.setMeta(verdictKey(repoId, rel), JSON.stringify({ v, at: Date.now() }));
    return v;
  } catch {
    return undefined;
  }
}

/** A Jira-style key in a name, whatever its case and what follows: latd-12-cache → LATD-12. @param {string} s */
const jiraIn = (s) => /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?!\d)/.exec(s)?.[1]?.toUpperCase();

/** A key from a path's folders and name: 80-paper.md → #80, spikes/81-x/RESULT.md → #81, LATD-12-notes.md → LATD-12. @param {string} rel */
function keyInPath(rel) {
  const parts = rel.replace(/^~\//, "").split("/");
  for (const p of parts.slice(-2).reverse()) {
    const num = /^(\d{1,6})[-_.]/.exec(p)?.[1];
    if (num) return `#${num}`;
    const jira = jiraIn(p);
    if (jira) return jira;
  }
  return undefined;
}

/** A key in a branch name: feat/56-x → #56, feature/LATD-12-x → LATD-12. @param {string | undefined} branch */
function keyInBranch(branch) {
  if (!branch) return undefined;
  const num = /^[a-z]+\/(\d+)-/.exec(branch)?.[1];
  return num ? `#${num}` : jiraIn(branch);
}

/** The file's title: its first "#" heading. @param {string} text */
const titleOf = (text) => /^#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];

/**
 * The task a file belongs to, of those Imprimatur has, in order: its task folder, a key in
 * its path, the branch, the task the session was writing records of at the time, a key in
 * the request, a key in the file's title.
 * @param {any} db @param {number} repoId
 * @param {{rel: string, text: string, session?: string, prompt?: string, branch?: string, at?: number}} it
 * @returns {string | undefined}
 */
function taskFor(db, repoId, it) {
  const title = titleOf(it.text);
  const tries = [
    () => taskOfFile(it.rel),
    () => keyInPath(it.rel),
    () => keyInBranch(it.branch),
    () => (it.session ? db.sessionTaskAt(repoId, it.session, it.at) : undefined),
    () => taskKeyIn(it.prompt),
    () => (title ? leadKey(title) ?? taskKeyIn(title) : undefined),
  ];
  for (const t of tries) {
    const key = normKey(t() ?? "") ?? undefined;
    if (key && !SPECIAL.has(key) && db.taskByKey(repoId, key)) return key;
  }
  return undefined;
}

/** A slug for a key part. @param {string} s @param {number} n */
const slug = (s, n) => {
  const { slugify } = require("./docsView.js");
  return slugify(s).slice(0, n).replace(/-+$/, "") || "x";
};

/**
 * A body over the section limit, cut at "###" headings, else at blank lines, else hard.
 * @param {string} body @returns {string[]}
 */
function splitBody(body) {
  if (body.length <= SECTION_BODY_MAX) return [body];
  const out = [];
  let rest = body;
  while (rest.length > SECTION_BODY_MAX) {
    const head = rest.slice(0, SECTION_BODY_MAX);
    let cut = head.lastIndexOf("\n### ");
    if (cut < SECTION_BODY_MAX / 4) cut = head.lastIndexOf("\n\n");
    if (cut < SECTION_BODY_MAX / 4) cut = SECTION_BODY_MAX;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * A file's sections: the text before the first "##" under the file's title, each "##" one
 * section (a long one cut in parts).
 * @param {string} rel @param {string} text @returns {{key: string, title: string, body: string}[]}
 */
function sectionsOf(rel, text) {
  const { parseHand } = require("./docs-sync.js");
  const name = path.posix.basename(rel).replace(/\.mdx?$/i, "");
  const title = (titleOf(text) ?? name).slice(0, SECTION_TITLE_MAX);
  /** @type {{key: string, title: string, body: string}[]} */
  const out = [];
  for (const s of parseHand(text)) {
    const parts = splitBody(s.body);
    parts.forEach((body, i) => {
      const t = s.key === "overview" ? title : s.title || name;
      out.push({ key: i ? `${s.key}-${i + 1}` : s.key, title: (i ? `${t} (${i + 1})` : t).slice(0, SECTION_TITLE_MAX), body });
    });
  }
  // A file of a title only still says something: its title.
  if (!out.length) out.push({ key: "overview", title, body: "" });
  return out;
}

/**
 * The key prefix of a file's sections in a document: the one it has, else its name's slug,
 * with a part of its path's hash when another file of the document has that name.
 * @param {any} db @param {number} docId @param {string} rel
 */
function prefixOf(db, docId, rel) {
  const rows = db.sqlite.prepare("SELECT key, source FROM doc_sections WHERE doc_id = ?").all(docId);
  const mine = rows.find((/** @type {any} */ r) => r.source === rel);
  if (mine) return mine.key.split("--")[0];
  const stem = rel.startsWith("plan:") ? "plan" : path.posix.basename(rel).replace(/\.mdx?$/i, "");
  const base = slug(stem, 24);
  const taken = rows.some((/** @type {any} */ r) => r.source !== rel && r.key.split("--")[0] === base);
  return taken ? `${slug(stem, 17)}-${hash(rel).slice(0, 6)}` : base;
}

/**
 * Takes a file's text into its task's analysis document. The same text as last time
 * writes nothing; a section the file no longer has is superseded.
 * @param {any} db @param {number} repoId @param {string} taskKey @param {string} rel @param {string} text
 * @param {{actor: {kind: string, id?: string}, at?: number}} o at: when the text was written (a replay)
 * @returns {{doc: number, changed: number, superseded: number, unchanged?: boolean}}
 */
function ingest(db, repoId, taskKey, rel, text, { actor, at }) {
  const doc = db.taskDocOf(repoId, taskKey);
  const h = hash(text.replace(/\r\n/g, "\n"));
  if (db.docSourceHash(doc.id, rel) === h) return { doc: doc.id, changed: 0, superseded: 0, unchanged: true };
  // A replayed state older than what the document holds of the file (written since, here or
  // on another machine, or through MCP) is history already passed: it sets nothing back.
  if (at !== undefined) {
    const newest = db.sqlite.prepare("SELECT max(updated_at) AS t FROM doc_sections WHERE doc_id = ? AND source = ?").get(doc.id, rel)?.t;
    if (newest != null && newest > at) return { doc: doc.id, changed: 0, superseded: 0, unchanged: true };
  }
  return db.tx(() => {
    const prefix = prefixOf(db, doc.id, rel);
    const existing = db.sqlite.prepare("SELECT key, status, position FROM doc_sections WHERE doc_id = ? AND source = ? ORDER BY position").all(doc.id, rel);
    // A file's sections sit together: after the document's others when it is new.
    const base = existing.length ? Math.floor(existing[0].position)
      : /** @type {any} */ (db.sqlite.prepare("SELECT coalesce(CAST(max(position) AS INTEGER), 0) + 1 AS p FROM doc_sections WHERE doc_id = ?").get(doc.id)).p;
    const secs = sectionsOf(rel, text);
    const keep = new Set();
    let changed = 0;
    // Keys fit in 64: a long one cut keeps a part of its hash, so two cut alike stay two.
    const room = 64 - prefix.length - 2;
    secs.forEach((s, i) => {
      let part = s.key.length <= room ? s.key : `${s.key.slice(0, room - 7).replace(/-+$/, "")}-${hash(s.key).slice(0, 6)}`;
      while (keep.has(`${prefix}--${part}`)) part = `${part.slice(0, room - 7).replace(/-+$/, "")}-${hash(`${part}${i}`).slice(0, 6)}`;
      const key = `${prefix}--${part}`;
      keep.add(key);
      const before = db.docSection(doc.id, key);
      const after = db.upsertSection(doc.id, key, { title: s.title, body: s.body, position: base + i / 1000, status: "current", source: rel }, actor, { at });
      if (!before || before.updated_at !== after.updated_at) changed++;
    });
    let superseded = 0;
    for (const s of existing) {
      if (keep.has(s.key) || s.status === "superseded") continue;
      db.upsertSection(doc.id, s.key, { status: "superseded" }, actor, { at });
      superseded++;
    }
    db.setDocSource(doc.id, rel, h, at ?? Date.now());
    return { doc: doc.id, changed, superseded };
  });
}

const orphanKey = (/** @type {number} */ repoId) => `analysis:orphans:${repoId}`;

/** The repo's analysis files no task was found for: path → when last seen. @param {any} db @param {number} repoId @returns {Record<string, number>} */
function orphans(db, repoId) {
  try {
    return JSON.parse(db.meta(orphanKey(repoId)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** @param {any} db @param {number} repoId @param {string} rel @param {number | null} at null: no longer an orphan */
function setOrphan(db, repoId, rel, at) {
  const o = orphans(db, repoId);
  if (at == null) delete o[rel];
  else o[rel] = at;
  // The newest 200: an old orphan is not worth keeping forever.
  const kept = Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 200));
  db.setMeta(orphanKey(repoId), Object.keys(kept).length ? JSON.stringify(kept) : null);
}

/**
 * Gives an orphan (or any analysis file) its task, read from where it is now.
 * @param {any} db @param {number} repoId @param {string} root @param {string} rel @param {string} taskKey @param {{kind: string, id?: string}} actor
 */
function assign(db, repoId, root, rel, taskKey, actor) {
  const text = rel.startsWith("plan:") ? undefined : fs.readFileSync(absPath(root, rel), "utf8");
  if (text === undefined) throw new Error(`Imprimatur: ${rel} cannot be read again`);
  setOrphan(db, repoId, rel, null);
  return ingest(db, repoId, taskKey, rel, text, { actor });
}

/** @typedef {{rel: string, text: string, session?: string, prompt?: string, branch?: string, at?: number, actor: {kind: string, id?: string}}} Item */
/** @typedef {{status: "not" | "unknown" | "orphan" | "ingested" | "off", task?: string, changed?: number}} Outcome */

/**
 * The checks before the verdict: the repo's settings, whether the file can be one.
 * @param {any} db @param {number} repoId @param {string} root @param {Item} it @returns {Outcome | undefined} an outcome: stop there
 */
function precheck(db, repoId, root, it) {
  const s = settingsOf(root);
  if (!s.on) return { status: "off" };
  const nosync = `analysis:nosync:${repoId}`;
  if (Boolean(db.meta(nosync)) === s.sync) db.setMeta(nosync, s.sync ? null : "1");
  if (!isCandidate(it.rel, it.text, s)) return { status: "not" };
  return undefined;
}

/**
 * One edit's file, handled end to end: is it an analysis, whose, into its document. The
 * model is asked only when allowed (the hook runs it in the background: onEdit).
 * @param {any} db @param {number} repoId @param {string} root @param {Item} it
 * @param {{ask?: (prompt: string) => Promise<string>, model?: boolean}} [o]
 * @returns {Promise<Outcome>}
 */
async function handle(db, repoId, root, it, o = {}) {
  const stop = precheck(db, repoId, root, it);
  if (stop) return stop;
  return place(db, repoId, it, await verdictOf(db, repoId, it.rel, it.text, o));
}

/**
 * The hook's part, quick: what the path, headings or a kept answer decide is done here;
 * a file only the model can judge goes to a background process (hooks/analysis.mjs).
 * @param {any} db @param {number} repoId @param {string} root @param {Item} it
 * @param {{start?: (root: string, it: Item) => void}} [o] start: tests replace the background process
 * @returns {Outcome | {status: "later"}}
 */
function onEdit(db, repoId, root, it, o = {}) {
  if (it.text.length > HOOK_MAX) return { status: "later" };
  const stop = precheck(db, repoId, root, it);
  if (stop) return stop;
  const v = quickVerdict(db, repoId, it.rel, it.text);
  if (v !== undefined) return place(db, repoId, it, v);
  // One model call per file at a time, and not again soon after one that gave no answer.
  const pending = `analysis:pending:${repoId}:${it.rel}`;
  if (Date.now() - Number(db.meta(pending) ?? 0) < PENDING_MS) return { status: "later" };
  db.setMeta(pending, Date.now());
  const start = o.start ?? (process.env.NODE_TEST_CONTEXT || process.env.IMPRIMATUR_CHILD ? () => {} : startDetached);
  start(root, it);
  return { status: "later" };
}

/** The model's verdict in its own process, outliving the hook; it reads the file again. @param {string} root @param {Item} it */
function startDetached(root, it) {
  const { spawn } = require("node:child_process");
  const args = [path.join(__dirname, "..", "hooks", "analysis.mjs"), root, it.rel, it.session ?? "", it.branch ?? "", String(it.at ?? Date.now())];
  spawn(process.execPath, args, { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, IMPRIMATUR_CHILD: "1" } }).unref();
}

/**
 * A judged file into its task's document, or the orphans when it has no task.
 * @param {any} db @param {number} repoId @param {Item} it @param {"yes" | "no" | undefined} v @returns {Outcome}
 */
function place(db, repoId, it, v) {
  if (v === "no") return { status: "not" };
  if (v === undefined) return { status: "unknown" };
  // A file already kept stays with its task, whatever the session is on now.
  const kept = db.sqlite.prepare(`SELECT d.scope FROM doc_sources x JOIN documents d ON d.id = x.doc_id
                                  WHERE d.repo_id = ? AND x.path = ? ORDER BY x.at DESC LIMIT 1`).get(repoId, it.rel)?.scope;
  const task = kept ?? taskFor(db, repoId, it);
  if (!task) {
    setOrphan(db, repoId, it.rel, it.at ?? Date.now());
    return { status: "orphan" };
  }
  setOrphan(db, repoId, it.rel, null);
  const r = ingest(db, repoId, task, it.rel, it.text, { actor: it.actor, at: it.at });
  return { status: "ingested", task, changed: r.changed };
}

module.exports = {
  settingsOf, relPath, absPath, isCandidate, heuristic, quickVerdict, verdictOf, onEdit, keyInPath, keyInBranch, taskFor,
  sectionsOf, splitBody, ingest, orphans, setOrphan, assign, handle, hash, SPECIAL,
};
