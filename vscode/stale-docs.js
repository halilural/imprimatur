// @ts-check
// Possibly stale documents (#211): a document part tied to files is flagged when one of those
// files changed in a commit after the part was last written, or after it was last marked
// reviewed. Parts: ADRs and decisions (their links.files), and current document sections (the
// files of their contributing records, and repo paths in backticks in their body). No model
// call; one `git log` per repo, cached by HEAD. A part tied to nothing is never flagged.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** How far back a commit list goes at most: older parts are checked against this window. */
const MAX_COMMITS = 2000;
/** Paths in backticks that look like repo files or folders: a slash or a file extension. */
const PATH_RE = /`([\w.@-]+(?:\/[\w.@-]+)*\/?)`/g;
const reviewKey = (/** @type {string} */ uid) => `stale-ok:${uid}`;
/**
 * Paths that change in nearly every commit (version bumps, the changelog, lockfiles) or only
 * check the code (tests): a document describes neither, so they tie nothing.
 */
const INCIDENTAL = /(^|\/)(package(-lock)?\.json|plugin\.json|marketplace\.json|CHANGELOG\.md|pnpm-lock\.yaml|yarn\.lock)$|^test\/|(^|\/)tests?\/|\.test\.[cm]?[jt]s$/;
const tiesTo = (/** @type {string[]} */ files) => files.filter((f) => !INCIDENTAL.test(f));

/** @type {Map<string, {head: string, commits: Commit[]}>} */
const cache = new Map();
/** @typedef {{hash: string, at: number, subject: string, files: string[]}} Commit */

/** The repo's commits, newest first, with the files each touched (renames: both paths). @param {string} root @returns {Commit[]} */
function commitsOf(root) {
  const git = (/** @type {string[]} */ args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  let head;
  try {
    head = git(["rev-parse", "HEAD"]).trim();
  } catch {
    return [];
  }
  const hit = cache.get(root);
  if (hit?.head === head) return hit.commits;
  /** @type {Commit[]} */
  const commits = [];
  try {
    const log = git(["log", "--no-merges", "-n", String(MAX_COMMITS), "--name-status", "--format=%x1e%H%x09%ct%x09%s"]);
    for (const chunk of log.split("\x1e").slice(1)) {
      const [first, ...rest] = chunk.split("\n");
      const [hash, ct, ...subject] = first.split("\t");
      // "M\tpath", "D\tpath", "R100\told\tnew": every path named counts as touched.
      const files = rest.filter(Boolean).flatMap((l) => l.split("\t").slice(1));
      commits.push({ hash: hash.slice(0, 10), at: Number(ct) * 1000, subject: subject.join("\t"), files });
    }
  } catch {
    return [];
  }
  cache.set(root, { head, commits });
  return commits;
}

/** Repo paths in backticks in a text that exist in the repo. @param {string} text @param {string} root */
function pathsIn(text, root) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(PATH_RE)) {
    const p = m[1];
    if (!p.includes("/") && !/\.\w+$/.test(p)) continue;
    if (p.startsWith("/") || p.includes("..")) continue;
    // A top-level folder ("vscode/") is the whole program: it ties nothing in particular.
    if (p.replace(/\/$/, "").split("/").length < 2 && p.endsWith("/")) continue;
    if (fs.existsSync(path.join(root, p))) out.add(p);
  }
  return [...out];
}

/** Does a commit's file fall under a tied path (a file, or a folder ending in "/" or existing as one)? */
const touches = (/** @type {string} */ file, /** @type {string} */ tied) => file === tied || file.startsWith(tied.endsWith("/") ? tied : `${tied}/`);

/**
 * The repo's possibly stale parts: each with the commits and files that changed since it was
 * last written (or reviewed), newest commit first.
 * @param {any} db @param {any} repo @param {string} root
 * @returns {Array<{key: string, kind: string, id: number, title: string, task?: string, doc?: string, files: string[], commits: Array<{hash: string, at: number, subject: string, files: string[]}>}>}
 */
function staleParts(db, repo, root) {
  /** @type {Array<{key: string, kind: string, id: number, title: string, task?: string, doc?: string, since: number, tied: string[]}>} */
  const parts = [];
  const recs = db.q(`SELECT r.id, r.uid, r.kind, r.title, r.links, r.updated_at, t.key AS task FROM records r JOIN tasks t ON t.id = r.task_id
    WHERE t.repo_id = ? AND r.kind IN ('adr', 'decision') AND r.status <> 'dropped' AND r.links LIKE '%"files"%'`).all(repo.id);
  /** @type {Map<number, string[]>} */
  const filesOf = new Map();
  for (const r of recs) {
    let files = [];
    try {
      files = (JSON.parse(r.links ?? "{}").files ?? []).filter((/** @type {unknown} */ f) => typeof f === "string" && f && !f.startsWith("/"));
    } catch {}
    files = tiesTo(files);
    filesOf.set(r.id, files);
    if (files.length) parts.push({ key: r.uid, kind: r.kind, id: r.id, title: r.title, task: r.task, since: r.updated_at, tied: files });
  }
  const secs = db.q(`SELECT s.id, s.uid, s.title, s.body, s.updated_at, d.kind AS doc, d.scope FROM doc_sections s JOIN documents d ON d.id = s.doc_id
    WHERE d.repo_id = ? AND s.status = 'current'`).all(repo.id);
  for (const s of secs) {
    const viaRecs = db.q("SELECT record_id FROM doc_section_records WHERE section_id = ?").all(s.id).flatMap((/** @type {any} */ x) => filesOf.get(x.record_id) ?? []);
    const tied = tiesTo([...new Set([...viaRecs, ...pathsIn(s.body, root)])]);
    if (tied.length) parts.push({ key: s.uid, kind: "section", id: s.id, title: s.title, task: s.scope || undefined, doc: s.doc, since: s.updated_at, tied });
  }
  if (!parts.length) return [];
  const commits = commitsOf(root);
  const out = [];
  for (const p of parts) {
    const reviewed = Number(db.meta(reviewKey(p.key)) ?? 0);
    const since = Math.max(p.since, reviewed);
    const hits = [];
    for (const c of commits) {
      if (c.at <= since) continue; // commit times are not strictly ordered (rebases): check all
      const files = c.files.filter((f) => !INCIDENTAL.test(f) && p.tied.some((t) => touches(f, t)));
      if (files.length) hits.push({ hash: c.hash, at: c.at, subject: c.subject, files });
    }
    if (hits.length) {
      const { since: _s, tied, ...rest } = p;
      out.push({ ...rest, files: [...new Set(hits.flatMap((h) => h.files))], commits: hits });
    }
  }
  return out.sort((a, b) => b.commits[0].at - a.commits[0].at);
}

/** Marks a part reviewed now: only commits after this count again. @param {any} db @param {string} uid @param {number} [now] */
function markReviewed(db, uid, now = Date.now()) {
  db.setMeta(reviewKey(uid), String(now));
}

module.exports = { staleParts, markReviewed, pathsIn, commitsOf };
