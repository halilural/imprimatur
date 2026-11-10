// @ts-check
// Ranked search over a repo's records and document sections (#189), for the Cmd+K box and MCP.
// node:sqlite has no FTS5, so the ranking is BM25 in JavaScript over an index kept in memory and
// rebuilt when the data changes; Turkish letters fold (İ/ı/ç/ğ/ö/ş/ü match i/c/g/o/s/u), the last
// word of the query matches as a prefix (typing), and a hit carries a snippet around the match.
"use strict";

/** Lowercase in Turkish, accents off, ı as i: the same length as the input, so offsets map back. @param {unknown} s */
const fold = (s) => String(s ?? "").toLocaleLowerCase("tr").replace(/[^\x00-\x7f]/g, (c) => c.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").slice(0, 1) || c);
/** @param {unknown} s @returns {string[]} */
const tokens = (s) => fold(s).match(/[a-z0-9]+/g) ?? [];

/** Per database connection, per repo ("*" for all): the index and the data signature it was built at. @type {WeakMap<object, Map<string, {sig: string, index: any}>>} */
const caches = new WeakMap();

/**
 * The items of the index: records and current document sections, one repo or every repo.
 * @param {any} db @param {number | undefined} repoId
 */
function itemsOf(db, repoId) {
  const recs = db.q(`SELECT r.id, r.kind, r.status, r.title, r.body, r.updated_at, t.key AS task_key, t.repo_id FROM records r JOIN tasks t ON t.id = r.task_id
                     WHERE r.status <> 'dropped' AND ($repo IS NULL OR t.repo_id = $repo)`).all({ repo: repoId ?? null })
    .map((/** @type {any} */ r) => ({ type: "record", ...r }));
  const secs = db.q(`SELECT s.id, s.key, s.title, s.body, s.updated_at, d.kind AS doc_kind, d.scope, d.repo_id FROM doc_sections s JOIN documents d ON d.id = s.doc_id
                     WHERE s.status = 'current' AND ($repo IS NULL OR d.repo_id = $repo)`).all({ repo: repoId ?? null })
    .map((/** @type {any} */ s) => ({ type: "section", ...s }));
  const repos = db.q("SELECT id, root FROM repos WHERE $repo IS NULL OR id = $repo").all({ repo: repoId ?? null });
  return [...recs, ...secs, ...repos.flatMap((/** @type {any} */ r) => filesOf(r).items)];
}

/** Per repo root: its hand-written documents' chunks and the signature they were read at, for FILE_TTL. @type {Map<string, {at: number, sig: string, items: any[]}>} */
const fileCache = new Map();
const FILE_TTL = 30_000;

/**
 * A repo's hand-written documents, kept or not yet adopted (#206), cut at their headings (to ###):
 * found where they are, never copied into the database. Read again when one changed, at most every FILE_TTL.
 * @param {{id: number, root: string}} repo @returns {{sig: string, items: any[]}}
 */
function filesOf(repo, now = Date.now()) {
  const hit = fileCache.get(repo.root);
  if (hit && now - hit.at < FILE_TTL) return hit;
  /** @type {Array<{file: string, rel: string, mtime: number}>} */
  let files = [];
  try {
    const fs = require("node:fs");
    if (fs.existsSync(repo.root))
      files = require("./doc-rules.js").handWrittenDocs(repo.root, require("./docs-export.js").dirOf(repo.root), { kept: true })
        .map((/** @type {any} */ f) => ({ ...f, mtime: fs.statSync(f.file).mtimeMs }));
  } catch {}
  const sig = files.map((f) => `${f.rel}:${f.mtime}`).join("|");
  if (hit?.sig === sig) return fileCache.set(repo.root, { ...hit, at: now }).get(repo.root);
  const items = files.flatMap((f) => chunks(require("node:fs").readFileSync(f.file, "utf8")).map((c) => ({
    type: "file", id: `${f.rel}:${c.line}`, title: c.heading ? `${f.rel} › ${c.heading}` : f.rel, body: c.text,
    updated_at: f.mtime, repo_id: repo.id, rel: f.rel, file: f.file, line: c.line,
  })));
  const out = { at: now, sig, items };
  fileCache.set(repo.root, out);
  return out;
}

/** A Markdown text cut at its headings (# to ###), each part with its first line. @param {string} text */
function chunks(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  /** @type {Array<{heading: string, line: number, text: string}>} */
  const out = [];
  let cur = { heading: "", line: 1, lines: /** @type {string[]} */ ([]) };
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^#{1,3}\s+(.+)/.exec(l);
    if (h && cur.lines.some((x) => x.trim())) {
      out.push({ heading: cur.heading, line: cur.line, text: cur.lines.join("\n") });
      cur = { heading: h[1].trim(), line: i + 1, lines: [] };
    } else if (h) cur = { heading: h[1].trim(), line: i + 1, lines: [] };
    else cur.lines.push(l);
  });
  if (cur.lines.some((x) => x.trim()) || cur.heading) out.push({ heading: cur.heading, line: cur.line, text: cur.lines.join("\n") });
  return out;
}

/** The index for a repo (or all), rebuilt when a record or section changed. @param {any} db @param {number | undefined} repoId */
function indexOf(db, repoId) {
  const files = db.q("SELECT id, root FROM repos WHERE $repo IS NULL OR id = $repo").all({ repo: repoId ?? null }).map((/** @type {any} */ r) => filesOf(r).sig).join("#");
  const sig = JSON.stringify(db.q(`SELECT (SELECT max(updated_at) FROM records) a, (SELECT count(*) FROM records) b,
                                          (SELECT max(updated_at) FROM doc_sections) c, (SELECT count(*) FROM doc_sections) d`).get()) + files;
  const key = String(repoId ?? "*");
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  const hit = cache.get(key);
  if (hit?.sig === sig) return hit.index;
  const items = itemsOf(db, repoId);
  /** @type {Map<string, number>} */ const df = new Map();
  let total = 0;
  const docs = items.map((it) => {
    // The title counts twice: a word in it says more than one in a body.
    const toks = [...tokens(it.title), ...tokens(it.title), ...tokens(it.body)];
    /** @type {Map<string, number>} */ const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    total += toks.length;
    return { it, tf, len: toks.length };
  });
  const index = { docs, df, avg: total / Math.max(1, docs.length), vocab: [...df.keys()] };
  cache.set(key, { sig, index });
  return index;
}

/** A line of text around the first match, at most 160 characters. @param {string} text @param {string[]} terms */
function snippet(text, terms) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  const f = fold(s);
  const at = Math.min(...terms.map((t) => f.search(new RegExp(`\\b${t}`))).filter((i) => i >= 0), Infinity);
  if (at === Infinity) return s.slice(0, 160);
  const from = Math.max(0, at - 60);
  return `${from ? "…" : ""}${s.slice(from, from + 160)}${from + 160 < s.length ? "…" : ""}`;
}

/**
 * Items ranked by BM25 for the query; the last word also matches words it starts.
 * @param {any} db @param {string} query @param {{repoId?: number, limit?: number, type?: "record" | "section" | "file"}} [o]
 * @returns {Array<any>} the items with score and snippet
 */
function rankedSearch(db, query, { repoId, limit = 20, type } = {}) {
  const words = tokens(query);
  if (!words.length) return [];
  const index = indexOf(db, repoId);
  const last = words[words.length - 1];
  // Each query word as the index's words it stands for: itself, and for the last one, those it starts.
  const groups = words.map((w, i) => (i === words.length - 1 && w.length >= 2 ? index.vocab.filter((/** @type {string} */ v) => v.startsWith(last)).slice(0, 50) : index.df.has(w) ? [w] : []));
  const N = index.docs.length;
  const k1 = 1.2, b = 0.75;
  const out = [];
  for (const d of index.docs) {
    if (type && d.it.type !== type) continue;
    let score = 0;
    let all = true;
    for (const g of groups) {
      let best = 0;
      for (const t of g) {
        const tf = d.tf.get(t);
        if (!tf) continue;
        const n = index.df.get(t);
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        best = Math.max(best, (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / index.avg)));
      }
      if (!best) all = false;
      score += best;
    }
    // Every word must be there: a search narrows as you type.
    if (all && score > 0) out.push({ ...d.it, score });
  }
  // Equal scores: the newer first.
  out.sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
  const terms = groups.flat();
  return out.slice(0, limit).map((h) => ({ ...h, snippet: snippet(`${h.title} ${h.body ?? ""}`, terms.length ? terms : words) }));
}

/**
 * The prompt that answers a question from the hits only, each claim citing [n].
 * @param {string} question @param {any[]} hits
 */
function askPrompt(question, hits) {
  const src = hits.map((h, i) => `[${i + 1}] ${sourceOf(h)}: ${h.title}\n${String(h.body ?? "").slice(0, 1500)}`).join("\n\n");
  return `Answer the question from these sources only. Cite each claim with its number in brackets, like [2]. If the sources do not answer it, say so in one line. Be brief: at most eight sentences.\n\nQuestion: ${question}\n\nSources:\n${src}`;
}

/** Where a hit is from, one short label: "#58 decision", "capability search", "docs/jira.md:12". @param {any} h */
const sourceOf = (h) => (h.type === "record" ? `${h.task_key} ${h.kind}` : h.type === "file" ? `${h.rel}:${h.line}` : `${h.doc_kind}${h.scope ? ` ${h.scope}` : ""}`);

module.exports = { rankedSearch, askPrompt, sourceOf, chunks, filesOf, fold, tokens, snippet };
