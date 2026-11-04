// @ts-check
"use strict";

const MAX = 30;

/**
 * The tasks a "#…" search asks for (#154): digits match the issue number (exact first, then
 * numbers that start with them), words match the title. Only GitHub issues (#n).
 * @param {{key: string, title: string, status: string}[]} tasks @param {string} query
 */
function issueMatches(tasks, query) {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  if (!q) return [];
  const issues = tasks.filter((t) => /^#\d+$/.test(t.key));
  if (/^\d+$/.test(q))
    return issues.filter((t) => t.key.slice(1).startsWith(q)).sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key)).slice(0, MAX);
  const words = q.split(/\s+/);
  return issues.filter((t) => words.every((w) => t.title.toLowerCase().includes(w))).slice(0, MAX);
}

module.exports = { issueMatches };
