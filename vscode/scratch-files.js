// @ts-check
// Matt Pocock's local issue tracker under .scratch/ (#192), written from the database:
//   .scratch/<task>/spec.md          a task's spec document (Pocock's to-spec sections as chapters)
//   .scratch/<task>/map.md           a task's wayfinder map
//   .scratch/<task>/issues/NN-slug.md one per child task (ticket): Status, Type and Blocked by lines
// Only tasks with a spec or a map get a folder. .scratch/ stays out of git (its own .gitignore)
// unless the repo keeps it ({"scratch": {"commit": true}} in .claude/imprimatur.json).
// A hand edit is read back as the ADR files are (adr-files.js): when the database did not change
// since the file was written, the file wins; when both changed, the database wins and the file's
// text is kept as a note on the task.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DIR = ".scratch";
const hash = (/** @type {string} */ s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const metaKey = (/** @type {number} */ repoId, /** @type {string} */ rel) => `scratch:${repoId}:${rel}`;
/** A task key as a folder name: "#192" → "192", "PROJ-12" → "proj-12". @param {string} key */
const folderOf = (key) => String(key).replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
/** Pocock's ticket status from a task's. @param {string} status */
const statusOf = (status) => (status === "active" ? "claimed" : status === "done" || status === "dropped" ? "resolved" : "open");
/** A task's status from a ticket's Status line; undefined: not one of Pocock's. @param {string} s */
const taskStatusOf = (s) => ({ open: "open", claimed: "active", resolved: "done" })[/** @type {"open"} */ (String(s).trim().toLowerCase())];

/** Whether the repo keeps .scratch/ in git. @param {string} root */
function committed(root) {
  return require("./docs-export.js").repoSettings(root)?.scratch?.commit === true;
}

/**
 * A ticket's file: its Status, Type and Blocked by lines (issue-tracker-local), its title, and the
 * task's issue body or summary as the question.
 * @param {any} t the child task @param {Map<string, string>} numbers key → "NN" @param {string} header
 */
function ticketText(t, numbers, header) {
  let blocked = [];
  try {
    blocked = t.blocked_by ? JSON.parse(t.blocked_by) : [];
  } catch {}
  const lines = [`Status: ${statusOf(t.status)}`];
  if (t.ticket_type) lines.push(`Type: ${t.ticket_type}`);
  if (blocked.length) lines.push(`Blocked by: ${blocked.map((/** @type {string} */ k) => numbers.get(k) ?? k).join(", ")}`);
  const body = String(t.issue_body ?? t.summary ?? "").replace(/\r\n/g, "\n").trim();
  return [header, lines.join("\n"), `# ${String(t.title || t.key).replace(/\s+/g, " ").trim()}`, `Task: ${t.key}`, body || "## Question\n\nNot written yet."].join("\n\n") + "\n";
}

/** A ticket file's Status line and title. @param {string} text */
function parseTicket(text) {
  const status = /^Status:\s*(.+)$/m.exec(text)?.[1];
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  return { status, title };
}

/**
 * Writes one generated file, reading a hand edit back first. Returns whether it wrote.
 * @param {any} db @param {any} repo @param {string} root @param {string} rel
 * @param {() => string | undefined} make the file's text from the database now
 * @param {(text: string) => void} take reads a hand edit into the database
 * @param {() => number} changedAt when the database side last changed
 * @param {(text: string) => void} keep keeps a clashing file's text (as a note)
 * @param {{generatedText: (t: string) => boolean, inside: (f: string) => boolean}} io
 */
function writeOne(db, repo, root, rel, make, take, changedAt, keep, io) {
  const f = path.join(root, rel);
  if (!io.inside(f)) return false;
  let old;
  try {
    old = fs.readFileSync(f, "utf8");
  } catch {}
  if (old !== undefined && !io.generatedText(old)) return false;
  const raw = db.meta(metaKey(repo.id, rel));
  const last = raw ? JSON.parse(raw) : undefined;
  if (old !== undefined && last && hash(old) !== last.hash) {
    if (changedAt() < last.at) take(old);
    else keep(old);
  }
  const want = make();
  if (want === undefined) return false;
  db.setMeta(metaKey(repo.id, rel), JSON.stringify({ hash: hash(want), at: Date.now() }));
  if (old === want) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, want);
  fs.renameSync(tmp, f);
  return true;
}

/**
 * Writes .scratch/ for every task with a spec or a map (#192). Returns the files written.
 * @param {any} db @param {any} repo @param {string} root
 * @param {{header: string, generatedText: (t: string) => boolean, inside: (f: string) => boolean}} io
 */
function exportScratch(db, repo, root, io) {
  const docs = db.q("SELECT * FROM documents WHERE repo_id = ? AND kind IN ('spec', 'map') ORDER BY scope, kind").all(repo.id);
  if (!docs.length) return [];
  const { docMarkdown } = require("./docs-export.js");
  const { parseManaged } = require("./docs-sync.js");
  const actor = { kind: /** @type {const} */ ("import"), name: "scratch" };
  const written = [];
  const dir = path.join(root, DIR);
  if (!io.inside(dir)) return [];
  fs.mkdirSync(dir, { recursive: true });
  // Out of git unless the repo keeps it.
  const ignore = path.join(dir, ".gitignore");
  if (committed(root)) fs.rmSync(ignore, { force: true });
  else if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# Written by Imprimatur: .scratch/ stays out of git unless .claude/imprimatur.json says {\"scratch\": {\"commit\": true}}.\n*\n");
  const tasks = new Set();
  for (const doc of docs) {
    const task = db.taskByKey(repo.id, doc.scope);
    const folder = folderOf(doc.scope);
    tasks.add(doc.scope);
    const rel = path.join(DIR, folder, `${doc.kind}.md`);
    const note = (/** @type {string} */ text) => task && db.addRecord(task.id, { kind: "note", title: `${rel}: an edit of the file was not taken, the ${doc.kind} changed too`, body: text }, actor);
    const take = (/** @type {string} */ text) => {
      const now = new Map(db.docSections(doc.id).map((/** @type {any} */ s) => [s.key, s]));
      for (const s of parseManaged(text)) {
        const cur = now.get(s.key);
        if (cur && (cur.title !== s.title || String(cur.body ?? "").trim() !== s.body.trim())) db.upsertSection(doc.id, s.key, { title: s.title, body: s.body || null }, actor);
      }
    };
    if (writeOne(db, repo, root, rel, () => docMarkdown(db, doc.id), take, () => db.docById(doc.id).updated_at, note, io)) written.push(path.join(root, rel));
  }
  // The tickets: the children of each task that has a spec or a map, numbered in key order.
  for (const key of tasks) {
    const task = db.taskByKey(repo.id, key);
    if (!task) continue;
    const num = (/** @type {any} */ t) => Number(/\d+/.exec(t.key)?.[0] ?? Infinity);
    const kids = db.q("SELECT * FROM tasks WHERE epic_id = ? AND id <> ?").all(task.id, task.id).sort((/** @type {any} */ a, /** @type {any} */ b) => num(a) - num(b));
    const numbers = new Map(kids.map((/** @type {any} */ t, /** @type {number} */ i) => [t.key, String(i + 1).padStart(2, "0")]));
    const want = new Set();
    for (const t of kids) {
      const name = `${numbers.get(t.key)}-${require("./decisions.js").slug(t.title || t.key)}.md`;
      want.add(name);
      const rel = path.join(DIR, folderOf(key), "issues", name);
      const take = (/** @type {string} */ text) => {
        const got = parseTicket(text);
        const status = got.status && taskStatusOf(got.status);
        db.upsertTask(repo.id, t.key, { ...(status && status !== t.status && { status }), ...(got.title && got.title !== t.title && { title: got.title }) }, actor);
      };
      const note = (/** @type {string} */ text) => db.addRecord(t.id, { kind: "note", title: `${rel}: an edit of the file was not taken, the task changed too`, body: text }, actor);
      const fresh = () => db.taskByKey(repo.id, t.key);
      if (writeOne(db, repo, root, rel, () => ticketText(fresh(), numbers, io.header), take, () => fresh().updated_at, note, io)) written.push(path.join(root, rel));
    }
    // A ticket renamed or renumbered: its old generated file goes.
    const issues = path.join(root, DIR, folderOf(key), "issues");
    if (fs.existsSync(issues))
      for (const name of fs.readdirSync(issues)) {
        if (want.has(name) || !/^\d{2}-.*\.md$/.test(name)) continue;
        const f = path.join(issues, name);
        try {
          if (io.generatedText(fs.readFileSync(f, "utf8"))) fs.rmSync(f);
        } catch {}
      }
  }
  return written;
}

module.exports = { exportScratch, ticketText, parseTicket, folderOf, statusOf, DIR };
