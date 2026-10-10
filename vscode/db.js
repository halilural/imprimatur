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
  // Sync between machines (#61): field changes wait in outbox until pushed; clock
  // keeps who last set each synced field and when (last writer wins per field).
  `
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE outbox (
    -- AUTOINCREMENT: an id is never reused, so acking pushed ids cannot drop a newer row.
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    key TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT,
    at INTEGER NOT NULL
  );
  CREATE TABLE clock (
    entity TEXT NOT NULL,
    key TEXT NOT NULL,
    field TEXT NOT NULL,
    at INTEGER NOT NULL,
    device TEXT NOT NULL,
    PRIMARY KEY (entity, key, field)
  ) WITHOUT ROWID;
  `,
  // Issue tracker sync (#70): task status changes waiting to be pushed to GitHub or Jira.
  // Per device, never synced: the device where the change was made pushes it.
  `
  CREATE TABLE tracker_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('close_done', 'close_dropped', 'reopen')),
    comment TEXT,
    at INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tracker_outbox_task ON tracker_outbox(task_id);
  `,
];
const VERSION = MIGRATIONS.length;

/**
 * Synced fields per entity (#61). Keys: repo = its origin, task = origin + "\t" + task key,
 * record = its uid. "task" comes first: a record seen for the first time needs it.
 */
const SYNC_FIELDS = {
  repo: ["name"],
  task: ["title", "status", "summary", "epic", "pointer"],
  record: ["task", "kind", "owner", "status", "title", "body", "position", "parent", "links", "created_at"],
};
/** A repo known only from another machine: root "origin:<origin>" until this machine opens it. */
const PLACEHOLDER = "origin:";
const TASK_STATUSES = ["open", "active", "done", "dropped"];
const RECORD_STATUSES = ["open", "done", "dropped"];
/** Changes kept for later (their parent record has not arrived), at most. */
const MAX_PENDING = 5000;
/** ... and for this many later pulls. */
const MAX_TRIES = 3;

/**
 * One spelling per remote: git@github.com:a/b.git and https://github.com/a/b are the same repo.
 * @param {string} url
 */
function normOrigin(url) {
  let s = String(url).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
  if (!/^[^/]*:\d+\//.test(s)) s = s.replace(/^([^/:]+):/, "$1/");
  s = s.replace(/\/+$/, "").replace(/\.git$/, "");
  const i = s.indexOf("/");
  return i < 0 ? s.toLowerCase() : s.slice(0, i).toLowerCase() + s.slice(i);
}

/** Task statuses that close it (#70). */
const CLOSED = new Set(["done", "dropped"]);
/** Task keys an issue tracker knows: a GitHub issue "#12" or a Jira key "PROJ-12" (#70). */
const TRACKER_KEY = /^(#\d+|[A-Z][A-Z0-9]+-\d+)$/;

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether an epic's record is the line for a task (#70): its links.issue is the task's
 * number or key, or its title starts with the key ("#56 …", "[#56 …](url)", "PROJ-12 …").
 * A key mentioned later in the title does not count.
 * @param {{title: string, links?: any}} rec @param {string} key
 */
function refersTo(rec, key) {
  const bare = (/** @type {unknown} */ v) => String(v ?? "").trim().replace(/^#/, "");
  const issue = rec.links && typeof rec.links === "object" ? rec.links.issue : undefined;
  if (issue != null && issue !== "" && bare(issue) === bare(key)) return true;
  return new RegExp(`^\\s*\\[?${escapeRe(key)}(?!\\w)`).test(rec.title ?? "");
}

/** YYYY-MM-DD in local time. @param {number} at */
const day = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

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
/** @param {any} s @param {number} [waitMs] */
function toWal(s, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
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
    /** Transactions open on this connection: a nested tx joins the outer one. */
    this.depth = 0;
    /** Commits made through this connection (data_version only counts other connections'). */
    this.writes = 0;
  }

  /**
   * Changes when the database does, through this connection or any other (#69):
   * caches of what was read are good while it stays the same.
   */
  changeStamp() {
    return `${/** @type {any} */ (this.q("PRAGMA data_version").get()).data_version}:${this.writes}`;
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
    // Inside another tx: part of it, so several writes commit or roll back together.
    if (this.depth) return fn();
    this.sqlite.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.sqlite.exec("COMMIT");
      this.writes++;
      return out;
    } catch (e) {
      // SQLite may have rolled back already (IOERR, FULL): keep the real error.
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {}
      throw e;
    } finally {
      this.depth--;
    }
  }

  /** The repo row for a root, created on first sight. @param {string} root @param {{origin?: string, name?: string}} [info] */
  repoOf(root, info = {}) {
    const found = this.q("SELECT * FROM repos WHERE root = ?").get(root);
    if (found && (!info.origin || found.origin)) return found;
    const origin = info.origin ? normOrigin(info.origin) : null;
    return this.tx(() => {
      const row = this.q("SELECT * FROM repos WHERE root = ?").get(root);
      const placeholder = origin && this.q("SELECT * FROM repos WHERE root = ?").get(PLACEHOLDER + origin);
      if (row) {
        if (row.origin || !origin) return row;
        // The origin is learnt now: what came from other machines merges in.
        if (placeholder) this.mergePlaceholder_(placeholder, row, origin);
        this.q("UPDATE repos SET origin = ? WHERE id = ?").run(info.origin, row.id);
        if (this.syncOn()) this.seed_(row.id);
        return this.q("SELECT * FROM repos WHERE id = ?").get(row.id);
      }
      if (placeholder) {
        // First opened here after its tasks arrived from another machine: adopt it.
        this.q("UPDATE repos SET root = ?, name = ? WHERE id = ?").run(root, info.name ?? path.basename(root), placeholder.id);
        return this.q("SELECT * FROM repos WHERE id = ?").get(placeholder.id);
      }
      this.q("INSERT OR IGNORE INTO repos (uid, root, origin, name, created_at) VALUES (?, ?, ?, ?, ?)").run(
        uid(), root, info.origin ?? null, info.name ?? path.basename(root), Date.now(),
      );
      const made = this.q("SELECT * FROM repos WHERE root = ?").get(root);
      this.trackRepo_(made, Date.now());
      return made;
    });
  }

  /**
   * Moves a placeholder's tasks into the real repo. A key both have becomes one task:
   * the placeholder's records move over (uids are unique), and each field the clock
   * holds (set through sync) takes the placeholder's value; then the placeholder goes.
   * @param {any} ph @param {any} repo @param {string} origin
   */
  mergePlaceholder_(ph, repo, origin) {
    for (const t of this.q("SELECT * FROM tasks WHERE repo_id = ?").all(ph.id)) {
      const mine = this.taskByKey(repo.id, t.key);
      if (!mine) {
        this.q("UPDATE tasks SET repo_id = ? WHERE id = ?").run(repo.id, t.id);
        continue;
      }
      const key = `${origin}\t${t.key}`;
      const synced = (f) => this.q("SELECT at FROM clock WHERE entity = 'task' AND key = ? AND field = ?").get(key, f);
      // A synced value wins over an empty one here, and over one set here before it.
      for (const [f, col] of [["title", "title"], ["status", "status"], ["summary", "summary"], ["epic", "epic_id"]]) {
        const clock = synced(f);
        if (clock && (mine[col] == null || mine[col] === "" || clock.at > mine.updated_at)) {
          this.q(`UPDATE tasks SET ${col} = ? WHERE id = ?`).run(t[col], mine.id);
        }
      }
      // One 👉 per task: the synced one wins.
      const drop = synced("pointer") ? mine.id : t.id;
      this.q("UPDATE records SET pointer = 0 WHERE task_id = ? AND pointer = 1").run(drop);
      this.q("UPDATE records SET task_id = ? WHERE task_id = ?").run(mine.id, t.id);
      this.q("UPDATE tasks SET epic_id = ? WHERE epic_id = ?").run(mine.id, t.id);
      this.q("UPDATE tasks SET updated_at = max(updated_at, ?) WHERE id = ?").run(t.updated_at, mine.id);
      this.q("DELETE FROM tasks WHERE id = ?").run(t.id);
    }
    this.q("DELETE FROM repos WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE repo_id = ?)").run(ph.id, ph.id);
  }

  /**
   * Creates the task or updates the given fields. The single path for a task's status (#70):
   * - set done or dropped: the epic's open lines for this task close with it, in this
   *   transaction (refersTo), by the same actor; the epic's 👉 on one of them moves on.
   *   Reopening does not reopen them.
   * - a status that crosses open/active ↔ done/dropped is queued for the issue tracker
   *   (tracker_outbox), unless the writer is an import (the tracker's own pull, Markdown).
   * Changes pulled from other machines (applyRemote) do not come here: no cascade, no push.
   * @param {number} repoId @param {string} key
   * @param {{title?: string, status?: string, epicId?: number | null, summary?: string | null}} [fields]
   * @param {Actor} [actor] who writes (the epic lines' version rows); a user by default
   */
  upsertTask(repoId, key, fields = {}, actor = { kind: "user" }) {
    return this.tx(() => {
      const now = Date.now();
      const before = this.q("SELECT * FROM tasks WHERE repo_id = ? AND key = ?").get(repoId, key);
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
      const after = this.q("SELECT * FROM tasks WHERE repo_id = ? AND key = ?").get(repoId, key);
      const col = { title: "title", status: "status", summary: "summary", epic: "epic_id" };
      this.trackTask_(after, SYNC_FIELDS.task.filter((f) => !before || before[col[f]] !== after[col[f]]), now);
      if (before?.status !== after.status && CLOSED.has(after.status)) this.closeEpicLines_(after, actor, now);
      // done ↔ dropped changes no issue, unless its close is still waiting (the reason changes).
      const crosses = before && before.status !== after.status
        && (CLOSED.has(before.status) !== CLOSED.has(after.status) || this.trackerPending(after.id));
      if (crosses && actor?.kind !== "import" && TRACKER_KEY.test(key)) {
        const action = after.status === "done" ? "close_done" : after.status === "dropped" ? "close_dropped" : "reopen";
        const comment = String(after.summary || after.title || key).slice(0, 1000);
        // The latest change wins: a close then a reopen before the push is one reopen.
        this.q("DELETE FROM tracker_outbox WHERE task_id = ?").run(after.id);
        this.q("INSERT INTO tracker_outbox (task_id, action, comment, at) VALUES (?, ?, ?, ?)").run(after.id, action, comment, now);
      }
      return after;
    });
  }

  /**
   * Closes the epic's open records that are this task's line (refersTo), noting why; a 👉 on
   * one moves to the epic's next open record by position, or goes. Returns their ids.
   * @param {any} task @param {Actor} actor @param {number} now
   */
  closeEpicLines_(task, actor, now) {
    if (task.epic_id == null || task.epic_id === task.id) return [];
    const lines = this.q("SELECT * FROM records WHERE task_id = ? AND status = 'open' ORDER BY position").all(task.epic_id)
      .map(recordOf).filter((r) => refersTo(r, task.key));
    if (!lines.length) return [];
    const note = `${task.key} ${task.status === "dropped" ? "bırakıldı" : "bitti"} (${day(now)})`;
    const held = lines.find((r) => r.pointer);
    for (const r of lines) this.updateRecord(r.id, { status: "done", body: r.body ? `${r.body}\n\n${note}` : note }, actor);
    if (held) {
      const next = this.q("SELECT id FROM records WHERE task_id = ? AND status = 'open' AND position > ? ORDER BY position LIMIT 1").get(task.epic_id, held.position);
      if (next) this.movePointer(next.id, actor, now);
    }
    return lines.map((r) => r.id);
  }

  // ---- Issue tracker outbox (#70) ----

  /** Queued tracker pushes, oldest first, with their task and repo. @param {number} [limit] */
  trackerOutbox(limit = 200) {
    return this.q(`SELECT o.*, t.key, t.status AS task_status, t.repo_id, r.origin, r.root
                   FROM tracker_outbox o LEFT JOIN tasks t ON t.id = o.task_id LEFT JOIN repos r ON r.id = t.repo_id
                   ORDER BY o.id LIMIT ?`).all(limit);
  }

  trackerOutboxCount() {
    return /** @type {any} */ (this.q("SELECT count(*) AS n FROM tracker_outbox").get()).n;
  }

  /** @param {number} id */
  trackerDone(id) {
    this.q("DELETE FROM tracker_outbox WHERE id = ?").run(id);
  }

  /** One more failed try; returns how many. @param {number} id @returns {number} */
  trackerFailed(id) {
    this.q("UPDATE tracker_outbox SET tries = tries + 1 WHERE id = ?").run(id);
    return /** @type {any} */ (this.q("SELECT tries FROM tracker_outbox WHERE id = ?").get(id))?.tries ?? 0;
  }

  /** Whether a push for this task still waits (the tracker's pull leaves the task alone). @param {number} taskId */
  trackerPending(taskId) {
    return !!this.q("SELECT 1 FROM tracker_outbox WHERE task_id = ?").get(taskId);
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
      this.trackRecord_(id, SYNC_FIELDS.record, now);
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
      const synced = fields.map((f) => (f === "parent_id" ? "parent" : f));
      // A record that is no longer open cannot be where we left off.
      if (old.pointer && after.status && after.status !== "open") {
        this.q("UPDATE records SET pointer = 0 WHERE id = ?").run(id);
        this.version_(id, actor, "update", { pointer: true }, { pointer: false }, now);
        this.trackTask_(this.taskById(old.task_id), ["pointer"], now);
      }
      this.trackRecord_(id, synced, now);
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
        this.trackTask_(this.taskById(this.q("SELECT task_id FROM records WHERE id = ?").get(id).task_id), ["pointer"], now);
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
    this.trackTask_(this.taskById(rec.task_id), ["pointer"], now);
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

  /** Every repo with records, by name. */
  repos() {
    return this.q("SELECT * FROM repos ORDER BY name, root").all();
  }

  /** @param {number} id */
  taskById(id) {
    return this.q("SELECT * FROM tasks WHERE id = ?").get(id);
  }

  /**
   * A repo's records of some kinds with their task key, newest first; dropped ones left out.
   * @param {number} repoId @param {string[]} kinds @param {{limit?: number}} [o]
   */
  recordsByKind(repoId, kinds, { limit = 500 } = {}) {
    const list = kinds.filter((k) => KINDS.includes(k));
    if (!list.length) return [];
    return this.q(`SELECT r.*, t.key AS task_key FROM records r JOIN tasks t ON t.id = r.task_id
                   WHERE t.repo_id = ? AND r.kind IN (${list.map(() => "?").join(", ")}) AND r.status != 'dropped'
                   ORDER BY r.updated_at DESC LIMIT ?`).all(repoId, ...list, limit).map(recordOf);
  }

  /** The repo row of a root, without creating it. @param {string} root */
  repoByRoot(root) {
    return this.q("SELECT * FROM repos WHERE root = ?").get(root);
  }

  /**
   * Tasks each agent session wrote records of, last written last: session → keys.
   * The actor is "<client>:<session>" (the MCP server's hook adds the session).
   * @param {number} repoId @returns {Map<string, string[]>}
   */
  sessionTasks(repoId) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    const rows = this.q(`SELECT v.actor, t.key, max(v.at) AS at FROM record_versions v
                         JOIN records r ON r.id = v.record_id JOIN tasks t ON t.id = r.task_id
                         WHERE t.repo_id = ? AND v.actor_kind = 'agent' AND v.actor LIKE '%:%'
                         GROUP BY v.actor, t.key ORDER BY at`).all(repoId);
    for (const { actor, key } of rows) {
      const session = actor.slice(actor.indexOf(":") + 1);
      out.set(session, [...(out.get(session) ?? []).filter((k) => k !== key), key]);
    }
    return out;
  }

  /**
   * Agents' record changes in a repo, newest first: each version with its record and task (#60).
   * @param {number} repoId @param {{limit?: number}} [o]
   */
  agentChanges(repoId, { limit = 300 } = {}) {
    return this.q(`SELECT v.id, v.at, v.actor, v.op, v.before, v.after, r.id AS record_id, r.kind, r.title, r.status, t.key AS task_key
                   FROM record_versions v JOIN records r ON r.id = v.record_id JOIN tasks t ON t.id = r.task_id
                   WHERE t.repo_id = ? AND v.actor_kind = 'agent' ORDER BY v.id DESC LIMIT ?`).all(repoId, limit)
      .map((/** @type {any} */ v) => ({ ...v, before: v.before ? JSON.parse(v.before) : null, after: v.after ? JSON.parse(v.after) : null }));
  }

  /** Done tasks and when they last changed: key → epoch ms. @param {number} repoId @returns {Map<string, number>} */
  doneTasks(repoId) {
    return new Map(this.q("SELECT key, updated_at FROM tasks WHERE repo_id = ? AND status = 'done'").all(repoId).map((t) => [t.key, t.updated_at]));
  }

  /** @param {number} repoId @param {string} key */
  taskByKey(repoId, key) {
    return this.q("SELECT * FROM tasks WHERE repo_id = ? AND key = ?").get(repoId, key);
  }

  /** Every task key of a repo, most recently updated first (#64: suggestions for a mistyped key). @param {number} repoId @returns {string[]} */
  taskKeys(repoId) {
    return this.q("SELECT key FROM tasks WHERE repo_id = ? ORDER BY updated_at DESC, id DESC").all(repoId).map((/** @type {any} */ t) => t.key);
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

  /**
   * Every live record of a repo, few columns, for lists that count per task (#69).
   * @param {number} repoId
   */
  recordsOfRepo(repoId) {
    return this.q(`SELECT r.id, r.task_id, r.kind, r.owner, r.status, r.pointer, r.title, r.updated_at
                   FROM records r JOIN tasks t ON t.id = r.task_id
                   WHERE t.repo_id = ? AND r.status != 'dropped' ORDER BY r.task_id, r.position`).all(repoId)
      .map((/** @type {any} */ r) => ({ ...r, pointer: !!r.pointer }));
  }

  /**
   * A task's record history, newest first, with each record's kind and title (#69).
   * @param {number} taskId @param {{limit?: number}} [o] @returns {{list: any[], total: number}}
   */
  taskVersions(taskId, { limit = 200 } = {}) {
    const total = /** @type {any} */ (this.q("SELECT count(*) AS n FROM record_versions v JOIN records r ON r.id = v.record_id WHERE r.task_id = ?").get(taskId)).n;
    const list = this.q(`SELECT v.*, r.kind, r.title FROM record_versions v JOIN records r ON r.id = v.record_id
                         WHERE r.task_id = ? ORDER BY v.id DESC LIMIT ?`).all(taskId, limit)
      .map((/** @type {any} */ v) => ({ ...v, before: v.before ? JSON.parse(v.before) : null, after: v.after ? JSON.parse(v.after) : null }));
    return { list, total };
  }

  /**
   * The user's answer to an open question: an answer record under it and the
   * question done, in one transaction (#69).
   * @param {number} questionId @param {{title: string, body?: string | null}} answer @param {Actor} actor
   */
  answerQuestion(questionId, answer, actor) {
    return this.tx(() => {
      const q = this.record(questionId);
      if (!q) throw new Error(`Imprimatur: no record ${questionId}`);
      if (q.kind !== "question") throw new Error(`Imprimatur: record ${questionId} is a ${q.kind}, not a question`);
      if (q.status !== "open") throw new Error(`Imprimatur: question ${questionId} is ${q.status}, not open`);
      const made = this.addRecord(q.task_id, { kind: "answer", title: answer.title, body: answer.body ?? null, parent_id: q.id }, actor);
      this.updateRecord(q.id, { status: "done" }, actor);
      return made;
    });
  }

  /** Who created each record of a task: record id → actor kind, one query (#69). @param {number} taskId @returns {Map<number, string>} */
  creatorsOf(taskId) {
    return new Map(this.q(`SELECT v.record_id, v.actor_kind FROM record_versions v JOIN records r ON r.id = v.record_id
                           WHERE r.task_id = ? AND v.op = 'create'`).all(taskId).map((/** @type {any} */ v) => [v.record_id, v.actor_kind]));
  }

  /**
   * Open manual tests (kind test, not the agent's): what the user checks by eye (#69).
   * @param {{repoId?: number, limit?: number}} [o]
   */
  openTests({ repoId, limit = 200 } = {}) {
    const sql = `SELECT r.*, t.key AS task_key, t.repo_id FROM records r JOIN tasks t ON t.id = r.task_id
                 WHERE r.status = 'open' AND r.kind = 'test' AND (r.owner IS NULL OR r.owner = 'K')
                 ${repoId == null ? "" : "AND t.repo_id = ?"} ORDER BY r.created_at DESC LIMIT ?`;
    return (repoId == null ? this.q(sql).all(limit) : this.q(sql).all(repoId, limit)).map(recordOf);
  }

  /**
   * Records the user closed since a time (status → done by a user actor), newest first (#69).
   * @param {number} since epoch ms @param {{repoId?: number, limit?: number}} [o]
   */
  doneByUserSince(since, { repoId, limit = 100 } = {}) {
    const sql = `SELECT r.*, t.key AS task_key, t.repo_id, max(v.at) AS done_at FROM record_versions v
                 JOIN records r ON r.id = v.record_id JOIN tasks t ON t.id = r.task_id
                 WHERE v.actor_kind = 'user' AND v.at >= ? AND json_extract(v.after, '$.status') = 'done'
                   AND r.status = 'done' AND r.kind IN ('todo', 'question', 'test')
                   ${repoId == null ? "" : "AND t.repo_id = ?"}
                 GROUP BY r.id ORDER BY done_at DESC LIMIT ?`;
    return (repoId == null ? this.q(sql).all(since, limit) : this.q(sql).all(since, repoId, limit)).map(recordOf);
  }

  // ---- Sync between machines (#61) ----

  /** @param {string} k @returns {string | undefined} */
  meta(k) {
    return this.q("SELECT v FROM meta WHERE k = ?").get(k)?.v ?? undefined;
  }

  /** @param {string} k @param {string | number | null} v null deletes */
  setMeta(k, v) {
    if (v == null) this.q("DELETE FROM meta WHERE k = ?").run(k);
    else this.q("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, String(v));
  }

  /** Whether local writes are queued for sync. Off: writes cost what they did before #61. */
  syncOn() {
    return this.meta("sync") === "on";
  }

  /** This device's id, made once. */
  deviceId() {
    let d = this.meta("device");
    if (!d) {
      this.q("INSERT OR IGNORE INTO meta (k, v) VALUES ('device', ?)").run(uid());
      d = /** @type {string} */ (this.meta("device"));
    }
    return d;
  }

  /**
   * Turns sync on. The first time, and again after disableSync (edits made while off were
   * not queued), every repo, task and record is queued; fields another machine set later stay theirs.
   */
  enableSync() {
    return this.tx(() => {
      this.setMeta("sync", "on");
      this.deviceId();
      if (this.meta("seeded")) return 0;
      const n = this.seed_();
      this.setMeta("seeded", "1");
      return n;
    });
  }

  disableSync() {
    this.tx(() => {
      this.setMeta("sync", null);
      this.setMeta("seeded", null);
    });
  }

  /** Queued changes, oldest first. @param {number} limit */
  outbox(limit = 1000) {
    return this.q("SELECT * FROM outbox ORDER BY id LIMIT ?").all(limit);
  }

  outboxCount() {
    return /** @type {any} */ (this.q("SELECT count(*) AS n FROM outbox").get()).n;
  }

  /** The server has these queued changes (exactly these: another sync may have queued more). @param {number[]} ids */
  ackOutbox(ids) {
    if (ids.length) this.q("DELETE FROM outbox WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
  }

  /** @param {any} repo */
  originKey_(repo) {
    return repo?.origin ? normOrigin(repo.origin) : undefined;
  }

  /**
   * The repo an origin syncs with: its first real clone here (by id), else its placeholder.
   * Other clones of the same origin do not sync. @param {string} origin
   */
  syncRepo_(origin) {
    const mine = this.q("SELECT * FROM repos WHERE origin IS NOT NULL ORDER BY id").all().filter((r) => normOrigin(r.origin) === origin);
    return mine.find((r) => !r.root.startsWith(PLACEHOLDER)) ?? mine[0];
  }

  /** Second clones of an origin, which do not sync (the first one by id does). */
  unsyncedClones() {
    return this.q("SELECT * FROM repos WHERE origin IS NOT NULL ORDER BY id").all()
      .filter((r) => !r.root.startsWith(PLACEHOLDER) && this.syncRepo_(normOrigin(r.origin))?.id !== r.id);
  }

  /** @param {any} task */
  taskKey_(task) {
    const repo = task && this.q("SELECT id, origin FROM repos WHERE id = ?").get(task.repo_id);
    const origin = this.originKey_(repo);
    return origin && this.syncRepo_(origin)?.id === repo.id ? `${origin}\t${task.key}` : undefined;
  }

  /** A synced field's value as this database holds it. @param {"repo" | "task" | "record"} entity @param {any} row @param {string} f */
  syncValue_(entity, row, f) {
    if (entity === "repo") return row.name ?? null;
    if (entity === "task") {
      if (f === "epic") return row.epic_id == null ? null : this.taskById(row.epic_id)?.key ?? null;
      // The 👉 is one field of the task (the record's uid), so two machines cannot each keep their own.
      if (f === "pointer") return this.q("SELECT uid FROM records WHERE task_id = ? AND pointer = 1").get(row.id)?.uid ?? null;
      return row[f] ?? null;
    }
    if (f === "task") return this.taskKey_(this.taskById(row.task_id)) ?? null;
    if (f === "parent") return row.parent_id == null ? null : this.q("SELECT uid FROM records WHERE id = ?").get(row.parent_id)?.uid ?? null;
    if (f === "pointer") return Boolean(row.pointer);
    if (f === "links") return typeof row.links === "string" ? JSON.parse(row.links) : row.links ?? null;
    return row[f] ?? null;
  }

  /**
   * Queues fields of one entity and claims them in the clock. A local write is never
   * older than what the clock holds (another machine's clock may run ahead).
   * @param {string} entity @param {string} key @param {Array<[string, any]>} fields @param {number} at
   */
  enqueue_(entity, key, fields, at) {
    const device = this.deviceId();
    for (const [field, value] of fields) {
      const clock = this.q("SELECT at FROM clock WHERE entity = ? AND key = ? AND field = ?").get(entity, key, field);
      const t = clock && clock.at >= at ? clock.at + 1 : at;
      this.q("INSERT INTO outbox (entity, key, field, value, at) VALUES (?, ?, ?, ?, ?)").run(entity, key, field, JSON.stringify(value ?? null), t);
      this.q(`INSERT INTO clock (entity, key, field, at, device) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (entity, key, field) DO UPDATE SET at = excluded.at, device = excluded.device`).run(entity, key, field, t, device);
    }
  }

  /** @param {any} repo @param {number} at */
  trackRepo_(repo, at) {
    const key = this.originKey_(repo);
    if (!key || repo.root.startsWith(PLACEHOLDER) || !this.syncOn()) return;
    this.enqueue_("repo", key, [["name", repo.name ?? null]], at);
  }

  /** @param {any} task @param {string[]} fields @param {number} at */
  trackTask_(task, fields, at) {
    if (!fields.length || !this.syncOn()) return;
    const key = this.taskKey_(task);
    if (key) this.enqueue_("task", key, fields.map((f) => [f, this.syncValue_("task", task, f)]), at);
  }

  /** @param {number} id @param {string[]} fields @param {number} at */
  trackRecord_(id, fields, at) {
    if (!fields.length || !this.syncOn()) return;
    const rec = this.record(id);
    if (!rec || !this.taskKey_(this.taskById(rec.task_id))) return;
    this.enqueue_("record", rec.uid, fields.map((f) => [f, this.syncValue_("record", rec, f)]), at);
  }

  /**
   * Queues every synced field of the repos with an origin (or one repo), dated by its
   * updated_at. Fields another machine set last stay theirs.
   * @param {number} [repoId]
   */
  seed_(repoId) {
    const device = this.deviceId();
    let n = 0;
    /** @param {string} entity @param {string} key @param {any} row @param {number} at */
    const put = (entity, key, row, at) => {
      for (const f of /** @type {any} */ (SYNC_FIELDS)[entity]) {
        const clock = this.q("SELECT at, device FROM clock WHERE entity = ? AND key = ? AND field = ?").get(entity, key, f);
        // Another machine's value, not changed here since: stays theirs.
        if (clock && clock.device !== device && at <= clock.at) continue;
        const t = Math.max(clock?.at ?? 0, at);
        this.q("INSERT INTO outbox (entity, key, field, value, at) VALUES (?, ?, ?, ?, ?)")
          .run(entity, key, f, JSON.stringify(this.syncValue_(/** @type {any} */ (entity), row, f) ?? null), t);
        this.q(`INSERT INTO clock (entity, key, field, at, device) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (entity, key, field) DO UPDATE SET at = excluded.at, device = excluded.device`).run(entity, key, f, t, device);
        n++;
      }
    };
    const repos = repoId == null ? this.q("SELECT * FROM repos WHERE origin IS NOT NULL ORDER BY id").all()
      : this.q("SELECT * FROM repos WHERE id = ? AND origin IS NOT NULL").all(repoId);
    for (const repo of repos) {
      const origin = /** @type {string} */ (this.originKey_(repo));
      if (this.syncRepo_(origin)?.id !== repo.id) continue;
      if (!repo.root.startsWith(PLACEHOLDER)) put("repo", origin, repo, repo.created_at);
      for (const task of this.q("SELECT * FROM tasks WHERE repo_id = ? ORDER BY id").all(repo.id)) {
        put("task", `${origin}\t${task.key}`, task, task.updated_at);
      }
      const recs = this.q("SELECT r.* FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? ORDER BY r.id").all(repo.id);
      for (const rec of recs) put("record", rec.uid, recordOf(rec), rec.updated_at);
    }
    return n;
  }

  /** The repo for an origin: a real one if this machine has it, else a placeholder. @param {string} origin */
  repoForOrigin_(origin) {
    const found = this.syncRepo_(origin);
    if (found) return found;
    const name = origin.split("/").filter(Boolean).pop() ?? origin;
    this.q("INSERT INTO repos (uid, root, origin, name, created_at) VALUES (?, ?, ?, ?, ?)").run(uid(), PLACEHOLDER + origin, origin, name, Date.now());
    return this.q("SELECT * FROM repos WHERE root = ?").get(PLACEHOLDER + origin);
  }

  /** The task for a sync key, created if missing. @param {string} key @returns {any} */
  taskForKey_(key) {
    const tab = key.indexOf("\t");
    if (tab <= 0 || tab === key.length - 1) return undefined;
    const repo = this.repoForOrigin_(key.slice(0, tab));
    return this.taskIn_(repo.id, key.slice(tab + 1));
  }

  /** @param {number} repoId @param {string} key */
  taskIn_(repoId, key) {
    const t = this.taskByKey(repoId, key);
    if (t) return t;
    const now = Date.now();
    this.q("INSERT INTO tasks (uid, repo_id, key, title, status, created_at, updated_at) VALUES (?, ?, ?, '', 'open', ?, ?)").run(uid(), repoId, key, now, now);
    return this.taskByKey(repoId, key);
  }

  /**
   * Applies changes pulled from other machines in one transaction: per field the newer
   * change wins (a tie goes to the larger device id). Nothing here is queued again.
   * Changes waiting on a record that has not arrived are kept and tried next time.
   * @param {Array<{entity: string, key: string, field: string, value: string | null, at: number, device: string}>} changes
   * @param {{pullSeq?: number}} [o] saved with the changes
   */
  applyRemote(changes, { pullSeq, lastPage = true } = {}) {
    return this.tx(() => {
      const order = { repo: 0, task: 1, record: 2 };
      // A change still waiting after MAX_TRIES syncs (its record never came: say its task was
      // invalid) is dropped. Tries count once per sync, on its last page: during a long pull a
      // 👉 often comes pages before its record.
      const waiting = JSON.parse(this.meta("pending") ?? "[]");
      const kept = lastPage ? waiting.filter((/** @type {any} */ c) => (c.tries ?? 0) < MAX_TRIES) : waiting;
      const dropped = waiting.length - kept.length;
      let todo = [...kept.map((/** @type {any} */ c) => ({ ...c, tries: (c.tries ?? 0) + (lastPage ? 1 : 0) })), ...changes.map((c) => ({ ...c, tries: 0 }))]
        .map((c, i) => /** @type {const} */ ([c, i]))
        .sort((a, b) => ((/** @type {any} */ (order))[a[0].entity] ?? 3) - ((/** @type {any} */ (order))[b[0].entity] ?? 3) || a[1] - b[1])
        .map(([c]) => c);
      /** @type {Map<number, {before: any, after: any, device: string, op: string, at: number}>} */
      const versions = new Map();
      let applied = 0;
      // A record's parent may come later in the same batch: try again while that helps.
      for (let pass = 0; todo.length && pass < 3; pass++) {
        const later = [];
        for (const c of todo) {
          const r = this.applyOne_(c, versions);
          if (r === "later") later.push(c);
          else if (r) applied++;
        }
        if (later.length === todo.length) break;
        todo = later;
      }
      for (const [id, v] of versions) {
        if (!Object.keys(v.after).length && v.op === "update") continue;
        this.version_(id, { kind: "import", id: `sync:${v.device}` }, v.op, v.op === "create" ? null : v.before, v.after, v.at);
      }
      this.setMeta("pending", todo.length ? JSON.stringify(todo.slice(-MAX_PENDING)) : null);
      if (pullSeq != null) this.setMeta("pull_seq", pullSeq);
      return { applied, pending: todo.length, dropped };
    });
  }

  /** @param {any} c @param {Map<number, any>} versions @returns {boolean | "later"} */
  applyOne_(c, versions) {
    const { entity, key, field, at, device } = c;
    if (!(/** @type {any} */ (SYNC_FIELDS))[entity]?.includes(field) || typeof key !== "string" || !Number.isSafeInteger(at) || typeof device !== "string") return false;
    let value;
    try {
      value = c.value == null ? null : JSON.parse(c.value);
    } catch {
      return false;
    }
    const clock = this.q("SELECT at, device FROM clock WHERE entity = ? AND key = ? AND field = ?").get(entity, key, field);
    if (clock && (at < clock.at || (at === clock.at && device < clock.device))) return false;
    const str = (v) => typeof v === "string";
    if (entity === "repo") {
      if (!str(value)) return false;
      const repo = this.repoForOrigin_(key);
      // A repo's name is its folder here; only a placeholder takes the other machine's.
      if (repo.root.startsWith(PLACEHOLDER)) this.q("UPDATE repos SET name = ? WHERE id = ?").run(value, repo.id);
    } else if (entity === "task") {
      const task = this.taskForKey_(key);
      if (!task) return false;
      const set = (col, v) => this.q(`UPDATE tasks SET ${col} = ?, updated_at = max(updated_at, ?) WHERE id = ?`).run(v, at, task.id);
      if (field === "title") {
        if (!str(value)) return false;
        set("title", value);
      } else if (field === "status") {
        if (!TASK_STATUSES.includes(value)) return false;
        set("status", value);
      } else if (field === "summary") {
        if (value !== null && !str(value)) return false;
        set("summary", value);
      } else if (field === "epic") {
        if (value !== null && !str(value)) return false;
        const epic = value === null ? null : this.taskIn_(task.repo_id, value);
        set("epic_id", epic && epic.id !== task.id ? epic.id : null);
      } else if (field === "pointer") {
        if (value !== null && !str(value)) return false;
        const rec = value === null ? undefined : this.q("SELECT id, task_id FROM records WHERE uid = ?").get(value);
        // The record (or its move to this task) may come later in the pull.
        if (value !== null && (!rec || rec.task_id !== task.id)) return "later";
        this.q("UPDATE records SET pointer = 0 WHERE task_id = ? AND pointer = 1 AND id IS NOT ?").run(task.id, rec?.id ?? null);
        if (rec) this.q("UPDATE records SET pointer = 1 WHERE id = ?").run(rec.id);
      }
    } else {
      let rec = this.recordByUid(key);
      if (!rec) {
        if (field !== "task") return "later";
        const task = str(value) ? this.taskForKey_(value) : undefined;
        if (!task) return false;
        const { lastInsertRowid } = this.q(`INSERT INTO records (uid, task_id, kind, status, title, position, created_at, updated_at)
                                            VALUES (?, ?, 'note', 'open', '', 0, ?, ?)`).run(key, task.id, at, at);
        versions.set(Number(lastInsertRowid), { before: {}, after: {}, device, op: "create", at });
        rec = /** @type {any} */ (this.record(Number(lastInsertRowid)));
      } else {
        const r = this.applyField_(rec, field, value, at);
        if (r !== true) return r;
        const v = versions.get(rec.id) ?? { before: {}, after: {}, device, op: "update", at };
        versions.set(rec.id, v);
        const col = field === "parent" ? "parent_id" : field;
        if (!(col in v.before)) v.before[col] = rec[col] ?? null;
        const now = /** @type {any} */ (this.record(rec.id));
        v.after[col] = now[col] ?? null;
        if (JSON.stringify(v.before[col]) === JSON.stringify(v.after[col]) && v.op === "update") {
          delete v.before[col];
          delete v.after[col];
        }
        v.at = Math.max(v.at, at);
        v.device = device;
      }
    }
    this.q(`INSERT INTO clock (entity, key, field, at, device) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (entity, key, field) DO UPDATE SET at = excluded.at, device = excluded.device`).run(entity, key, field, at, device);
    return true;
  }

  /** One synced field of an existing record. @param {any} rec @param {string} field @param {any} value @param {number} at @returns {boolean | "later"} */
  applyField_(rec, field, value, at) {
    const set = (col, v) => this.q(`UPDATE records SET ${col} = ?, updated_at = max(updated_at, ?) WHERE id = ?`).run(v, at, rec.id);
    switch (field) {
      case "task": {
        const task = typeof value === "string" ? this.taskForKey_(value) : undefined;
        if (!task) return false;
        if (task.id === rec.task_id) return true;
        // Its 👉 stays only if the task it moves to has none.
        if (rec.pointer && this.q("SELECT 1 FROM records WHERE task_id = ? AND pointer = 1").get(task.id)) set("pointer", 0);
        set("task_id", task.id);
        return true;
      }
      case "kind":
        if (!KINDS.includes(value)) return false;
        set("kind", value);
        return true;
      case "owner":
        if (value !== null && value !== "C" && value !== "K") return false;
        set("owner", value);
        return true;
      case "status":
        if (!RECORD_STATUSES.includes(value)) return false;
        set("status", value);
        return true;
      case "pointer":
        if (typeof value !== "boolean") return false;
        if (value) this.q("UPDATE records SET pointer = 0 WHERE task_id = ? AND pointer = 1 AND id != ?").run(rec.task_id, rec.id);
        set("pointer", value ? 1 : 0);
        return true;
      case "title":
        if (typeof value !== "string") return false;
        set("title", value);
        return true;
      case "body":
        if (value !== null && typeof value !== "string") return false;
        set("body", value);
        return true;
      case "position":
        if (!Number.isFinite(value)) return false;
        set("position", value);
        return true;
      case "parent": {
        if (value === null) {
          set("parent_id", null);
          return true;
        }
        if (typeof value !== "string") return false;
        const parent = this.q("SELECT id FROM records WHERE uid = ?").get(value);
        if (!parent) return "later";
        set("parent_id", parent.id === rec.id ? null : parent.id);
        return true;
      }
      case "links":
        if (value !== null && (typeof value !== "object" || Array.isArray(value))) return false;
        set("links", json(value));
        return true;
      case "created_at":
        if (!Number.isSafeInteger(value)) return false;
        set("created_at", value);
        return true;
      default:
        return false;
    }
  }
}

/**
 * Opens (creating if needed) the device database and brings its schema up to date.
 * @param {{path?: string}} [o]
 */
function openDb({ path: file = dbPath(), busyMs = 5000 } = {}) {
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
    s.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}`);
    toWal(s, busyMs);
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

module.exports = { openDb, dbPath, onWindowsDrive, normOrigin, refersTo, KINDS, ACTORS, VERSION, MIGRATIONS, SYNC_FIELDS, PLACEHOLDER, TRACKER_KEY };
