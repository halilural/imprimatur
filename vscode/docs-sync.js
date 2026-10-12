// @ts-check
// Design documents ↔ their Markdown files (#73): whenever Imprimatur comes to a repo
// (before the documents exist, with hand-written ones, or after a migration that left
// only records), one sync brings the database and <docs dir>/ARCHITECTURE.md and
// PRODUCT.md to the same text, and keeps them there.
//
// The database is the source of truth; the file is its view, which people also edit.
// For each document the last sync's state is kept in the meta table (local to this
// machine): the file's path and each section's hash as written. Per section key:
//   - same text on both sides: nothing
//   - only the file changed since the last sync: the database takes it (actor import:file)
//   - only the database changed, or no last state (first sync on this machine): the file follows
//   - both changed: a conflict; neither side is written until `take` settles it
//   - a section only in the file: created; deleted from the file (and unchanged in the
//     database): superseded
// A hand-written file (no HEADER), or the file at a git revision (rev, for a repo whose
// files went away after #59's import), is adopted: its "##" headings become sections,
// what comes before the first one "overview", the table of contents dropped; the
// records imported from that file (links.source, links.area) are linked to the section
// they sat under. The file is then written in Imprimatur's form and synced from then on.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { docMarkdown, fileOf, inside, docsSettings, FILES, HEADER } = require("./docs-export.js");
const { fenceTracker, filesAt, importRepo, originOf } = require("./import.js");
const { slugify } = require("./docsView.js");

const ACTOR = { kind: /** @type {"import"} */ ("import"), id: "file" };
const OVERVIEW = { key: "overview", title: "Genel bakış" };

const hash = (/** @type {string} */ s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const norm = (/** @type {string | null | undefined} */ s) => String(s ?? "").replace(/\r\n/g, "\n").trim();
/** What a section says, as one hash: its title and body. @param {{title: string, body?: string | null}} s */
const sectionHash = (s) => hash(`${norm(s.title).replace(/\s+/g, " ")}\n\n${norm(s.body)}`);

const trimBlank = (/** @type {string[]} */ lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/** @typedef {{key: string, title: string, body: string, area?: string}} FileSection */

/**
 * A file Imprimatur wrote (docs-export.js docMarkdown): a section opens with a line
 * `<a id="key"></a>` whose next non-blank line is its "## n. Title"; everything before the
 * first (header, title, contents) is not one. No code-fence tracking: an unclosed fence in
 * one body must not swallow the sections after it (roundTrips guards the rest).
 * @param {string} text @returns {FileSection[]}
 */
function parseManaged(text) {
  /** @type {{key: string, title: string, lines: string[]}[]} */
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const a = /^<a id="([a-z0-9][a-z0-9-]*)"><\/a>\s*$/.exec(lines[i]);
    let j = i + 1;
    while (a && j < lines.length && !lines[j].trim()) j++;
    const h = a && /^##\s+(?:\d+\.\s+)?(.*?)\s*$/.exec(lines[j] ?? "");
    if (a && h) {
      out.push({ key: a[1], title: h[1], lines: [] });
      i = j;
    } else if (out.length) out[out.length - 1].lines.push(lines[i]);
  }
  return out.map((s) => ({ key: s.key, title: s.title, body: trimBlank(s.lines).join("\n") }));
}

/** Whether the document's Markdown reads back as its current sections. @param {any} db @param {number} docId */
function roundTrips(db, docId) {
  const text = docMarkdown(db, docId);
  if (text === undefined) return true;
  const want = db.docSections(docId).filter((/** @type {any} */ s) => s.status === "current").map((/** @type {any} */ s) => `${s.key}:${sectionHash(s)}`);
  const got = parseManaged(text).map((s) => `${s.key}:${sectionHash(s)}`);
  return want.join("\n") === got.join("\n");
}

/** A line of a table of contents: "- [x](#y)", "1. [x](#y)", or its heading. @param {string} line */
const tocLine = (line) => /^\s*(?:[-*]|\d+\.)\s+\[[^\]]*\]\(#[^)]*\)\s*$/.test(line) || /^\s*(?:İçindekiler|Içindekiler|Contents|Table of contents)\s*:?\s*$/i.test(line);

/**
 * A hand-written design document: each "##" heading a section (deeper headings stay in its
 * body), the text before the first one "overview"; tables of contents (<!-- toc --> blocks,
 * link lists before the first heading) left out. Keys are the titles' slugs, unique.
 * @param {string} text @returns {FileSection[]}
 */
function parseHand(text) {
  /** @type {{title: string, area: string, lines: string[]}[]} */
  const parts = [{ title: "", area: "", lines: [] }];
  const fence = fenceTracker();
  let toc = false;
  let titled = false;
  for (const line of text.split(/\r?\n/)) {
    const inFence = fence(line);
    if (!inFence && /^\s*<!--\s*toc\s*-->\s*$/i.test(line)) {
      toc = true;
      continue;
    }
    if (toc) {
      if (/^\s*<!--\s*tocstop\s*-->\s*$/i.test(line)) toc = false;
      continue;
    }
    const h = !inFence && /^(#{1,2})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    // The document's title (its first "#") is Imprimatur's own; any later "#" stays as text.
    if (h && h[1].length === 1 && !titled) {
      titled = true;
      continue;
    }
    if (h && h[1].length === 1) {
      parts[parts.length - 1].lines.push(line);
      continue;
    }
    if (h) parts.push({ title: h[2].replace(/^\d+\.\s+/, ""), area: h[2], lines: [] });
    else parts[parts.length - 1].lines.push(line);
  }
  const used = new Set();
  /** @type {FileSection[]} */
  const out = [];
  parts.forEach((p, i) => {
    const lines = i === 0 ? p.lines.filter((l) => !tocLine(l)) : p.lines;
    const body = trimBlank(lines).join("\n");
    if (i === 0 && !body) return;
    const title = i === 0 ? OVERVIEW.title : p.title;
    const base = i === 0 ? OVERVIEW.key : slugify(title);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`.slice(0, 64);
    used.add(key);
    out.push({ key, title, body, area: p.area });
  });
  return out;
}

/** Whether the repo opted in to having its hand-written files adopted: a "docs" key in .claude/imprimatur.json. @param {string} root */
function optedIn(root) {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(root, ".claude", "imprimatur.json"), "utf8"))?.docs) && docsSettings(root).sync !== false;
  } catch {
    return false;
  }
}

/** Whether the text is one Imprimatur wrote. @param {string} text */
const managed = (text) => text.split("\n", 1)[0].replace(/\r$/, "") === HEADER;

/** @param {number} repoId @param {string} kind */
const stateKey = (repoId, kind) => `docsync:${repoId}:${kind}`;

/** @param {any} db @param {number} repoId @param {string} kind @returns {{file: string, sections: Record<string, string>, conflicts?: string[]} | undefined} */
function stateOf(db, repoId, kind) {
  try {
    const v = db.meta(stateKey(repoId, kind));
    return v ? JSON.parse(v) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The conflicts the last sync left in a repo's documents, by kind.
 * @param {any} db @param {number} repoId @returns {Record<string, string[]>}
 */
function conflictsOf(db, repoId) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const kind of Object.keys(FILES)) {
    const c = stateOf(db, repoId, kind)?.conflicts;
    if (c?.length) out[kind] = c;
  }
  return out;
}

/** The repo's row for a root (created when missing and writing). @param {any} db @param {string} root @param {boolean} dryRun */
function repoFor(db, root, dryRun) {
  let repo = db.repoByRoot(root);
  if (!repo) {
    try {
      repo = db.repoByRoot(fs.realpathSync(root));
    } catch {}
  }
  if (!repo && !dryRun) repo = db.repoOf(root, { origin: originOf(root) });
  return repo;
}

/**
 * The text to adopt from a git revision: the kind's file at the configured path, else
 * where design documents used to live.
 * @param {string} root @param {string} rev @param {string} kind
 * @returns {{rel: string, text: string} | undefined}
 */
function atRevision(root, rev, kind) {
  const at = filesAt(root, rev);
  const name = /** @type {any} */ (FILES)[kind];
  const rels = [path.relative(root, fileOf(root, kind)), path.join("docs", "design", name), path.join("docs", name), name];
  for (const rel of [...new Set(rels)]) {
    const text = at.read(rel);
    if (text !== undefined && !managed(text)) return { rel, text };
  }
  return undefined;
}

/**
 * @typedef {{kind: string, file: string, adopted?: string, backup?: string, imported: string[], superseded: string[],
 *   conflicts: string[], linked: number, written: boolean, skipped?: "outside" | "manual", unreadable?: boolean}} SyncReport
 */

/**
 * Syncs one document and its file.
 * @param {any} db @param {any} repo @param {string} root @param {string} kind
 * @param {{dryRun?: boolean, take?: "file" | "db", adopt?: {rel: string, text: string}, adoptFiles?: boolean}} o
 * adopt: text to take in as hand-written (a git revision's file) instead of the file on disk;
 * adoptFiles: a hand-written file on disk may be adopted (else it is left alone, "manual")
 * @returns {SyncReport}
 */
function syncKind(db, repo, root, kind, { dryRun = false, take, adopt, adoptFiles = false }) {
  const file = fileOf(root, kind);
  /** @type {SyncReport} */
  const report = { kind, file, imported: [], superseded: [], conflicts: [], linked: 0, written: false };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  if (!adopt && text !== undefined && !managed(text) && !adoptFiles) {
    report.skipped = "manual";
    return report;
  }
  const source = adopt ?? (text !== undefined && !managed(text) ? { rel: path.relative(root, file), text } : undefined);
  /** @type {FileSection[]} */
  const fileSecs = source ? parseHand(source.text) : text !== undefined ? parseManaged(text) : [];
  if (source) report.adopted = source.rel;

  const doc = repo ? db.docFind(repo.id, kind) : undefined;
  const all = doc ? db.docSections(doc.id) : [];
  const current = new Map(all.filter((/** @type {any} */ s) => s.status === "current").map((/** @type {any} */ s) => [s.key, s]));
  const retired = new Set(all.filter((/** @type {any} */ s) => s.status !== "current").map((/** @type {any} */ s) => s.key));
  const state = repo ? stateOf(db, repo.id, kind) : undefined;
  const base = !source && state?.file === path.relative(root, file) ? state.sections : undefined;
  // The file is read back only when the database's own text reads back as its sections
  // (a body with an anchor line and a "##" after it would split): else nothing moves either way.
  if (!source && text !== undefined && doc && !roundTrips(db, doc.id)) {
    report.unreadable = true;
    return report;
  }

  /** @type {FileSection[]} */ const toImport = [];
  /** @type {string[]} */ const toSupersede = [];
  /** Changed on both sides, or no last sync to tell which: `take` decides, else a conflict. @param {FileSection} f */
  const settle = (f) => {
    if (take === "file") toImport.push(f);
    else if (take !== "db") report.conflicts.push(f.key);
  };
  const fileKeys = new Set(fileSecs.map((s) => s.key));
  for (const f of fileSecs) {
    const fh = sectionHash(f);
    const was = base?.[f.key];
    const d = current.get(f.key);
    if (!d) {
      // Superseded in the database (or gone since the last sync) and the file unchanged: the
      // file follows; edited in the file meanwhile: a conflict. Only in the file: new.
      if (retired.has(f.key) || was !== undefined) {
        if (was !== fh) settle(f);
      } else toImport.push(f);
      continue;
    }
    const dh = sectionHash(d);
    if (fh === dh) continue;
    if (!source && was === dh) toImport.push(f);
    else if (!source && was === fh) continue;
    else settle(f);
  }
  // Deleted from the file Imprimatur wrote, unchanged in the database since: superseded.
  if (!source && base && text !== undefined) {
    for (const [key, d] of current) {
      if (!fileKeys.has(key) && base[key] === sectionHash(d)) toSupersede.push(key);
    }
  }
  report.imported = toImport.map((s) => s.key);
  report.superseded = toSupersede;

  // Records imported from the adopted file, to the section they sat under (#59 links.source/area).
  /** @type {Map<string, number[]>} */
  const links = new Map();
  if (source && repo) {
    const byArea = new Map(fileSecs.map((s) => [s.area ?? "", s.key]));
    for (const r of db.recordsFromSource(repo.id, source.rel)) {
      if (r.status === "dropped" || r.links?.area === undefined) continue;
      const key = byArea.get(r.links.area);
      if (!key || report.conflicts.includes(key)) continue;
      links.set(key, [...(links.get(key) ?? []), r.id]);
    }
    for (const [key, ids] of links) {
      const have = new Set(current.get(key)?.records ?? []);
      report.linked += ids.filter((id) => !have.has(id)).length;
    }
  }
  if (dryRun) {
    // Would write: anything taken in, an adoption, or a document the file does not show yet.
    report.written = !report.conflicts.length && (toImport.length > 0 || toSupersede.length > 0 || source !== undefined || (current.size > 0 && text === undefined));
    return report;
  }
  if (!repo) return report;

  const theDoc = toImport.length || links.size ? db.docOf(repo.id, kind) : doc;
  if (theDoc) {
    // New sections keep the file's order among the ones the database has.
    const order = fileSecs.map((s) => s.key);
    const positionOf = (/** @type {string} */ key) => {
      const s = db.docSection(theDoc.id, key);
      return s?.status === "current" ? s.position : undefined;
    };
    for (const f of toImport) {
      let position = positionOf(f.key);
      if (position === undefined) {
        const i = order.indexOf(f.key);
        const prev = order.slice(0, i).reverse().map(positionOf).find((p) => p !== undefined);
        const next = order.slice(i + 1).map(positionOf).find((p) => p !== undefined);
        const last = Math.max(0, ...db.docSections(theDoc.id).map((/** @type {any} */ s) => s.position));
        if (prev !== undefined && next !== undefined && next > prev) position = (prev + next) / 2;
        else if (prev === undefined && next !== undefined) position = next - 1;
        else position = last + 1;
      }
      db.upsertSection(theDoc.id, f.key, { title: f.title, body: f.body || null, status: "current", position, addRecords: links.get(f.key) ?? [] }, ACTOR);
      links.delete(f.key);
    }
    for (const [key, ids] of links) {
      if (db.docSection(theDoc.id, key)) db.upsertSection(theDoc.id, key, { addRecords: ids }, ACTOR);
    }
    for (const key of toSupersede) db.upsertSection(theDoc.id, key, { status: "superseded" }, ACTOR);
  }

  const rel = path.relative(root, file);
  if (report.conflicts.length) {
    // Neither side written: the file keeps its edits until `take` settles them.
    db.setMeta(stateKey(repo.id, kind), JSON.stringify({ ...(state ?? { file: rel, sections: {} }), conflicts: report.conflicts }));
    return report;
  }
  const out = theDoc ? docMarkdown(db, theDoc.id) : undefined;
  if (out !== undefined && out !== text) {
    if (!inside(root, file)) return { ...report, skipped: "outside" };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!inside(root, file)) return { ...report, skipped: "outside" };
    if (text !== undefined && !managed(text)) {
      // The hand-written original, as it was, before Imprimatur's form replaces it.
      const backup = path.join(root, ".claude", "imprimatur", "docs-backup", `${path.basename(file, ".md")}-${Date.now()}.md`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, text);
      report.backup = path.relative(root, backup);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, file);
    report.written = true;
  }
  if (theDoc) {
    const sections = Object.fromEntries(db.docSections(theDoc.id).filter((/** @type {any} */ s) => s.status === "current").map((/** @type {any} */ s) => [s.key, sectionHash(s)]));
    db.setMeta(stateKey(repo.id, kind), JSON.stringify({ file: rel, sections }));
  }
  return report;
}

/**
 * Brings a repo's design documents and their files to the same text (see the top).
 * rev: first imports the design and product records of that git revision (#59 importer,
 * moving misfiled ones) and adopts the files as they were there.
 * adopt: a hand-written file on disk may be adopted; by default only when the repo opted in
 * ({"docs": {...}} in .claude/imprimatur.json), else it is left alone. The CLI and the
 * importer pass true: someone asked.
 * @param {any} db @param {string} root a repo root on this machine
 * @param {{dryRun?: boolean, take?: "file" | "db", rev?: string, adopt?: boolean}} [o]
 * @returns {SyncReport[]}
 */
function syncDocs(db, root, { dryRun = false, take, rev, adopt = optedIn(root) } = {}) {
  const repo = repoFor(db, root, dryRun);
  const out = [];
  for (const kind of Object.keys(FILES)) out.push(syncKind(db, repo, root, kind, { dryRun, take, adoptFiles: adopt }));
  if (!rev || out.some((r) => r.conflicts.length || r.unreadable)) return out;
  if (!dryRun) importRepo(db, root, { rev, only: ["design", "product"] });
  return Object.keys(FILES).map((kind) => {
    const from = atRevision(root, rev, kind);
    return from ? syncKind(db, repo, root, kind, { dryRun, take, adopt: from }) : /** @type {SyncReport} */ (out.find((r) => r.kind === kind));
  });
}

/** One line per document for a report. @param {SyncReport[]} reports @param {string} [root] */
function describe(reports, root) {
  return reports.map((r) => {
    const file = root ? path.relative(root, r.file) : r.file;
    const parts = [
      r.adopted && `adopted ${r.adopted}`,
      r.imported.length && `from the file: ${r.imported.join(", ")}`,
      r.superseded.length && `superseded: ${r.superseded.join(", ")}`,
      r.linked && `${r.linked} records linked`,
      r.conflicts.length && `CONFLICT (changed in the file and in Imprimatur): ${r.conflicts.join(", ")}; --take file or --take db`,
      r.skipped === "outside" && "not written: leads outside the repo",
      r.skipped === "manual" && "hand-written, left alone (adopt it: npm run docs -- sync, or {\"docs\": {}} in .claude/imprimatur.json)",
      r.unreadable && "NOT synced: Imprimatur's own text of it does not read back as its sections (a body line `<a id=…></a>` before a \"##\"?); fix the section in the panel",
      r.written && "file written",
      r.backup && `original kept in ${r.backup}`,
    ].filter(Boolean);
    return `${file}: ${parts.length ? parts.join("; ") : "in sync"}`;
  });
}

module.exports = { syncDocs, describe, conflictsOf, parseManaged, parseHand, sectionHash };
