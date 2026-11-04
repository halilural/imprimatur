// @ts-check
// Version history of third-party items (#140): each installed plugin's version and each
// hand-installed skill's source commit, with the day it was first seen, kept in one JSON file
// in the extension's storage. The lock of record is Claude Code's own (installed_plugins.json,
// SOURCE.txt); this keeps what they were before, which neither does. No revert: Claude Code
// has no command to install an older version (decision 9370).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Versions kept per item. */
const KEEP = 20;

/** @param {string} file @returns {Record<string, {value: string, since: string}[]>} */
function readVersions(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {
    return {};
  }
}

/**
 * Adds a version for each item whose current one differs from the last kept, and writes the
 * file when something was added. The first sighting is dated with the item's own install day
 * when it has one. @param {string} file
 * @param {{key: string, value: string, since?: string}[]} items @param {string} today YYYY-MM-DD
 */
function recordVersions(file, items, today) {
  const h = readVersions(file);
  let added = false;
  for (const it of items) {
    if (!it.value) continue;
    const list = h[it.key] ?? [];
    if (list.at(-1)?.value === it.value) continue;
    list.push({ value: it.value, since: list.length ? today : it.since || today });
    h[it.key] = list.slice(-KEEP);
    added = true;
  }
  if (added) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(h, null, 1));
  }
  return h;
}

/** "versions: 4.10.0 (2026-09-30) → 5.3.3 (2026-11-04)", the last four; "" with one. @param {{value: string, since: string}[] | undefined} list */
const versionLine = (list) => (list && list.length > 1 ? `versions: ${list.slice(-4).map((v) => `${v.value.slice(0, 12)} (${v.since})`).join(" → ")}` : "");

module.exports = { readVersions, recordVersions, versionLine };
