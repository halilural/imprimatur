// @ts-check
// "Imprimatur: Go to Task" (#160): every repo's tasks as quick-pick rows, so typing "#817"
// (or "817", or words of the title) and Enter opens the task on the Tasks tab, the way the
// GitHub panel opens an issue. Pure: recordsView.js shows the rows.
"use strict";

const ORDER = { active: 0, open: 1, done: 2, dropped: 3 };

/**
 * The rows: this window's repos first, then the others; within a repo active and open tasks
 * before done and dropped ones, most recently changed first. The label carries the key, so
 * "#817" and "817" both match it.
 * @param {{id: number, name: string, root: string}[]} repos
 * @param {(repoId: number) => {key: string, title: string, status: string, updated_at: number}[]} tasksOf
 * @param {string[]} here the roots of this window's folders
 */
function taskRows(repos, tasksOf, here) {
  const mine = new Set(here);
  const ordered = [...repos.filter((r) => mine.has(r.root)), ...repos.filter((r) => !mine.has(r.root))];
  return ordered.flatMap((repo) =>
    tasksOf(repo.id)
      .slice()
      .sort((a, b) => (ORDER[/** @type {keyof ORDER} */ (a.status)] ?? 9) - (ORDER[/** @type {keyof ORDER} */ (b.status)] ?? 9) || b.updated_at - a.updated_at)
      .map((t) => ({
        label: `${t.key}  ${t.title}`,
        description: `${repo.name} · ${t.status}`,
        key: t.key,
        root: repo.root,
        issue: /^#(\d+)$/.exec(t.key)?.[1] ?? null,
      }))
  );
}

/** The issue's web page from a git remote URL (https or ssh), or null. @param {string} remote @param {string} n */
function issueUrl(remote, n) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}/issues/${n}` : null;
}

module.exports = { taskRows, issueUrl };
