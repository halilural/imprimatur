// @ts-check
// Markdown records → Imprimatur's database (#59). The database is the source
// of truth; this moves what repos kept in Markdown:
// - docs/todos/<key>/TODO.md (and the older todos/<key>/): the task (title,
//   status, epic) and each prefixed line (TODO, DONE, FIXME, CANCELED,
//   QUESTION, ANSWERED "q → a", DECISION, NOTE; (C)/(K), 👉). Indented lines
//   continue the record above. Text outside such lines (free sections) becomes
//   a note, so nothing is lost.
// - docs/design/*.md: each "ARCH:" line an ADR record, a section's other text
//   (prose, diagrams) one ADR record under the heading; task "ADR". Not
//   docs/design/PRODUCT.md (product, below) nor README.md (how the folder is kept,
//   no design in it), #73.
// - PRODUCT.md, docs/product/*.md, docs/design/PRODUCT.md: each section a PDR
//   record; task "PDR".
// - docs/testing/*.md: each section a test record; task "TEST".
// A file Imprimatur generated (docs-export.js HEADER) is never a source.
// Every record's uid comes from its file and text, so a second run updates
// (a TODO that became DONE) instead of adding. A record in another task than its
// file now says (an earlier run put it there) moves: the old one dropped, a new one
// added. links.area is the "##" heading it sits under: docs-sync.js links it to that
// document section. rev reads the files from a git revision (files since deleted).
"use strict";
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
/** Where task folders lived, newer layout first (#54). */
const TODO_DIRS = [path.join("docs", "todos"), "todos"];

const ACTOR = { kind: /** @type {"import"} */ ("import"), id: "markdown" };

/** Line prefix → record fields. */
const PREFIXES = {
  TODO: { kind: "todo", status: "open" },
  DONE: { kind: "todo", status: "done" },
  FIXME: { kind: "fixme", status: "open" },
  CANCELED: { kind: "todo", status: "dropped" },
  CANCELLED: { kind: "todo", status: "dropped" },
  KAPANDI: { kind: "todo", status: "dropped" },
  QUESTION: { kind: "question", status: "open", owner: "K" },
  ANSWERED: { kind: "question", status: "done", owner: "K" },
  DECISION: { kind: "decision", status: "done" },
  DECIDED: { kind: "decision", status: "done" },
  NOTE: { kind: "note", status: "done" },
  NOT: { kind: "note", status: "done" },
};
const ITEM = new RegExp(`^- (👉 )?(${Object.keys(PREFIXES).join("|")}): ?(.*)$`);

/** Task status from the "## Durum" / "## Status" text. @param {string} text */
function taskStatus(text) {
  // "İ".toLowerCase() leaves a combining dot: "i̇ptal".
  const t = text.trim().toLowerCase().replace(/\u0307/g, "");
  if (/^(bitti|done|tamamland|kapand|closed|completed)/.test(t)) return "done";
  if (/^(iptal|cancel|vazge)/.test(t)) return "dropped";
  if (/^(sürüyor|devam|in progress|başladı|started)/.test(t)) return "active";
  return "open";
}

/** "(C) text", "(K, isteğe bağlı) text" → owner and the rest. @param {string} text */
function ownerOf(text) {
  const m = /^\((C|K)\b[^)]*\)\s*/.exec(text);
  return m ? { owner: m[1], rest: text.slice(m[0].length) } : { owner: null, rest: text };
}

const hash = (/** @type {string} */ s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);

/**
 * Feed it lines in order: true while a line is inside (or opens or closes) a
 * fenced code block. Only the opening marker's kind, at least as long, closes it.
 */
function fenceTracker() {
  let open = "";
  return (/** @type {string} */ line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!open) {
      if (m) open = m[1];
      return Boolean(m);
    }
    if (m && m[1][0] === open[0] && m[1].length >= open.length && !line.trim().slice(m[1].length)) open = "";
    return true;
  };
}

/**
 * Splits Markdown into sections by headings (level ≥ 2); fenced code stays whole.
 * @param {string} text @returns {{level: number, heading: string, lines: string[]}[]}
 */
function sections(text) {
  /** @type {{level: number, heading: string, area: string, lines: string[]}[]} */
  const out = [{ level: 1, heading: "", area: "", lines: [] }];
  const fence = fenceTracker();
  // The "##" heading a part sits under ("" before the first).
  let area = "";
  for (const line of text.split(/\r?\n/)) {
    const h = !fence(line) && /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (h) {
      if (h[1].length <= 2) area = h[1].length === 2 ? h[2] : "";
      out.push({ level: h[1].length, heading: h[2], area, lines: [] });
    } else out[out.length - 1].lines.push(line);
  }
  return out;
}

const trimBlank = (/** @type {string[]} */ lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/**
 * One TODO.md → the task and its records, in order.
 * @param {string} text @param {string} key
 */
function parseTodo(text, key) {
  const parts = sections(text);
  const h1 = parts.find((p) => p.level === 1 && p.heading);
  const title = (h1?.heading ?? "").replace(/^#?[\w-]+\s*·\s*/, "").trim();
  const head = [...parts[0].lines, ...(h1?.lines ?? [])].join("\n");
  const epic = /(?:Epic|Part of|Parent)\s*\[(#\d+|[A-Z][A-Z0-9]+-\d+)\]/i.exec(head)?.[1];
  const statusPart = parts.find((p) => /^(durum|status)\b/i.test(p.heading));
  const summary = statusPart ? trimBlank(statusPart.lines).join("\n") : null;
  /** @type {any[]} */
  const records = [];
  /** @type {string[]} */
  const unparsed = [];
  // The check: one record per prefixed line read, two for an answered "q → a".
  let expected = 0;
  for (const part of parts) {
    if (part.level === 1 || part === statusPart) continue;
    /** @type {any} */ let last = null;
    /** @type {string[]} */ let free = [];
    const fence = fenceTracker();
    const flushFree = () => {
      const body = trimBlank(free);
      free = [];
      if (body.length) records.push({ kind: "note", status: "done", owner: null, title: part.heading, body: body.join("\n"), section: part.heading, free: true });
    };
    for (const line of part.lines) {
      // A "- TODO:" inside a code block is an example, not a record.
      const m = !fence(line) && ITEM.exec(line);
      if (m) {
        expected += m[2] === "ANSWERED" && m[3].includes("→") ? 2 : 1;
        flushFree();
        const base = PREFIXES[/** @type {keyof typeof PREFIXES} */ (m[2])];
        const { owner, rest } = ownerOf(m[3]);
        last = { ...base, owner: owner ?? base.owner ?? null, title: rest.trim(), body: null, pointer: Boolean(m[1]), section: part.heading };
        if (m[2] === "ANSWERED") {
          // "question → answer": the question, closed, and its answer.
          const i = rest.indexOf("→");
          if (i > 0) {
            last.title = rest.slice(0, i).trim();
            records.push(last);
            last = { kind: "answer", status: "done", owner: "K", title: rest.slice(i + 1).trim(), body: null, pointer: false, section: part.heading, answers: last };
          }
        }
        records.push(last);
      } else if (last && /^\s+\S/.test(line)) {
        last.body = last.body ? `${last.body}\n${line.trim()}` : line.trim();
      } else if (line.trim()) {
        last = null;
        if (/^- /.test(line)) unparsed.push(line);
        free.push(line);
      } else if (free.length) free.push(line);
    }
    flushFree();
  }
  return { task: { key, title, epic, status: taskStatus(summary ?? ""), summary }, records, unparsed, expected };
}

/**
 * A design document: ARCH lines are ADR records; each section's other text is one more.
 * @param {string} text @param {string} file
 */
function parseDesign(text, file) {
  /** @type {any[]} */
  const records = [];
  for (const part of sections(text)) {
    const heading = part.heading || path.basename(file);
    /** @type {any[]} */ const archs = [];
    /** @type {string[]} */ const other = [];
    /** @type {any} */ let last = null;
    for (const line of part.lines) {
      const m = /^- ARCH: ?(.*)$/.exec(line);
      if (m) {
        last = { kind: "adr", status: "done", owner: null, title: m[1].trim(), body: null, section: heading, area: part.area };
        archs.push(last);
      } else if (last && /^\s+\S/.test(line)) last.body = last.body ? `${last.body}\n${line.trim()}` : line.trim();
      else {
        last = null;
        other.push(line);
      }
    }
    // The section's prose and diagrams first, then its ARCH lines.
    const body = trimBlank(other);
    if (body.length) records.push({ kind: "adr", status: "done", owner: null, title: heading, body: body.join("\n"), section: heading, area: part.area });
    records.push(...archs);
  }
  return records;
}

/**
 * Section by section (product, tests): each heading with its text is one record;
 * a section that is only a table of contents (links) is left out.
 * @param {string} text @param {string} file @param {"pdr" | "test"} kind
 */
function parseSections(text, file, kind) {
  return sections(text).flatMap((part) => {
    const body = trimBlank(part.lines);
    const toc = body.length > 0 && body.every((l) => !l.trim() || /^\s*- \[[^\]]+\]\(#[^)]*\)\s*$/.test(l));
    if (toc || !body.length) return [];
    const title = part.heading || path.basename(file, ".md");
    return [{ kind, status: kind === "test" ? "open" : "done", owner: null, title, body: body.join("\n") || null, section: title, area: part.area }];
  });
}

/**
 * The repo's files, from the working tree or (rev) a git revision; paths relative to root.
 * @param {string} root @param {string} [rev]
 */
function filesAt(root, rev) {
  if (!rev) {
    return {
      /** @param {string} dir @param {boolean} [dirs] */
      list(dir, dirs = false) {
        // Followed like before: a symlinked task folder or file counts.
        const isDir = (/** @type {string} */ name) => {
          try {
            return fs.statSync(path.join(root, dir, name)).isDirectory();
          } catch {
            return undefined;
          }
        };
        try {
          return fs.readdirSync(path.join(root, dir)).filter((name) => {
            const d = isDir(name);
            return d !== undefined && d === dirs;
          });
        } catch {
          return [];
        }
      },
      /** @param {string} rel @returns {string | undefined} */
      read(rel) {
        try {
          return fs.readFileSync(path.join(root, rel), "utf8");
        } catch {
          return undefined;
        }
      },
    };
  }
  const git = (/** @type {string[]} */ args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
    } catch {
      return undefined;
    }
  };
  if (git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) === undefined) throw new Error(`Imprimatur: no git revision ${rev} in ${root}`);
  const posix = (/** @type {string} */ p) => p.split(path.sep).join("/");
  return {
    /** @param {string} dir @param {boolean} [dirs] */
    list(dir, dirs = false) {
      return (git(["ls-tree", rev, `${posix(dir)}/`]) ?? "").split("\n").flatMap((l) => {
        const m = /^\S+ (\S+) \S+\t(.*)$/.exec(l);
        return m && (m[1] === "tree") === dirs ? [path.posix.basename(m[2])] : [];
      });
    },
    /** @param {string} rel @returns {string | undefined} */
    read(rel) {
      return git(["show", `${rev}:${posix(rel)}`]);
    },
  };
}

/** Whether Imprimatur wrote the text (docs-export.js HEADER on its first line). @param {string | undefined} text */
const generated = (text) => text?.split("\n", 1)[0].replace(/\r$/, "") === require("./docs-export.js").HEADER;

/** @typedef {"todo" | "design" | "product" | "test" | "skip" | "generated"} SourceType */

/**
 * Every Markdown source of records in a repo, with what it holds and its text. "skip": a
 * file that holds no records (docs/design/README.md) although an older run read it;
 * "generated": a design document Imprimatur wrote from its sections (docs-sync.js adopted
 * the hand-written file, whose records stay as they are).
 * @param {string} root @param {{rev?: string}} [o]
 * @returns {{file: string, rel: string, text: string, type: SourceType, key: string}[]}
 */
function sources(root, { rev } = {}) {
  const at = filesAt(root, rev);
  /** @type {{file: string, rel: string, text: string, type: SourceType, key: string}[]} */
  const out = [];
  const add = (/** @type {string} */ rel, /** @type {SourceType} */ type, /** @type {string} */ key) => {
    const text = at.read(rel);
    if (text !== undefined) out.push({ file: path.join(root, rel), rel, text, type: generated(text) ? "generated" : type, key });
  };
  const md = (/** @type {string} */ dir) => at.list(dir).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(dir, f));
  const seen = new Set();
  for (const dir of TODO_DIRS) {
    for (const name of at.list(dir, true).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      // A task in both layouts (mid-move): the new one wins.
      if (seen.has(name)) continue;
      const before = out.length;
      add(path.join(dir, name, "TODO.md"), "todo", /^\d+$/.test(name) ? `#${name}` : name);
      if (out.length > before) seen.add(name);
    }
  }
  for (const rel of md(path.join("docs", "design"))) {
    const name = path.basename(rel).toUpperCase();
    if (name === "PRODUCT.MD") add(rel, "product", "PDR");
    else add(rel, name === "README.MD" ? "skip" : "design", "ADR");
  }
  for (const rel of ["PRODUCT.md", ...md(path.join("docs", "product"))]) add(rel, "product", "PDR");
  for (const rel of md(path.join("docs", "testing"))) add(rel, "test", "TEST");
  return out;
}

const SPECIAL = { ADR: "Mimari kararlar (ADR)", PDR: "Ürün kararları (PDR)", TEST: "Elle testler" };

/** The repo's origin remote, or undefined. @param {string} root */
function originOf(root) {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Imports a repo's Markdown records; safe to run again.
 * @param {any} db vscode/db.js handle
 * @param {string} root git root
 * @param {{dryRun?: boolean, origin?: string, rev?: string, only?: SourceType[]}} [o] rev: read the files
 * from this git revision; only: just these source types (a "skip" file is always handled)
 * @returns {{files: {file: string, records: number, added: number, updated: number, dropped: number, moved: number, unparsed: string[], expected: number, prefixed: number}[], total: number, added: number, updated: number, dropped: number, moved: number}}
 */
function importRepo(db, root, { dryRun = false, origin = originOf(root), rev, only } = {}) {
  const repo = dryRun ? { id: -1 } : db.repoOf(root, { origin });
  // uids name the repo by its remote, the same on every machine; its path otherwise.
  const repoKey = origin ?? root;
  const report = { files: /** @type {any[]} */ ([]), total: 0, added: 0, updated: 0, dropped: 0, moved: 0 };
  const pointers = [];
  /** @type {Map<number, number>} */
  const positions = new Map();
  for (const src of sources(root, { rev })) {
    const { text, rel } = src;
    if (src.type === "skip") {
      // Read by an older run (a README in docs/design, #73): its records go.
      const stale = dryRun ? [] : db.recordsFromSource(repo.id, rel).filter((/** @type {any} */ r) => r.status !== "dropped");
      for (const r of stale) db.updateRecord(r.id, { status: "dropped" }, ACTOR);
      if (stale.length) {
        report.files.push({ file: rel, records: 0, added: 0, updated: 0, dropped: stale.length, moved: 0, unparsed: [], expected: 0, prefixed: 0 });
        report.dropped += stale.length;
      }
      continue;
    }
    if (src.type === "generated" || (only && !only.includes(src.type))) continue;
    let parsed;
    if (src.type === "todo") parsed = parseTodo(text, src.key);
    else {
      const records = src.type === "design" ? parseDesign(text, rel) : parseSections(text, rel, src.type === "product" ? "pdr" : "test");
      parsed = { task: { key: src.key, title: SPECIAL[/** @type {keyof typeof SPECIAL} */ (src.key)], status: "open", summary: null }, records, unparsed: [], expected: 0 };
    }
    const entry = { file: rel, records: parsed.records.length, added: 0, updated: 0, dropped: 0, moved: 0, unparsed: parsed.unparsed, expected: 0, prefixed: 0 };
    if (src.type === "todo") {
      entry.expected = /** @type {any} */ (parsed).expected;
      entry.prefixed = parsed.records.filter((r) => !r.free).length;
    }
    report.files.push(entry);
    report.total += parsed.records.length;
    if (dryRun) continue;

    const { task: t } = parsed;
    const epicId = t.epic ? (db.taskByKey(repo.id, t.epic) ?? db.upsertTask(repo.id, t.epic, {}, ACTOR)).id : undefined;
    const task = db.upsertTask(repo.id, t.key, {
      ...(t.title && { title: t.title }), status: t.status, ...(t.summary != null && { summary: t.summary }), ...(epicId && { epicId }),
    }, ACTOR);
    // Same text twice in a file: the n-th copy gets its own uid.
    const count = new Map();
    const uidOf = (/** @type {any} */ r) => {
      const base = `${repoKey}\n${rel}\n${r.kind === "answer" ? "answer" : r.kind === "question" ? "question" : "x"}\n${r.section}\n${r.title}`;
      const n = (count.get(base) ?? 0) + 1;
      count.set(base, n);
      return `md:${hash(`${base}\n${n}`)}`;
    };
    const ids = new Map();
    // Records keep the file's order; files that share a task (ADR, TEST) follow each other.
    const seen = new Set();
    for (const r of parsed.records) {
      let uid = uidOf(r);
      // The record once moved to this task (below) has its own uid.
      const movedUid = `${uid}@${t.key}`;
      seen.add(uid).add(movedUid);
      const position = (positions.get(task.id) ?? 0) + 1;
      positions.set(task.id, position);
      // What Markdown says now; kept in links.md, so a later run applies only
      // what changed in Markdown and leaves changes made in the database.
      const md = { kind: r.kind, status: r.status, owner: r.owner, title: r.title || "(boş)", body: r.body, position, pointer: Boolean(r.pointer) };
      const where = { source: rel, ...(r.area !== undefined && { area: r.area }) };
      const parentId = r.answers ? ids.get(r.answers) ?? null : null;
      let old = db.recordByUid(movedUid) ?? db.recordByUid(uid);
      /** @type {any} */ let from;
      if (old && old.task_id !== task.id && old.links?.md?.kind && old.links.md.kind !== md.kind) {
        // An earlier run read the file as another kind, into another task (docs/design/PRODUCT.md
        // as ADRs, #73). A record moved by hand (or by a task merge) keeps its task.
        from = old;
        old = undefined;
        uid = movedUid;
      }
      let rec;
      if (!old) {
        const { pointer, ...fields } = md;
        // A moved record keeps what was done to it in the database.
        if (from && from.status !== "dropped") fields.status = from.status;
        rec = db.addRecord(task.id, { ...fields, parent_id: parentId, links: { ...where, md }, uid }, ACTOR);
        if (from) {
          if (from.status !== "dropped") db.updateRecord(from.id, { status: "dropped", links: { ...from.links, moved_to: rec.id } }, ACTOR);
          entry.moved++;
        } else entry.added++;
        if (pointer && rec.status === "open") pointers.push(rec.id);
      } else {
        const snap = old.links?.md;
        /** @type {Record<string, any>} */ const patch = {};
        for (const f of /** @type {const} */ (["kind", "status", "owner", "title", "body", "position"])) {
          if (!snap || JSON.stringify(snap[f] ?? null) !== JSON.stringify(md[f] ?? null)) patch[f] = md[f];
        }
        if (parentId && old.parent_id == null) patch.parent_id = parentId;
        const changed = Object.keys(patch).some((f) => JSON.stringify(old[f] ?? null) !== JSON.stringify(patch[f] ?? null));
        rec = db.updateRecord(old.id, { ...patch, links: { ...old.links, ...where, md } }, ACTOR);
        if (changed) entry.updated++;
        // The 👉 follows Markdown only when Markdown moved it.
        if (md.pointer && !snap?.pointer && rec.status === "open") pointers.push(rec.id);
        if (!md.pointer && snap?.pointer && rec.pointer) db.clearPointer(rec.id, ACTOR);
      }
      ids.set(r, rec.id);
    }
    // Gone from Markdown (removed, or reworded: its text is in its uid): dropped, never deleted.
    // Not when reading an older revision: what was added since is not gone.
    for (const gone of rev ? [] : db.recordsFromSource(repo.id, rel)) {
      if (seen.has(gone.uid) || gone.status === "dropped") continue;
      db.updateRecord(gone.id, { status: "dropped" }, ACTOR);
      entry.dropped++;
    }
    report.added += entry.added;
    report.updated += entry.updated;
    report.dropped += entry.dropped;
    report.moved += entry.moved;
  }
  for (const id of pointers) db.setPointer(id, ACTOR);
  return report;
}

/** One line for a report. @param {ReturnType<typeof importRepo>} r */
function summary(r) {
  const unparsed = r.files.reduce((n, f) => n + f.unparsed.length, 0);
  const off = r.files.filter((f) => f.expected !== f.prefixed).map((f) => `${f.file} ${f.prefixed}/${f.expected}`);
  return `${r.total} records (${r.added} new, ${r.updated} updated${r.moved ? `, ${r.moved} moved to their task` : ""}, ${r.dropped} gone from Markdown → dropped) from ${r.files.length} files; ${unparsed} lines kept as notes; ${off.length ? `count off: ${off.join(", ")}` : "counts match"}`;
}

module.exports = { summary, importRepo, originOf, parseTodo, parseDesign, parseSections, sections, fenceTracker, filesAt, sources, taskStatus, ACTOR };
