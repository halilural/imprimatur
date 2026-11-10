// @ts-check
// ADRs as files in Matt Pocock's ADR-FORMAT (#191): docs/adr/NNNN-slug.md, one per adr record,
// numbered like the MADR files (links.madr, decisions.js numbered), so a number never changes.
// The record is the source, but a hand edit of a generated file is read back into it: when the
// record did not change since the file was written, the file's title and text win; when both
// changed, the record wins and the file's text is kept as a note on the task, so nothing is lost.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { numbered, shortTitle, fileName } = require("./decisions.js");

const DIR = path.join("docs", "adr");
const hash = (/** @type {string} */ s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const metaKey = (/** @type {number} */ repoId, /** @type {string} */ uid) => `adrfile:${repoId}:${uid}`;
const clean = (/** @type {unknown} */ s) => String(s ?? "").replace(/\r\n/g, "\n").trim();

/** The text under the heading: the full title when the heading had to shorten it, then the record's body. @param {any} r */
function bodyOf(r) {
  const full = String(r.title).replace(/\s+/g, " ").trim();
  return [shortTitle(full) !== full ? full : "", clean(r.body)].filter(Boolean).join("\n\n");
}

/**
 * An ADR's file: front matter (status, the record), the generated-file header, "# <title>" and the
 * decision in prose. Pocock's optional sections are not added: the record's text carries them when it has them.
 * @param {any} r a record with links.madr @param {string} header
 */
function adrText(r, header) {
  const status = r.status === "dropped" ? "deprecated" : "accepted";
  const title = shortTitle(r.title).replace(/[.,;:!]+$/, "");
  return [`---\nstatus: ${status}\nrecord: ${r.uid}\n---`, header, `# ${title}`, bodyOf(r) || "Not written yet."].join("\n\n") + "\n";
}

/** A file's heading and text, front matter and header left out. @param {string} text */
function parseAdr(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") i = lines.findIndex((l, j) => j > 0 && l.trim() === "---") + 1;
  const h = lines.findIndex((l, j) => j >= i && /^#\s+\S/.test(l));
  if (h < 0) return undefined;
  return { title: lines[h].replace(/^#\s+/, "").trim(), body: clean(lines.slice(h + 1).join("\n")) };
}

/**
 * Takes a file's edit into its record when the record did not change since the file was written.
 * Returns the record as it is now.
 * @param {any} db @param {any} r @param {string} text @param {{at: number}} last
 */
function takeEdit(db, r, text, last) {
  const got = parseAdr(text);
  if (!got) return r;
  const actor = { kind: /** @type {const} */ ("import"), name: "adr-files" };
  if (r.updated_at >= last.at) {
    db.addRecord(r.task_id, { kind: "note", title: `ADR ${String(r.links.madr).padStart(4, "0")}: an edit of its file was not taken, the record changed too`, body: text }, actor);
    return r;
  }
  const full = String(r.title).replace(/\s+/g, " ").trim();
  const short = shortTitle(full).replace(/[.,;:!]+$/, "");
  /** @type {{title?: string, body?: string | null}} */
  const patch = {};
  if (got.title !== short) patch.title = got.title;
  // The full title opens the text when the heading shortened it: it is the title, not the body.
  let body = got.body === "Not written yet." ? "" : got.body;
  if (shortTitle(full) !== full && body.startsWith(full)) body = clean(body.slice(full.length));
  if (body !== clean(r.body)) patch.body = body || null;
  if (!Object.keys(patch).length) return r;
  db.updateRecord(r.id, patch, actor);
  return { ...r, ...db.record(r.id), task_key: r.task_key, task_title: r.task_title };
}

/**
 * Writes a repo's ADR files (#191), each only when it changed, after reading a hand edit back.
 * A hand-written file of the same name is left alone; a generated one whose ADR was renamed goes.
 * @param {any} db @param {any} repo @param {string} root
 * @param {{header: string, generatedText: (t: string) => boolean, inside: (f: string) => boolean}} io
 * @returns {string[]} the files written
 */
function exportAdrs(db, repo, root, io) {
  const recs = numbered(db, repo.id).filter((/** @type {any} */ r) => r.kind === "adr");
  if (!recs.length) return [];
  const dir = path.join(root, DIR);
  if (!io.inside(dir)) return [];
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const names = new Set();
  for (let r of recs) {
    const f = path.join(dir, fileName(r));
    let old;
    try {
      old = fs.readFileSync(f, "utf8");
    } catch {}
    if (old !== undefined && !io.generatedText(old)) {
      names.add(fileName(r));
      continue;
    }
    const raw = db.meta(metaKey(repo.id, r.uid));
    const last = raw ? JSON.parse(raw) : undefined;
    if (old !== undefined && last && hash(old) !== last.hash) r = takeEdit(db, r, old, last);
    const want = adrText(r, io.header);
    const name = fileName(r);
    names.add(name);
    const target = path.join(dir, name);
    let cur;
    try {
      cur = target === f ? old : fs.readFileSync(target, "utf8");
    } catch {}
    if (cur !== want) {
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, want);
      fs.renameSync(tmp, target);
      written.push(target);
    }
    db.setMeta(metaKey(repo.id, r.uid), JSON.stringify({ hash: hash(want), at: Date.now() }));
  }
  // An ADR renamed: its old generated file goes (the number stays with the new name).
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-.*\.md$/.test(name) || names.has(name)) continue;
    const f = path.join(dir, name);
    try {
      if (io.generatedText(fs.readFileSync(f, "utf8"))) fs.rmSync(f);
    } catch {}
  }
  return written;
}

module.exports = { exportAdrs, adrText, parseAdr, DIR };
