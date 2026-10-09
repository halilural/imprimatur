// @ts-check
// Task records for the rest of the extension and the hooks (#60): one database
// connection per process (vscode/db.js), opened on first use. Everything that
// used to read TODO.md files asks here: a task's title, which tasks a session
// worked on, which tasks are done, the user's open records, Jira addresses.
// Without a database (node:sqlite missing, file unreadable) every answer is
// empty and the reason is kept in `lastError`.
"use strict";
const fs = require("node:fs");

/** @type {any} */
let db;
/** The open file's inode: a file replaced or deleted under us means open again. */
let ino = 0;
/** @type {string | undefined} */
let lastError;
/** A failed open is not retried for this long (each try can wait out a lock, 5 s). */
const RETRY_MS = 10_000;
let failedAt = 0;

/** @param {string} file */
const inodeOf = (file) => {
  try {
    return fs.statSync(file).ino;
  } catch {
    return 0;
  }
};

/** How long an open waits on a lock (the status line wants it short). */
let busyMs = 5000;
/** @param {{busyMs?: number}} o */
function configure(o) {
  if (o.busyMs !== undefined) busyMs = o.busyMs;
}

/** The process's connection, or undefined when it cannot open. */
function dbOf() {
  if (db) return db;
  if (Date.now() - failedAt < RETRY_MS) return undefined;
  try {
    db = require("./db.js").openDb({ busyMs });
    ino = inodeOf(db.file);
    lastError = undefined;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    failedAt = Date.now();
  }
  return db;
}

/** The database file was replaced or deleted (a restore): forget the connection. @returns {boolean} whether it was */
function checkFile() {
  if (!db || inodeOf(db.file) === ino) return false;
  reset();
  return true;
}

/** Tests and a changed IMPRIMATUR_DB: the next call opens again. */
function reset() {
  try {
    db?.close();
  } catch {}
  db = undefined;
  failedAt = 0;
}

/** The repo's id, if the database knows the repo; a root spelled otherwise (symlink, case) by its real path. @param {string} root */
function repoId(root) {
  const d = dbOf();
  if (!d) return undefined;
  const found = d.repoByRoot(root);
  if (found) return found.id;
  try {
    const real = fs.realpathSync(root);
    if (real !== root) return d.repoByRoot(real)?.id;
  } catch {}
  return undefined;
}

/** @param {string} root @param {string} key @returns {any} */
function task(root, key) {
  const id = repoId(root);
  return id === undefined ? undefined : db.taskByKey(id, key);
}

/** A task's title, if it has one. @param {string} root @param {string} key */
function taskTitle(root, key) {
  return task(root, key)?.title || undefined;
}

/** session → task keys it wrote records of, newest last. @param {string} root @returns {Map<string, string[]>} */
function sessionTasks(root) {
  const id = repoId(root);
  return id === undefined ? new Map() : db.sessionTasks(id);
}

/** Done tasks: key → when they last changed (ms). @param {string} root @returns {Map<string, number>} */
function doneTasks(root) {
  const id = repoId(root);
  return id === undefined ? new Map() : db.doneTasks(id);
}

/**
 * The user's open records (owner K, todo or question) with their task key.
 * @param {string} root @returns {Array<{id: number, task_key: string, kind: string, title: string, created_at: number}>}
 */
function userAsks(root) {
  const id = repoId(root);
  return id === undefined ? [] : db.openAsks({ repoId: id, limit: 500 });
}

/** A task's records in order. @param {string} root @param {string} key */
function recordsOf(root, key) {
  const t = task(root, key);
  return t ? db.recordsOf(t.id) : [];
}

/**
 * Where a Jira project's pages live, from links in the repo's records
 * (…/browse/LATD-123): LATD-13931 gets one without a record of its own.
 * @param {string} root @param {string} key
 */
function jiraLink(root, key) {
  const id = repoId(root);
  if (id === undefined) return undefined;
  const project = key.split("-")[0];
  for (const r of db.search(`/browse/${project}-`, { repoId: id, limit: 5 })) {
    const m = new RegExp(`(https?://[^\\s)\\]"]+/browse/)${project}-\\d+`).exec(`${r.title}\n${r.body ?? ""}\n${JSON.stringify(r.links ?? "")}`);
    if (m) return `${m[1]}${key}`;
  }
  return undefined;
}

/** Agents' record changes in the repo, newest first. @param {string} root */
function agentChanges(root) {
  const id = repoId(root);
  return id === undefined ? [] : db.agentChanges(id);
}

module.exports = {
  agentChanges, checkFile, configure, dbOf, reset, repoId, task, taskTitle, sessionTasks, doneTasks, userAsks, recordsOf, jiraLink,
  get lastError() {
    return lastError;
  },
};
