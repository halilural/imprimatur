// @ts-check
// The panel's input stamp (#115): a cheap string that changes whenever what the page
// is built from may have changed. Equal stamps mean an equal page, so refresh() skips
// the build (30-180 ms) and the post. The files part is a stat of every file in the repo's
// data folder (data-dir.js, #126) (archive/, docs-backup/ and pending/ aside: no page reads them), plus each
// file under review in the repo (its text on disk decides accepted and gone), plus the
// repo's .claude/imprimatur.json. No file is read.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DATA = path.join(".claude", "imprimatur");
const SKIP = new Set(["archive", "docs-backup", "pending"]);
const HISTORY = "history";

/** @param {string} file */
const statOf = (file) => {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
};

/**
 * Every file under dir, as "rel=size:mtime" lines; nested folders too.
 * @param {string} dir @param {string} rel @param {string[]} out @param {(rel: string) => void} [onHistory]
 */
function walk(dir, rel, out, onHistory) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (!rel && SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, r, out, onHistory);
    else {
      out.push(`${r}=${statOf(abs)}`);
      if (onHistory && r.startsWith(HISTORY + path.sep) && r.endsWith(".jsonl")) onHistory(r.slice(HISTORY.length + 1, -".jsonl".length));
    }
  }
}

/**
 * The files part of the stamp for one repo.
 * @param {string} root
 */
function dataStamp(root) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const reviewed = [];
  walk(require("./data-dir.js").dataDir(root), "", out, (rel) => reviewed.push(rel));
  for (const rel of reviewed) out.push(`@${rel}=${statOf(path.join(root, rel))}`);
  out.push(`cfg=${statOf(path.join(root, ".claude", "imprimatur.json"))}`);
  return out.join("\n");
}

/**
 * The whole stamp: the page's inputs that are not files. A part that throws makes
 * the stamp undefined (build the page, as before).
 * @param {string} root
 * @param {{view: any, db?: any, error?: unknown, docs?: string, now?: number}} o
 * @returns {string | undefined}
 */
function panelStamp(root, { view, db, error, docs = "", now = Date.now() }) {
  try {
    return [JSON.stringify(view), db?.changeStamp?.() ?? "-", error ? String(error) : "", docs, Math.floor(now / 60_000), dataStamp(root)].join("\n");
  } catch {
    return undefined;
  }
}

/** Tabs whose page reads only the database and the data folder: the stamp covers them. */
const STAMPED_TABS = new Set(["home", "tasks", "inbox", "edits", "exercises", "architecture", "product", "glossary"]);

module.exports = { dataStamp, panelStamp, STAMPED_TABS };
