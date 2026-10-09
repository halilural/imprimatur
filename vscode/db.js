// @ts-check
// Imprimatur's own database (#57): the source of truth for tasks and their
// records (todos, questions, answers, decisions, notes, ADRs, PDRs). One file
// per device, shared by every repo, opened by the extension (one long-lived
// connection), the hooks (one short connection per process) and the MCP server.
// - node:sqlite, no native module. Missing node:sqlite is an error, not a
//   silent fallback.
// - WAL + busy_timeout; every write is a short BEGIN IMMEDIATE transaction that
//   writes the record and its version row together.
// - Records are never deleted (status "dropped"): the version history stays.
// - Schema version is PRAGMA user_version; MIGRATIONS run in order. A database
//   newer than this code is read-only here.
// All SQL lives in this file.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KINDS = ["todo", "question", "answer", "decision", "note", "fixme", "adr", "pdr", "test"];
const ACTORS = ["agent", "user", "hook", "import"];

/** Each entry takes the schema from version i to i + 1. */
const MIGRATIONS = [
  `
  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    root TEXT NOT NULL UNIQUE,
    origin TEXT,
    name TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    key TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'active', 'done', 'dropped')),
    epic_id INTEGER REFERENCES tasks(id),
    summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (repo_id, key)
  );
  CREATE INDEX tasks_repo_status ON tasks(repo_id, status);
  CREATE TABLE records (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN (${KINDS.map((k) => `'${k}'`).join(", ")})),
    owner TEXT CHECK (owner IN ('C', 'K')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
    pointer INTEGER NOT NULL DEFAULT 0 CHECK (pointer IN (0, 1)),
    title TEXT NOT NULL,
    body TEXT,
    position REAL NOT NULL,
    parent_id INTEGER REFERENCES records(id),
    links TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX records_task_position ON records(task_id, position);
  CREATE INDEX records_open ON records(owner, created_at) WHERE status = 'open';
  CREATE UNIQUE INDEX records_one_pointer ON records(task_id) WHERE pointer = 1;
  CREATE TABLE record_versions (
    id INTEGER PRIMARY KEY,
    record_id INTEGER NOT NULL REFERENCES records(id),
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN (${ACTORS.map((k) => `'${k}'`).join(", ")})),
    actor TEXT,
    op TEXT NOT NULL CHECK (op IN ('create', 'update')),
    before TEXT,
    after TEXT
  );
  CREATE INDEX record_versions_record ON record_versions(record_id, at);
  `,
];
const VERSION = MIGRATIONS.length;

/** Record fields a caller may set; the rest are the database's. */
const EDITABLE = ["kind", "owner", "status", "title", "body", "position", "parent_id", "links"];

/** The device's database path: IMPRIMATUR_DB, else the platform's data folder. */
function dbPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.IMPRIMATUR_DB) return env.IMPRIMATUR_DB;
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "imprimatur", "imprimatur.db");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "imprimatur", "imprimatur.db");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "imprimatur", "imprimatur.db");
}

/** WAL's shared memory breaks across the WSL/Windows boundary: no db on /mnt/<drive>. */
function onWindowsDrive(file, platform = process.platform) {
  return platform === "linux" && /^\/mnt\/[a-z]\//i.test(path.resolve(file));
}

/** node:sqlite without its "experimental" warning (hooks write stderr to the user). */
function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = /** @type {any} */ (
    function (/** @type {any} */ w, /** @type {any[]} */ ...rest) {
      if (/SQLite/i.test(String(typeof w === "string" ? w : w?.message))) return;
      return emit.call(process, w, ...rest);
    }
  );
  try {
    return require("node:sqlite");
  } catch (e) {
    throw new Error(`Imprimatur needs node:sqlite (Node >= 22.13); this is Node ${process.versions.node}: ${/** @type {Error} */ (e).message}`);
  } finally {
    process.emitWarning = emit;
  }
}

const uid = () => crypto.randomUUID();
const json = (v) => (v == null ? null : JSON.stringify(v));

/** @param {any} r */
function recordOf(r) {
  if (!r) return undefined;
  r.pointer = r.pointer === 1;
  r.links = r.links ? JSON.parse(r.links) : null;
  return r;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Switches a new database to WAL. The first switch needs an exclusive lock and
 * SQLite answers SQLITE_BUSY at once (busy_timeout does not apply): retry for 5 s.
 * @param {any} s
 */
function toWal(s) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if (s.prepare("PRAGMA journal_mode").get().journal_mode === "wal") return;
      s.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e) {
      if (!/locked|busy/i.test(/** @type {Error} */ (e).message) || Date.now() > deadline) throw e;
      sleep(10 + Math.random() * 20);
    }
  }
}

/**
 * @typedef {{kind: "agent" | "user" | "hook" | "import", id?: string}} Actor
 */

class Db {
  /** @param {any} sqlite @param {string} file */
  constructor(sqlite, file) {
    this.sqlite = sqlite;
    this.file = file;
    /** @type {Map<string, any>} */
    this.statements = new Map();
    this.version = 0;
  }

  /** A prepared statement, cached per connection. @param {string} sql */
  q(sql) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.sqlite.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  close() {
    this.statements.clear();
    this.sqlite.close();
  }

  /** Runs fn in a write transaction; the lock is taken up front. @template T @param {() => T} fn @returns {T} */
  tx(fn) {
    if (this.version > VERSION) {
      throw new Error(`Imprimatur database ${this.file} is schema ${this.version}, newer than this code (${VERSION}): read-only`);
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      // SQLite may have rolled back already (IOERR, FULL): keep the real error.
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  /** The repo row for a root, created on first sight. @param {string} root @param {{origin?: string, name?: string}} [info] */
  repoOf(root, info = {}) {
    const found = this.q("SELECT * FROM repos WHERE root = ?").get(root);
    if (found) return found;
    return this.tx(() => {
      this.q("INSERT OR IGNORE INTO repos (uid, root, origin, name, created_at) VALUES (?, ?, ?, ?, ?)").run(
        uid(), root, info.origin ?? null, info.name ?? path.basename(root), Date.now(),
      );
      return this.q("SELECT * FROM repos WHERE root = ?").get(root);
    });
  }

  /**
   * Creates the task or updates the given fields.
   * @param {number} repoId @param {string} key
   * @param {{title?: string, status?: string, epicId?: number | null, summary?: string | null}} [fields]
   */
  upsertTask(repoId, key, fields = {}) {
    return this.tx(() => {
      const now = Date.now();
      this.q(`INSERT INTO tasks (uid, repo_id, key, title, status, epic_id, summary, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (repo_id, key) DO UPDATE SET
                title = coalesce(?, title), status = coalesce(?, status),
                epic_id = CASE WHEN ? THEN ? ELSE epic_id END,
                summary = CASE WHEN ? THEN ? ELSE summary END, updated_at = ?`).run(
        uid(), repoId, key, fields.title ?? "", fields.status ?? "open", fields.epicId ?? null, fields.summary ?? null, now, now,
        fields.title ?? null, fields.status ?? null,
        "epicId" in fields ? 1 : 0, fields.epicId ?? null,
        "summary" in fields ? 1 : 0, fields.summary ?? null, now,
      );
      return this.q("SELECT * FROM tasks WHERE repo_id = ? AND key = ?").get(repoId, key);
    });
  }

  /** @param {string} u */
  recordByUid(u) {
    return recordOf(this.q("SELECT * FROM records WHERE uid = ?").get(u));
  }

  /** @param {number} id */
  record(id) {
    return recordOf(this.q("SELECT * FROM records WHERE id = ?").get(id));
  }

  /**
   * Adds a record at the end of its task (or at `position`).
   * @param {number} taskId
   * @param {{kind: string, title: string, owner?: string | null, status?: string, body?: string | null,
   *   position?: number, parent_id?: number | null, links?: any, pointer?: boolean, uid?: string}} fields
   *   uid: a stable id from the caller (the Markdown import), else a random one
   * @param {Actor} actor
   */
  addRecord(taskId, fields, actor) {
    return this.tx(() => {
      this.checkParent(taskId, fields.parent_id);
      const now = Date.now();
      const position = fields.position
        ?? /** @type {any} */ (this.q("SELECT coalesce(max(position), 0) + 1 AS p FROM records WHERE task_id = ?").get(taskId)).p;
      const { lastInsertRowid } = this.q(`INSERT INTO records
          (uid, task_id, kind, owner, status, title, body, position, parent_id, links, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        fields.uid ?? uid(), taskId, fields.kind, fields.owner ?? null, fields.status ?? "open", fields.title, fields.body ?? null,
        position, fields.parent_id ?? null, json(fields.links), now, now,
      );
      const id = Number(lastInsertRowid);
      const row = /** @type {any} */ (this.record(id));
      const after = Object.fromEntries(EDITABLE.filter((f) => row[f] != null).map((f) => [f, row[f]]));
      this.version_(id, actor, "create", null, after, now);
      if (fields.pointer) this.movePointer(id, actor, now);
      return this.record(id);
    });
  }

  /**
   * Changes the given fields; a version row records what changed. No-op when nothing did.
   * @param {number} id @param {Record<string, any>} patch @param {Actor} actor
   */
  updateRecord(id, patch, actor) {
    for (const f of Object.keys(patch)) {
      if (!EDITABLE.includes(f)) throw new Error(`Imprimatur: record field "${f}" is not editable`);
    }
    return this.tx(() => {
      const old = this.record(id);
      if (!old) throw new Error(`Imprimatur: no record ${id}`);
      /** @type {Record<string, any>} */ const before = {};
      /** @type {Record<string, any>} */ const after = {};
      for (const [f, v] of Object.entries(patch)) {
        if (JSON.stringify(old[f] ?? null) === JSON.stringify(v ?? null)) continue;
        before[f] = old[f] ?? null;
        after[f] = v ?? null;
      }
      const fields = Object.keys(after);
      if (!fields.length) return old;
      if ("parent_id" in after) this.checkParent(old.task_id, after.parent_id, id);
      const now = Date.now();
      // Field names come from EDITABLE, never from the caller's strings.
      this.q(`UPDATE records SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...fields.map((f) => (f === "links" ? json(after[f]) : after[f])), now, id);
      this.version_(id, actor, "update", before, after, now);
      // A record that is no longer open cannot be where we left off.
      if (old.pointer && after.status && after.status !== "open") {
        this.q("UPDATE records SET pointer = 0 WHERE id = ?").run(id);
        this.version_(id, actor, "update", { pointer: true }, { pointer: false }, now);
      }
      return this.record(id);
    });
  }

  /** A record's parent (the question an answer answers) is another record of the same task. @param {number} taskId @param {number | null | undefined} parentId @param {number} [self] */
  checkParent(taskId, parentId, self) {
    if (parentId == null) return;
    const parent = this.q("SELECT task_id FROM records WHERE id = ?").get(parentId);
    if (!parent || parent.task_id !== taskId || parentId === self) {
      throw new Error(`Imprimatur: parent ${parentId} is not another record of task ${taskId}`);
    }
  }

  /** Puts the task's 👉 on this record (and takes it off the previous one). @param {number} id @param {Actor} actor */
  setPointer(id, actor) {
    return this.tx(() => {
      this.movePointer(id, actor, Date.now());
      return this.record(id);
    });
  }

  /** Takes the 👉 off this record, if it has it. @param {number} id @param {Actor} actor */
  clearPointer(id, actor) {
    return this.tx(() => {
      const now = Date.now();
      if (this.q("UPDATE records SET pointer = 0, updated_at = ? WHERE id = ? AND pointer = 1").run(now, id).changes) {
        this.version_(id, actor, "update", { pointer: true }, { pointer: false }, now);
      }
      return this.record(id);
    });
  }

  /** Imported records of one source file in a repo (links.source). @param {number} repoId @param {string} source */
  recordsFromSource(repoId, source) {
    return this.q(`SELECT r.* FROM records r JOIN tasks t ON t.id = r.task_id
                   WHERE t.repo_id = ? AND r.uid LIKE 'md:%' AND json_extract(r.links, '$.source') = ?`).all(repoId, source).map(recordOf);
  }

  /** @param {number} id @param {Actor} actor @param {number} now */
  movePointer(id, actor, now) {
    const rec = this.record(id);
    if (!rec) throw new Error(`Imprimatur: no record ${id}`);
    if (rec.status !== "open") throw new Error(`Imprimatur: record ${id} is ${rec.status}; 👉 goes on an open record`);
    if (rec.pointer) return;
    const prev = this.q("SELECT id FROM records WHERE task_id = ? AND pointer = 1").get(rec.task_id);
    if (prev) {
      this.q("UPDATE records SET pointer = 0, updated_at = ? WHERE id = ?").run(now, prev.id);
      this.version_(prev.id, actor, "update", { pointer: true }, { pointer: false }, now);
    }
    this.q("UPDATE records SET pointer = 1, updated_at = ? WHERE id = ?").run(now, id);
    this.version_(id, actor, "update", { pointer: false }, { pointer: true }, now);
  }

  /** @param {number} id @param {Actor} actor @param {string} op @param {any} before @param {any} after @param {number} at */
  version_(id, actor, op, before, after, at) {
    if (!ACTORS.includes(actor?.kind)) throw new Error(`Imprimatur: actor kind must be one of ${ACTORS.join(", ")}`);
    this.q("INSERT INTO record_versions (record_id, at, actor_kind, actor, op, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, at, actor.kind, actor.id ?? null, op, json(before), json(after));
  }

  /** @param {number} id */
  versionsOf(id) {
    return this.q("SELECT * FROM record_versions WHERE record_id = ? ORDER BY id").all(id).map((/** @type {any} */ v) => ({
      ...v, before: v.before ? JSON.parse(v.before) : null, after: v.after ? JSON.parse(v.after) : null,
    }));
  }

  /** @param {number} repoId @param {{status?: string, limit?: number}} [o] */
  tasksOf(repoId, { status, limit = 200 } = {}) {
    return status
      ? this.q("SELECT * FROM tasks WHERE repo_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?").all(repoId, status, limit)
      : this.q("SELECT * FROM tasks WHERE repo_id = ? ORDER BY updated_at DESC LIMIT ?").all(repoId, limit);
  }

  /** A task's records in order, dropped ones left out unless asked. @param {number} taskId @param {{dropped?: boolean}} [o] */
  recordsOf(taskId, { dropped = false } = {}) {
    return (dropped
      ? this.q("SELECT * FROM records WHERE task_id = ? ORDER BY position").all(taskId)
      : this.q("SELECT * FROM records WHERE task_id = ? AND status != 'dropped' ORDER BY position").all(taskId)
    ).map(recordOf);
  }

  /** @param {number} repoId @param {string} key */
  taskByKey(repoId, key) {
    return this.q("SELECT * FROM tasks WHERE repo_id = ? AND key = ?").get(repoId, key);
  }

  /**
   * Where each unfinished task of a repo was left: its 👉 record and its open records count.
   * @param {number} repoId
   */
  whereWeLeftOff(repoId) {
    return this.q(`SELECT t.key, t.title, t.status, t.summary,
                     p.id AS pointer_id, p.kind AS pointer_kind, p.owner AS pointer_owner, p.title AS pointer_title,
                     (SELECT count(*) FROM records o WHERE o.task_id = t.id AND o.status = 'open') AS open_records
                   FROM tasks t LEFT JOIN records p ON p.task_id = t.id AND p.pointer = 1
                   WHERE t.repo_id = ? AND t.status IN ('open', 'active')
                   ORDER BY t.updated_at DESC LIMIT 100`).all(repoId);
  }

  /**
   * Records whose title or body contains the text (case-insensitive for ASCII), newest first.
   * @param {string} text @param {{repoId?: number, kind?: string, limit?: number}} [o]
   */
  search(text, { repoId, kind, limit = 20 } = {}) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.q(`SELECT r.*, t.key AS task_key FROM records r JOIN tasks t ON t.id = r.task_id
                   WHERE (r.title LIKE $like ESCAPE '\\' OR r.body LIKE $like ESCAPE '\\')
                     AND ($repo IS NULL OR t.repo_id = $repo) AND ($kind IS NULL OR r.kind = $kind)
                   ORDER BY r.updated_at DESC LIMIT $limit`).all({ like, repo: repoId ?? null, kind: kind ?? null, limit }).map(recordOf);
  }

  /** Open records the user (K) owes, newest first, across repos or in one. @param {{repoId?: number, limit?: number}} [o] */
  openAsks({ repoId, limit = 50 } = {}) {
    const sql = `SELECT r.*, t.key AS task_key, t.repo_id FROM records r JOIN tasks t ON t.id = r.task_id
                 WHERE r.status = 'open' AND r.owner = 'K' AND r.kind IN ('todo', 'question')
                 ${repoId == null ? "" : "AND t.repo_id = ?"} ORDER BY r.created_at DESC LIMIT ?`;
    return (repoId == null ? this.q(sql).all(limit) : this.q(sql).all(repoId, limit)).map(recordOf);
  }
}

/**
 * Opens (creating if needed) the device database and brings its schema up to date.
 * @param {{path?: string}} [o]
 */
function openDb({ path: file = dbPath() } = {}) {
  if (file !== ":memory:") {
    if (onWindowsDrive(file)) {
      throw new Error(`Imprimatur: database ${file} is on a Windows drive; WAL breaks across WSL/Windows, use a Linux path`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const { DatabaseSync } = loadSqlite();
  const db = new Db(new DatabaseSync(file), file);
  const s = db.sqlite;
  try {
    // busy_timeout first: the rest may wait on another opener.
    s.exec("PRAGMA busy_timeout = 5000");
    toWal(s);
    s.exec("PRAGMA synchronous = NORMAL");
    s.exec("PRAGMA foreign_keys = ON");
    db.version = /** @type {any} */ (s.prepare("PRAGMA user_version").get()).user_version;
    if (db.version < VERSION) {
      db.tx(() => {
        // Another process may have migrated while we waited for the lock.
        let v = /** @type {any} */ (s.prepare("PRAGMA user_version").get()).user_version;
        for (; v < VERSION; v++) s.exec(MIGRATIONS[v]);
        s.exec(`PRAGMA user_version = ${VERSION}`);
      });
      db.version = VERSION;
    }
  } catch (e) {
    s.close();
    throw e;
  }
  return db;
}

module.exports = { openDb, dbPath, onWindowsDrive, KINDS, ACTORS, VERSION, MIGRATIONS };
