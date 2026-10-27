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
  // Settings and one-time jobs of this database (meta). The migration also made two tables of
  // the sync that moved to a plugin (#106); a new database gets meta only.
  `
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  `,
  // Issue tracker sync (#70): task status changes waiting to be pushed to GitHub or Jira.
  // Per device, never synced: the device where the change was made pushes it.
  // tries: failures that count (4xx); fails + next_at: transient ones, retried with backoff;
  // commented: its comment is posted; claimed_at + claimant: the run pushing it (two windows).
  // tracker_state: each issue's state at the last pull, so a pull acts on state changes only.
  `
  CREATE TABLE tracker_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('close_done', 'close_dropped', 'reopen')),
    comment TEXT,
    at INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    fails INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    commented INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    claimant TEXT
  );
  CREATE INDEX tracker_outbox_task ON tracker_outbox(task_id);
  CREATE TABLE tracker_state (
    repo_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    provider TEXT NOT NULL,
    state TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, key)
  ) WITHOUT ROWID;
  `,
  // Design documents (#72): one architecture and one product document per repo, in
  // sections the agent and the user write; records (adr, pdr, decision, …) contribute to
  // sections. Sections are never deleted (status "superseded"); every change is a version.
  `
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    kind TEXT NOT NULL CHECK (kind IN ('architecture', 'product')),
    title TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (repo_id, kind)
  );
  CREATE TABLE doc_sections (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    doc_id INTEGER NOT NULL REFERENCES documents(id),
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    position REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
    updated_at INTEGER NOT NULL,
    UNIQUE (doc_id, key)
  );
  CREATE TABLE doc_section_records (
    section_id INTEGER NOT NULL REFERENCES doc_sections(id),
    record_id INTEGER NOT NULL REFERENCES records(id),
    PRIMARY KEY (section_id, record_id)
  ) WITHOUT ROWID;
  CREATE INDEX doc_section_records_record ON doc_section_records(record_id);
  CREATE TABLE doc_versions (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES doc_sections(id),
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN (${ACTORS.map((k) => `'${k}'`).join(", ")})),
    actor TEXT,
    before TEXT,
    after TEXT
  );
  CREATE INDEX doc_versions_section ON doc_versions(section_id, at);
  `,
  // The project glossary: a third document kind, one section per term. SQLite cannot change
  // a CHECK in place, so the four document tables are rebuilt: the new ones made and filled,
  // the old ones dropped child first (no foreign key breaks), the new ones renamed (their
  // references follow the renames).
  `
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    kind TEXT NOT NULL CHECK (kind IN ('architecture', 'product', 'glossary')),
    title TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (repo_id, kind)
  );
  CREATE TABLE doc_sections_new (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    doc_id INTEGER NOT NULL REFERENCES documents_new(id),
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    position REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
    updated_at INTEGER NOT NULL,
    UNIQUE (doc_id, key)
  );
  CREATE TABLE doc_section_records_new (
    section_id INTEGER NOT NULL REFERENCES doc_sections_new(id),
    record_id INTEGER NOT NULL REFERENCES records(id),
    PRIMARY KEY (section_id, record_id)
  ) WITHOUT ROWID;
  CREATE TABLE doc_versions_new (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES doc_sections_new(id),
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN (${ACTORS.map((k) => `'${k}'`).join(", ")})),
    actor TEXT,
    before TEXT,
    after TEXT
  );
  INSERT INTO documents_new SELECT id, uid, repo_id, kind, title, updated_at FROM documents;
  INSERT INTO doc_sections_new SELECT id, uid, doc_id, key, title, body, position, status, updated_at FROM doc_sections;
  INSERT INTO doc_section_records_new SELECT section_id, record_id FROM doc_section_records;
  INSERT INTO doc_versions_new SELECT id, section_id, at, actor_kind, actor, before, after FROM doc_versions;
  DROP TABLE doc_versions;
  DROP TABLE doc_section_records;
  DROP TABLE doc_sections;
  DROP TABLE documents;
  ALTER TABLE documents_new RENAME TO documents;
  ALTER TABLE doc_sections_new RENAME TO doc_sections;
  ALTER TABLE doc_section_records_new RENAME TO doc_section_records;
  ALTER TABLE doc_versions_new RENAME TO doc_versions;
  CREATE INDEX doc_section_records_record ON doc_section_records(record_id);
  CREATE INDEX doc_versions_section ON doc_versions(section_id, at);
  `,
  // A task's analysis (TASK-ANALYSIS): a fourth document kind, one per task. scope is the
  // task's key ('' for the repo's documents), so the key is (repo, kind, scope); a section's
  // source is the file it came from. doc_sources: each file's text as last read, so the
  // same text is not ingested twice. Rebuilt the same way as the glossary migration.
  `
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    kind TEXT NOT NULL CHECK (kind IN ('architecture', 'product', 'glossary', 'analysis')),
    scope TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (repo_id, kind, scope),
    CHECK ((kind = 'analysis') = (scope <> ''))
  );
  CREATE TABLE doc_sections_new (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    doc_id INTEGER NOT NULL REFERENCES documents_new(id),
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    position REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
    source TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (doc_id, key)
  );
  CREATE TABLE doc_section_records_new (
    section_id INTEGER NOT NULL REFERENCES doc_sections_new(id),
    record_id INTEGER NOT NULL REFERENCES records(id),
    PRIMARY KEY (section_id, record_id)
  ) WITHOUT ROWID;
  CREATE TABLE doc_versions_new (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES doc_sections_new(id),
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN (${ACTORS.map((k) => `'${k}'`).join(", ")})),
    actor TEXT,
    before TEXT,
    after TEXT
  );
  INSERT INTO documents_new SELECT id, uid, repo_id, kind, '', title, updated_at FROM documents;
  INSERT INTO doc_sections_new SELECT id, uid, doc_id, key, title, body, position, status, NULL, updated_at FROM doc_sections;
  INSERT INTO doc_section_records_new SELECT section_id, record_id FROM doc_section_records;
  INSERT INTO doc_versions_new SELECT id, section_id, at, actor_kind, actor, before, after FROM doc_versions;
  DROP TABLE doc_versions;
  DROP TABLE doc_section_records;
  DROP TABLE doc_sections;
  DROP TABLE documents;
  ALTER TABLE documents_new RENAME TO documents;
  ALTER TABLE doc_sections_new RENAME TO doc_sections;
  ALTER TABLE doc_section_records_new RENAME TO doc_section_records;
  ALTER TABLE doc_versions_new RENAME TO doc_versions;
  CREATE INDEX doc_section_records_record ON doc_section_records(record_id);
  CREATE INDEX doc_versions_section ON doc_versions(section_id, at);
  CREATE TABLE doc_sources (
    doc_id INTEGER NOT NULL REFERENCES documents(id),
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, path)
  ) WITHOUT ROWID;
  `,
  // What the user last read of each section (#92): its newest version then (version_id, not a
  // time: a change can be replayed with a past time). A later version by the agent or a hook is
  // unread. Device-local, not synced. Every section there now counts as read, or the first open
  // would show the whole history as unread.
  `
  CREATE TABLE section_reads (
    section_id INTEGER PRIMARY KEY REFERENCES doc_sections(id),
    version_id INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  INSERT INTO section_reads (section_id, version_id, at)
    SELECT s.id, coalesce((SELECT max(v.id) FROM doc_versions v WHERE v.section_id = s.id), 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM doc_sections s;
  `,
  // An early draft of migration 7 reached a live database without version_id: section_reads is
  // made again, every section read as of now (they are only marks; nothing else refers to them).
  `
  DROP TABLE section_reads;
  CREATE TABLE section_reads (
    section_id INTEGER PRIMARY KEY REFERENCES doc_sections(id),
    version_id INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  INSERT INTO section_reads (section_id, version_id, at)
    SELECT s.id, coalesce((SELECT max(v.id) FROM doc_versions v WHERE v.section_id = s.id), 0), CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM doc_sections s;
  `,
  // Exercise mode (#108): a topic the user practises, broken into small steps they tick. The
  // user's own, of no repo or task; device-local, not synced (like section_reads). A step split
  // later keeps its place: its smaller steps hang under it (parent_id).
  `
  CREATE TABLE exercises (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    goal TEXT,
    proof TEXT,
    context TEXT,
    weak TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'dropped')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE exercise_steps (
    id INTEGER PRIMARY KEY,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    parent_id INTEGER REFERENCES exercise_steps(id),
    position REAL NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    why TEXT,
    done_when TEXT,
    minutes INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'skipped')),
    note TEXT,
    done_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX exercise_steps_of ON exercise_steps(exercise_id, position);
  `,
  // Social media (#109): a fifth document kind, a repo's posts per channel with the rules read
  // for each and how they went. Shown only in a repo that turns it on (.claude/imprimatur.json
  // {"social": true}). The CHECK is rebuilt as in the analysis migration; doc_sources and
  // section_reads point into these tables now, so they are rebuilt too, children dropped first.
  `
  CREATE TABLE documents_new (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    kind TEXT NOT NULL CHECK (kind IN ('architecture', 'product', 'glossary', 'analysis', 'social')),
    scope TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (repo_id, kind, scope),
    CHECK ((kind = 'analysis') = (scope <> ''))
  );
  CREATE TABLE doc_sections_new (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    doc_id INTEGER NOT NULL REFERENCES documents_new(id),
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    position REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
    source TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (doc_id, key)
  );
  CREATE TABLE doc_section_records_new (
    section_id INTEGER NOT NULL REFERENCES doc_sections_new(id),
    record_id INTEGER NOT NULL REFERENCES records(id),
    PRIMARY KEY (section_id, record_id)
  ) WITHOUT ROWID;
  CREATE TABLE doc_versions_new (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES doc_sections_new(id),
    at INTEGER NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN (${ACTORS.map((k) => `'${k}'`).join(", ")})),
    actor TEXT,
    before TEXT,
    after TEXT
  );
  CREATE TABLE doc_sources_new (
    doc_id INTEGER NOT NULL REFERENCES documents_new(id),
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (doc_id, path)
  ) WITHOUT ROWID;
  CREATE TABLE section_reads_new (
    section_id INTEGER PRIMARY KEY REFERENCES doc_sections_new(id),
    version_id INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  INSERT INTO documents_new SELECT id, uid, repo_id, kind, scope, title, updated_at FROM documents;
  INSERT INTO doc_sections_new SELECT id, uid, doc_id, key, title, body, position, status, source, updated_at FROM doc_sections;
  INSERT INTO doc_section_records_new SELECT section_id, record_id FROM doc_section_records;
  INSERT INTO doc_versions_new SELECT id, section_id, at, actor_kind, actor, before, after FROM doc_versions;
  INSERT INTO doc_sources_new SELECT doc_id, path, hash, at FROM doc_sources;
  INSERT INTO section_reads_new SELECT section_id, version_id, at FROM section_reads;
  DROP TABLE section_reads;
  DROP TABLE doc_sources;
  DROP TABLE doc_versions;
  DROP TABLE doc_section_records;
  DROP TABLE doc_sections;
  DROP TABLE documents;
  ALTER TABLE documents_new RENAME TO documents;
  ALTER TABLE doc_sections_new RENAME TO doc_sections;
  ALTER TABLE doc_section_records_new RENAME TO doc_section_records;
  ALTER TABLE doc_versions_new RENAME TO doc_versions;
  ALTER TABLE doc_sources_new RENAME TO doc_sources;
  ALTER TABLE section_reads_new RENAME TO section_reads;
  CREATE INDEX doc_section_records_record ON doc_section_records(record_id);
  CREATE INDEX doc_versions_section ON doc_versions(section_id, at);
  `,
  // Spaced recall of exercises (#108 v2): a card per weak point the closing recall found, and one
  // for the whole exercise once it is done. stage indexes REVIEW_DAYS; a card past the last stage
  // is retired. Device-local like the exercises.
  `
  CREATE TABLE exercise_reviews (
    id INTEGER PRIMARY KEY,
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    prompt TEXT NOT NULL,
    whole INTEGER NOT NULL DEFAULT 0,
    stage INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    last_result TEXT CHECK (last_result IN ('right', 'partly', 'missed')),
    last_at INTEGER,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'dropped')),
    created_at INTEGER NOT NULL,
    UNIQUE (exercise_id, prompt)
  );
  CREATE INDEX exercise_reviews_due ON exercise_reviews(status, due_at);
  `,
];
const VERSION = MIGRATIONS.length;

/**
 * The fields a write reports to plugins (changed_, #106), per entity. Besides columns: a task's
 * epic (its key) and pointer (the 👉 record's uid); a record's task and parent; a section's
 * records (the contributing records) and source. "task" comes first: a reader new to a record needs it.
 */
const FIELDS = {
  repo: ["name"],
  task: ["title", "status", "summary", "epic", "pointer"],
  record: ["task", "kind", "owner", "status", "title", "body", "position", "parent", "links", "created_at"],
  section: ["title", "body", "position", "status", "records", "source"],
};
/** Design documents (#72) and the project glossary: kind → the title a new one gets. */
const DOC_KINDS = { architecture: "Architecture Design Document", product: "Product Design Document", glossary: "Project Glossary", social: "Social Media" };
/** A task's analysis document (TASK-ANALYSIS): one per task, its scope the task's key. */
const ANALYSIS = "analysis";
/** The title a new analysis document gets. @param {string} taskKey */
const analysisTitle = (taskKey) => `Analysis · ${taskKey}`;
/** A section source's path, at most. */
const SOURCE_MAX = 1000;
const SECTION_STATUSES = ["current", "superseded"];
/**
 * A section's body and title, at most (#72): the body JSON-encoded stays under 100,000
 * characters even when escaping doubles it, so a plugin can carry it as one value.
 */
const SECTION_BODY_MAX = 40_000;
const SECTION_TITLE_MAX = 300;
/** A section's key: a slug, unique in its document. */
const SECTION_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TASK_STATUSES = ["open", "active", "done", "dropped"];
const RECORD_STATUSES = ["open", "done", "dropped"];
const EXERCISE_STATUSES = ["active", "done", "dropped"];
const STEP_STATUSES = ["open", "done", "skipped"];
/**
 * What a step asks of the user (#108), in the order a good exercise uses them: learn a little,
 * study an example, predict, do it, vary or break it, explain it, recall it without notes.
 */
const EXERCISE_STEP_KINDS = ["learn", "example", "predict", "do", "vary", "explain", "recall"];
const EXERCISE_TITLE_MAX = 300;
const EXERCISE_TEXT_MAX = 4000;
const EXERCISE_STEPS_MAX = 60;
/** Days to the next recall at each stage (#108 v2): right moves a card one stage on, past the last it retires. */
const REVIEW_DAYS = [1, 3, 7, 14, 30, 60];
const REVIEW_RESULTS = ["right", "partly", "missed"];
const DAY_MS = 24 * 60 * 60 * 1000;
/** The end of the local day of a time: a recall due today is due all day. @param {number} at */
const endOfDay = (at) => {
  const d = new Date(at);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};
/** A text field of an exercise or step: trimmed, "" stored as nothing. @param {unknown} v @param {string} name @param {number} [max] */
function exText(v, name, max = EXERCISE_TEXT_MAX) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`Imprimatur: ${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw new Error(`Imprimatur: ${name} is longer than ${max} characters`);
  return t || undefined;
}
/** @param {unknown} v @param {string[]} allowed */
function exStatus(v, allowed) {
  if (typeof v !== "string" || !allowed.includes(v)) throw new Error(`Imprimatur: ${String(v)} is not one of ${allowed.join(", ")}`);
  return v;
}
/** @param {unknown} v */
function exMinutes(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 1 || /** @type {number} */ (v) > 600) throw new Error("Imprimatur: minutes must be a whole number from 1 to 600");
  return v;
}
/**
 * Weak points the closing recall found: short lines, or cards {front, back, deck} a flashcard
 * plugin can take (deck: the group it goes in, e.g. a roadmap). @param {unknown} v
 */
function exWeak(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 30) throw new Error("Imprimatur: weak must be a list of at most 30 lines");
  return v.map((x) => {
    if (x === null || typeof x !== "object" || Array.isArray(x)) return exText(x, "a weak point", EXERCISE_TITLE_MAX);
    const front = exText(x.front, "a weak point's front", EXERCISE_TITLE_MAX);
    if (!front) return undefined;
    const back = exText(x.back, "a weak point's back");
    const deck = exText(x.deck, "a weak point's deck", EXERCISE_TITLE_MAX);
    return { front, ...(back && { back }), ...(deck && { deck }) };
  }).filter(Boolean);
}
/** A weak point's line: the card's front. @param {string | {front: string}} w */
const weakText = (w) => (typeof w === "string" ? w : w.front);

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

/**
 * The device's database path: IMPRIMATUR_DB, else the platform's data folder. Under
 * `node --test` (NODE_TEST_CONTEXT) without IMPRIMATUR_DB: a temp file, never the real
 * database; set in process.env too, so the hooks a test spawns share it.
 */
function dbPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.IMPRIMATUR_DB) return env.IMPRIMATUR_DB;
  if (env.NODE_TEST_CONTEXT) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `imprimatur-test-${process.pid}-`)), "imprimatur.db");
    env.IMPRIMATUR_DB = file;
    return file;
  }
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
    /** The plugins loaded for this database (openDb, #106). @type {any[]} */
    this.plugins = [];
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
      if (row) {
        if (row.origin || !origin) return row;
        this.q("UPDATE repos SET origin = ? WHERE id = ?").run(info.origin, row.id);
        const learnt = this.q("SELECT * FROM repos WHERE id = ?").get(row.id);
        for (const p of this.plugins) if (p.onOrigin) this.guard_(p, () => p.onOrigin(this, learnt));
        return this.q("SELECT * FROM repos WHERE id = ?").get(row.id);
      }
      // A plugin may already hold a row for this origin (one known only from elsewhere): it becomes this root's.
      const adopt = origin ? this.ask_("adoptRepo", origin) : undefined;
      if (adopt) {
        this.q("UPDATE repos SET root = ?, name = ? WHERE id = ?").run(root, info.name ?? path.basename(root), adopt.id);
        return this.q("SELECT * FROM repos WHERE id = ?").get(adopt.id);
      }
      this.q("INSERT OR IGNORE INTO repos (uid, root, origin, name, created_at) VALUES (?, ?, ?, ?, ?)").run(
        uid(), root, info.origin ?? null, info.name ?? path.basename(root), Date.now(),
      );
      const made = this.q("SELECT * FROM repos WHERE root = ?").get(root);
      this.changed_("repo", made, FIELDS.repo, Date.now());
      return made;
    });
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
      this.changed_("task", after, FIELDS.task.filter((f) => !before || before[col[f]] !== after[col[f]]), now);
      if (before?.status !== after.status && CLOSED.has(after.status)) this.closeEpicLines_(after, actor, now);
      // done ↔ dropped changes no issue, unless its close is still waiting (the reason changes).
      const crosses = before && before.status !== after.status
        && (CLOSED.has(before.status) !== CLOSED.has(after.status) || this.trackerPending(after.id));
      if (crosses && actor?.kind !== "import" && TRACKER_KEY.test(key)) {
        const action = after.status === "done" ? "close_done" : after.status === "dropped" ? "close_dropped" : "reopen";
        // The latest change wins: a close then a reopen before the push is one reopen.
        // No comment text kept: the tracker gets a fixed one (no summary leaks to an issue).
        this.q("DELETE FROM tracker_outbox WHERE task_id = ?").run(after.id);
        this.q("INSERT INTO tracker_outbox (task_id, action, at) VALUES (?, ?, ?)").run(after.id, action, now);
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
    const note = `${task.key} ${task.status === "dropped" ? "dropped" : "done"} (${day(now)})`;
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

  /** One more failed try that counts (4xx); returns how many. Releases the claim. @param {number} id @returns {number} */
  trackerFailed(id) {
    this.q("UPDATE tracker_outbox SET tries = tries + 1, claimed_at = NULL, claimant = NULL WHERE id = ?").run(id);
    return /** @type {any} */ (this.q("SELECT tries FROM tracker_outbox WHERE id = ?").get(id))?.tries ?? 0;
  }

  /**
   * A transient failure (network, 5xx, 429): not counted against the row; it waits
   * min(30 s · 2^fails, 30 min) before the next try. @param {number} id @param {number} now
   */
  trackerBackoff(id, now) {
    const fails = (/** @type {any} */ (this.q("SELECT fails FROM tracker_outbox WHERE id = ?").get(id))?.fails ?? 0) + 1;
    this.q("UPDATE tracker_outbox SET fails = ?, next_at = ?, claimed_at = NULL, claimant = NULL WHERE id = ?")
      .run(fails, now + Math.min(30_000 * 2 ** (fails - 1), 30 * 60_000), id);
  }

  /** The row's comment is posted (a retry does not post it again). @param {number} id */
  trackerCommented(id) {
    this.q("UPDATE tracker_outbox SET commented = 1 WHERE id = ?").run(id);
  }

  /**
   * Takes a row for one run, so two windows do not push it twice; a claim older than
   * 2 minutes (its run died) can be taken over. @param {number} id @param {string} claimant @param {number} now
   */
  trackerClaim(id, claimant, now) {
    return this.q(`UPDATE tracker_outbox SET claimed_at = ?, claimant = ?
                   WHERE id = ? AND (claimed_at IS NULL OR claimed_at < ? OR claimant = ?)`).run(now, claimant, id, now - 120_000, claimant).changes === 1;
  }

  /** @param {number} id */
  trackerRelease(id) {
    this.q("UPDATE tracker_outbox SET claimed_at = NULL, claimant = NULL WHERE id = ?").run(id);
  }

  /** Queued pushes of a repo's tasks. @param {number} repoId */
  trackerRowsOf(repoId) {
    return this.q(`SELECT o.*, t.key FROM tracker_outbox o JOIN tasks t ON t.id = o.task_id WHERE t.repo_id = ? ORDER BY o.id`).all(repoId);
  }

  /** Issue states at the last pull: key → state. @param {number} repoId @param {string} provider @returns {Map<string, string>} */
  trackerStates(repoId, provider) {
    return new Map(this.q("SELECT key, state FROM tracker_state WHERE repo_id = ? AND provider = ?").all(repoId, provider).map((/** @type {any} */ r) => [r.key, r.state]));
  }

  /** @param {number} repoId @param {string} key @param {string} provider @param {string} state @param {number} at */
  setTrackerState(repoId, key, provider, state, at) {
    this.q(`INSERT INTO tracker_state (repo_id, key, provider, state, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (repo_id, key) DO UPDATE SET provider = excluded.provider, state = excluded.state, at = excluded.at`).run(repoId, key, provider, state, at);
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
      this.changed_("record", id, FIELDS.record, now);
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
      const named = fields.map((f) => (f === "parent_id" ? "parent" : f));
      // A record that is no longer open cannot be where we left off.
      if (old.pointer && after.status && after.status !== "open") {
        this.q("UPDATE records SET pointer = 0 WHERE id = ?").run(id);
        this.version_(id, actor, "update", { pointer: true }, { pointer: false }, now);
        this.changed_("task", this.taskById(old.task_id), ["pointer"], now);
      }
      this.changed_("record", id, named, now);
      return this.record(id);
    });
  }

  /**
   * Moves a record to another task of the same repo (#87: AUDIT and BEST into RECS). A 👉 on
   * it goes when the task it moves to has one; the move is versioned and reported ("task").
   * @param {number} id @param {number} taskId @param {Actor} actor
   */
  moveRecord(id, taskId, actor) {
    return this.tx(() => {
      const rec = /** @type {any} */ (this.record(id));
      if (!rec) throw new Error(`Imprimatur: no record ${id}`);
      const from = this.taskById(rec.task_id);
      const to = this.taskById(taskId);
      if (!to || to.repo_id !== from?.repo_id) throw new Error(`Imprimatur: record ${id} can move only to a task of its repo`);
      if (to.id === rec.task_id) return rec;
      const now = Date.now();
      if (rec.pointer && this.q("SELECT 1 FROM records WHERE task_id = ? AND pointer = 1").get(to.id)) {
        this.q("UPDATE records SET pointer = 0 WHERE id = ?").run(id);
      }
      // Last in the task it moves to: its old position means nothing there.
      const position = /** @type {any} */ (this.q("SELECT coalesce(max(position), 0) + 1 AS p FROM records WHERE task_id = ?").get(to.id)).p;
      this.q("UPDATE records SET task_id = ?, position = ?, updated_at = ? WHERE id = ?").run(to.id, position, now, id);
      this.version_(id, actor, "update", { task: from.key, position: rec.position }, { task: to.key, position }, now);
      this.changed_("record", id, ["task", "position"], now);
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
        this.changed_("task", this.taskById(this.q("SELECT task_id FROM records WHERE id = ?").get(id).task_id), ["pointer"], now);
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
    this.changed_("task", this.taskById(rec.task_id), ["pointer"], now);
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
   * The task one agent session was on at a time: the last it wrote a record of by then,
   * else the first it wrote one of after (TASK-ANALYSIS). Special tasks (ADR, PDR, …) do not count.
   * @param {number} repoId @param {string} session @param {number} [at] default now
   * @returns {string | undefined}
   */
  sessionTaskAt(repoId, session, at = Date.now()) {
    if (!session) return undefined;
    const sql = (/** @type {string} */ cmp, /** @type {string} */ dir) => `SELECT t.key FROM record_versions v
                 JOIN records r ON r.id = v.record_id JOIN tasks t ON t.id = r.task_id
                 WHERE t.repo_id = ? AND v.actor_kind = 'agent' AND v.actor LIKE ? AND v.at ${cmp} ?
                   AND t.key NOT IN ('ADR', 'PDR', 'TEST', 'AUDIT', 'BEST', 'RECS')
                 ORDER BY v.at ${dir} LIMIT 1`;
    const like = `%:${session.replace(/[%_]/g, "")}`;
    return this.q(sql("<=", "DESC")).get(repoId, like, at)?.key ?? this.q(sql(">", "ASC")).get(repoId, like, at)?.key;
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
   * The record containers (ADR, PDR, TEST from the importer, #59; AUDIT, #77; BEST, #86) are no work: left out
   * unless someone put a 👉 in one (#75).
   * @param {number} repoId
   */
  whereWeLeftOff(repoId) {
    return this.q(`SELECT t.key, t.title, t.status, t.summary,
                     p.id AS pointer_id, p.kind AS pointer_kind, p.owner AS pointer_owner, p.title AS pointer_title,
                     (SELECT count(*) FROM records o WHERE o.task_id = t.id AND o.status = 'open') AS open_records
                   FROM tasks t LEFT JOIN records p ON p.task_id = t.id AND p.pointer = 1
                   WHERE t.repo_id = ? AND t.status IN ('open', 'active')
                     AND (t.key NOT IN ('ADR', 'PDR', 'TEST', 'AUDIT', 'BEST', 'RECS') OR p.id IS NOT NULL)
                   ORDER BY t.updated_at DESC LIMIT 100`).all(repoId);
  }

  /**
   * How a repo's design documents stand (#74): per kind its current sections and the ADRs
   * (architecture) or PDRs (product), not dropped, that no current section links. The
   * glossary has no record kind of its own: its unlinked is always 0.
   * @param {number} repoId @returns {Record<string, {sections: number, unlinked: number}>}
   */
  docHealth(repoId) {
    /** @type {Record<string, {sections: number, unlinked: number}>} */
    const out = {};
    for (const [kind, rk] of /** @type {const} */ ([["architecture", "adr"], ["product", "pdr"], ["glossary", null]])) {
      const doc = this.docFind(repoId, kind);
      const sections = doc ? this.q("SELECT count(*) AS n FROM doc_sections WHERE doc_id = ? AND status = 'current'").get(doc.id).n : 0;
      const unlinked = rk === null ? 0 : this.q(`SELECT count(*) AS n FROM records r JOIN tasks t ON t.id = r.task_id
                               WHERE t.repo_id = ? AND r.kind = ? AND r.status != 'dropped'
                                 AND NOT EXISTS (SELECT 1 FROM doc_section_records l JOIN doc_sections s ON s.id = l.section_id
                                                 WHERE l.record_id = r.id AND s.status = 'current')`).get(repoId, rk).n;
      out[kind] = { sections, unlinked };
    }
    return out;
  }

  /**
   * The ADRs or PDRs, not dropped, that no current section of a document links (docHealth's
   * unlinked, one row each), oldest first. @param {number} repoId @param {"adr" | "pdr"} kind
   */
  unlinkedRecords(repoId, kind) {
    return this.q(`SELECT r.id, r.kind, r.title, r.body, t.key AS task FROM records r JOIN tasks t ON t.id = r.task_id
                   WHERE t.repo_id = ? AND r.kind = ? AND r.status != 'dropped'
                     AND NOT EXISTS (SELECT 1 FROM doc_section_records l JOIN doc_sections s ON s.id = l.section_id
                                     WHERE l.record_id = r.id AND s.status = 'current')
                   ORDER BY r.id`).all(repoId, kind);
  }

  /** How many records a repo has. @param {number} repoId @returns {number} */
  recordCount(repoId) {
    return Number(this.q("SELECT count(*) AS n FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ?").get(repoId).n);
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

  // ---- Design documents (#72) ----

  /** A repo's document of this kind, without creating it. @param {number} repoId @param {string} kind */
  docFind(repoId, kind) {
    return this.q("SELECT * FROM documents WHERE repo_id = ? AND kind = ? AND scope = ''").get(repoId, kind);
  }

  /** A task's analysis document, without creating it. @param {number} repoId @param {string} taskKey */
  taskDocFind(repoId, taskKey) {
    return this.q("SELECT * FROM documents WHERE repo_id = ? AND kind = 'analysis' AND scope = ?").get(repoId, taskKey);
  }

  /** A task's analysis document, created on first use. @param {number} repoId @param {string} taskKey */
  taskDocOf(repoId, taskKey) {
    if (typeof taskKey !== "string" || !taskKey.trim() || taskKey.includes("\t")) throw new Error("Imprimatur: an analysis needs a task key");
    const found = this.taskDocFind(repoId, taskKey);
    if (found) return found;
    return this.tx(() => {
      this.q("INSERT OR IGNORE INTO documents (uid, repo_id, kind, scope, title, updated_at) VALUES (?, ?, 'analysis', ?, ?, ?)")
        .run(uid(), repoId, taskKey, analysisTitle(taskKey), Date.now());
      return this.taskDocFind(repoId, taskKey);
    });
  }

  /** A repo's analysis documents with their current section count, newest first. @param {number} repoId */
  taskDocs(repoId) {
    return this.q(`SELECT d.*, (SELECT count(*) FROM doc_sections s WHERE s.doc_id = d.id AND s.status = 'current') AS sections
                   FROM documents d WHERE d.repo_id = ? AND d.kind = 'analysis' ORDER BY d.updated_at DESC`).all(repoId);
  }

  /** The hash of a file's text as last ingested into a document. @param {number} docId @param {string} file */
  docSourceHash(docId, file) {
    return this.q("SELECT hash FROM doc_sources WHERE doc_id = ? AND path = ?").get(docId, file)?.hash;
  }

  /** The files a document was read from, newest first. @param {number} docId */
  docSourceFiles(docId) {
    return this.q("SELECT path, hash, at FROM doc_sources WHERE doc_id = ? ORDER BY at DESC").all(docId);
  }

  /** @param {number} docId @param {string} file @param {string} hash @param {number} at */
  setDocSource(docId, file, hash, at) {
    this.q(`INSERT INTO doc_sources (doc_id, path, hash, at) VALUES (?, ?, ?, ?)
            ON CONFLICT (doc_id, path) DO UPDATE SET hash = excluded.hash, at = max(doc_sources.at, excluded.at)`).run(docId, file, hash, at);
  }

  /** @param {number} id */
  docById(id) {
    return this.q("SELECT * FROM documents WHERE id = ?").get(id);
  }

  /**
   * A repo's document of this kind, created on first use with its default title.
   * @param {number} repoId @param {string} kind "architecture" | "product" | "glossary"
   */
  docOf(repoId, kind) {
    if (!Object.hasOwn(DOC_KINDS, kind)) throw new Error(`Imprimatur: document kind must be one of ${Object.keys(DOC_KINDS).join(", ")}`);
    const found = this.docFind(repoId, kind);
    if (found) return found;
    return this.tx(() => {
      const now = Date.now();
      this.q("INSERT OR IGNORE INTO documents (uid, repo_id, kind, title, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(uid(), repoId, kind, /** @type {any} */ (DOC_KINDS)[kind], now);
      return this.docFind(repoId, kind);
    });
  }

  /**
   * A document's sections by position, each with its contributing record ids (records) and
   * those records' kind, title, status and task (contributors).
   * @param {number} docId
   */
  docSections(docId) {
    const links = this.q(`SELECT l.section_id, r.id, r.uid, r.kind, r.title, r.status, r.task_id, t.key AS task_key
                          FROM doc_section_records l JOIN doc_sections s ON s.id = l.section_id
                          JOIN records r ON r.id = l.record_id JOIN tasks t ON t.id = r.task_id
                          WHERE s.doc_id = ? ORDER BY r.id`).all(docId);
    const out = this.q("SELECT * FROM doc_sections WHERE doc_id = ? ORDER BY position, id").all(docId).map((/** @type {any} */ s) => {
      const mine = links.filter((/** @type {any} */ l) => l.section_id === s.id).map(({ section_id, ...r }) => r);
      return { ...s, records: mine.map((r) => r.id), contributors: mine };
    });
    // The glossary reads alphabetically, whatever order its terms were written in.
    if (this.docById(docId)?.kind === "glossary") out.sort((a, b) => a.title.localeCompare(b.title, "tr", { sensitivity: "base" }) || a.id - b.id);
    return out;
  }

  /** One section with its records, by document and key. @param {number} docId @param {string} key */
  docSection(docId, key) {
    const row = this.q("SELECT id FROM doc_sections WHERE doc_id = ? AND key = ?").get(docId, key);
    return row ? this.sectionById(row.id) : undefined;
  }

  /** @param {number} id */
  sectionById(id) {
    const s = this.q("SELECT * FROM doc_sections WHERE id = ?").get(id);
    if (!s) return undefined;
    const records = this.q("SELECT record_id FROM doc_section_records WHERE section_id = ? ORDER BY record_id").all(id).map((/** @type {any} */ r) => r.record_id);
    return { ...s, records };
  }

  /** The sections a record contributes to, with their document's kind. @param {number} recordId */
  sectionsOfRecord(recordId) {
    return this.q(`SELECT s.*, d.kind AS doc_kind FROM doc_section_records l JOIN doc_sections s ON s.id = l.section_id
                   JOIN documents d ON d.id = s.doc_id WHERE l.record_id = ? ORDER BY s.id`).all(recordId);
  }

  /**
   * Creates the section or changes the given fields, with a version row of what changed
   * (no row, no write when nothing did). records: the contributing record ids, replacing
   * those linked; addRecords: ids linked besides them. A record must be of the document's repo.
   * @param {number} docId @param {string} key a slug, unique in the document
   * source: the file the section was read from (a task's analysis). at: when the change was
   * made, for one replayed from the past (default now).
   * @param {{title?: string, body?: string | null, position?: number, status?: string, records?: number[], addRecords?: number[], source?: string | null}} fields
   * @param {Actor} actor @param {{at?: number}} [o]
   */
  upsertSection(docId, key, fields, actor, { at } = {}) {
    if (!ACTORS.includes(actor?.kind)) throw new Error(`Imprimatur: actor kind must be one of ${ACTORS.join(", ")}`);
    if (typeof key !== "string" || !SECTION_KEY.test(key)) throw new Error(`Imprimatur: section key "${key}" must be a slug: a-z, 0-9 and -, at most 64 characters`);
    if (fields.status !== undefined && !SECTION_STATUSES.includes(fields.status)) throw new Error(`Imprimatur: section status must be one of ${SECTION_STATUSES.join(", ")}`);
    if (fields.position !== undefined && !Number.isFinite(fields.position)) throw new Error("Imprimatur: section position must be a number");
    if (fields.title !== undefined && (typeof fields.title !== "string" || !fields.title.trim())) throw new Error("Imprimatur: section title must be a non-empty string");
    if (fields.title !== undefined && fields.title.trim().length > SECTION_TITLE_MAX) throw new Error(`Imprimatur: section title is over ${SECTION_TITLE_MAX} chars`);
    if (fields.body != null && (typeof fields.body !== "string" || fields.body.length > SECTION_BODY_MAX)) {
      throw new Error(`Imprimatur: section body is ${String(fields.body).length} chars; the limit is ${SECTION_BODY_MAX}. Split it into sections.`);
    }
    if (fields.source != null && (typeof fields.source !== "string" || fields.source.length > SOURCE_MAX)) throw new Error(`Imprimatur: section source must be a path of at most ${SOURCE_MAX} chars`);
    if (at !== undefined && !Number.isSafeInteger(at)) throw new Error("Imprimatur: at must be a time in ms");
    return this.tx(() => {
      const doc = this.docById(docId);
      if (!doc) throw new Error(`Imprimatur: no document ${docId}`);
      for (const id of [...(fields.records ?? []), ...(fields.addRecords ?? [])]) {
        const rec = this.q("SELECT t.repo_id FROM records r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?").get(id);
        if (!rec) throw new Error(`Imprimatur: no record ${id}`);
        if (rec.repo_id !== doc.repo_id) throw new Error(`Imprimatur: record ${id} is in another repo than this document`);
      }
      const now = at ?? Date.now();
      let old = this.docSection(docId, key);
      /** @type {Record<string, any>} */ const before = {};
      /** @type {Record<string, any>} */ const after = {};
      if (!old) {
        if (fields.title === undefined) throw new Error(`Imprimatur: a new section needs a title (key ${key})`);
        const position = fields.position
          ?? /** @type {any} */ (this.q("SELECT coalesce(max(position), 0) + 1 AS p FROM doc_sections WHERE doc_id = ?").get(docId)).p;
        this.q(`INSERT INTO doc_sections (uid, doc_id, key, title, body, position, status, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(uid(), docId, key, fields.title.trim(), fields.body ?? null, position, fields.status ?? "current", fields.source ?? null, now);
        old = /** @type {any} */ (this.docSection(docId, key));
        Object.assign(after, { key, title: old.title, body: old.body, position: old.position, status: old.status });
        if (old.source != null) after.source = old.source;
      } else {
        for (const f of /** @type {const} */ (["title", "body", "position", "status", "source"])) {
          if (fields[f] === undefined) continue;
          const v = f === "title" ? /** @type {string} */ (fields.title).trim() : fields[f] ?? null;
          if (old[f] === v) continue;
          before[f] = old[f];
          after[f] = v;
          this.q(`UPDATE doc_sections SET ${f} = ? WHERE id = ?`).run(v, old.id);
        }
      }
      const was = old.records;
      const want = [...new Set([...(fields.records ?? was), ...(fields.addRecords ?? [])])].sort((a, b) => a - b);
      if (JSON.stringify(was) !== JSON.stringify(want)) {
        this.q("DELETE FROM doc_section_records WHERE section_id = ?").run(old.id);
        for (const id of want) this.q("INSERT INTO doc_section_records (section_id, record_id) VALUES (?, ?)").run(old.id, id);
        if (was.length || Object.keys(before).length) before.records = was;
        after.records = want;
      }
      const changed = Object.keys(after).filter((f) => f !== "key");
      if (!changed.length) return this.sectionById(old.id);
      this.q("UPDATE doc_sections SET updated_at = max(updated_at, ?) WHERE id = ?").run(now, old.id);
      this.q("UPDATE documents SET updated_at = max(updated_at, ?) WHERE id = ?").run(now, docId);
      this.q("INSERT INTO doc_versions (section_id, at, actor_kind, actor, before, after) VALUES (?, ?, ?, ?, ?, ?)")
        .run(old.id, now, actor.kind, actor.id ?? null, Object.keys(before).length ? JSON.stringify(before) : null, JSON.stringify(after));
      this.changed_("section", old.id, changed, now);
      // What the user wrote they have read.
      if (actor.kind === "user") this.markSectionsRead([old.id], now);
      return this.sectionById(old.id);
    });
  }

  /** A section's versions, newest first. @param {number} sectionId */
  sectionVersions(sectionId) {
    return this.q("SELECT * FROM doc_versions WHERE section_id = ? ORDER BY id DESC").all(sectionId).map((/** @type {any} */ v) => ({
      ...v, before: v.before ? JSON.parse(v.before) : null, after: v.after ? JSON.parse(v.after) : null,
    }));
  }

  /** The user read these sections now (#92). @param {number[]} ids @param {number} [at] */
  markSectionsRead(ids, at = Date.now()) {
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error("Imprimatur: section ids must be positive integers");
    this.tx(() => {
      for (const id of ids) {
        if (!this.q("SELECT 1 FROM doc_sections WHERE id = ?").get(id)) throw new Error(`Imprimatur: no section ${id}`);
        const v = this.q("SELECT coalesce(max(id), 0) AS v FROM doc_versions WHERE section_id = ?").get(id).v;
        this.q(`INSERT INTO section_reads (section_id, version_id, at) VALUES (?, ?, ?)
                ON CONFLICT (section_id) DO UPDATE SET version_id = max(version_id, excluded.version_id), at = max(at, excluded.at)`).run(id, v, at);
      }
    });
  }

  /**
   * The repo's current sections the agent or a hook changed (title or text) since the user last
   * read them (#92), newest first. A change an import made (say another device's, through a plugin) is not counted:
   * reads are this device's. tasks: the task a task's analysis is of, and the tasks of the
   * records those changes linked.
   * @param {number} repoId
   * @returns {Array<{id: number, doc_id: number, key: string, title: string, kind: string, scope: string, changed_at: number, tasks: string[]}>}
   */
  unreadSections(repoId) {
    const rows = this.q(`SELECT s.id, s.doc_id, s.key, s.title, d.kind, d.scope, v.at, v.before, v.after
      FROM doc_sections s JOIN documents d ON d.id = s.doc_id JOIN doc_versions v ON v.section_id = s.id
      LEFT JOIN section_reads r ON r.section_id = s.id
      WHERE d.repo_id = ? AND s.status = 'current' AND v.actor_kind IN ('agent', 'hook') AND v.id > coalesce(r.version_id, 0)
        AND (json_type(v.after, '$.body') IS NOT NULL OR json_type(v.after, '$.title') IS NOT NULL)
      ORDER BY v.id DESC`).all(repoId);
    /** @type {Map<number, any>} */
    const out = new Map();
    /** @type {Map<number, string | undefined>} */
    const keyOf = new Map();
    const taskOfRecord = (/** @type {number} */ id) => {
      if (!keyOf.has(id)) keyOf.set(id, this.q("SELECT t.key FROM records r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?").get(id)?.key);
      return keyOf.get(id);
    };
    for (const v of /** @type {any[]} */ (rows)) {
      const s = out.get(v.id) ?? { id: v.id, doc_id: v.doc_id, key: v.key, title: v.title, kind: v.kind, scope: v.scope, changed_at: v.at, tasks: v.scope ? [v.scope] : [] };
      out.set(v.id, s);
      const was = new Set(JSON.parse(v.before ?? "{}").records ?? []);
      for (const id of JSON.parse(v.after).records ?? []) {
        const key = was.has(id) ? undefined : taskOfRecord(id);
        if (key && !s.tasks.includes(key)) s.tasks.push(key);
      }
    }
    return [...out.values()];
  }

  /** The document's last change: when and by whom. @param {number} docId */
  docLastChange(docId) {
    return this.q(`SELECT v.at, v.actor_kind, v.actor FROM doc_versions v JOIN doc_sections s ON s.id = v.section_id
                   WHERE s.doc_id = ? ORDER BY v.id DESC LIMIT 1`).get(docId);
  }

  // ---- Exercises (#108): the user's own, of no repo ----

  /**
   * Creates an exercise (no id) or changes one, with its steps: a step with an id is changed, one
   * without is added (after the last, or under parent_id when it splits a step). Steps are never
   * deleted: a step not wanted is "skipped".
   * @param {{id?: number, topic?: string, goal?: string, proof?: string, context?: string, weak?: string[], status?: string, steps?: any[]}} fields
   */
  saveExercise(fields) {
    const now = Date.now();
    return this.tx(() => {
      let id = fields.id;
      if (id === undefined) {
        const topic = exText(fields.topic, "topic", EXERCISE_TITLE_MAX);
        if (!topic) throw new Error("Imprimatur: an exercise needs a topic");
        id = Number(this.q(`INSERT INTO exercises (uid, topic, goal, proof, context, weak, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(uid(), topic, exText(fields.goal, "goal") ?? null, exText(fields.proof, "proof") ?? null, exText(fields.context, "context") ?? null,
            json(exWeak(fields.weak)), exStatus(fields.status ?? "active", EXERCISE_STATUSES), now, now).lastInsertRowid);
        if (fields.weak) this.syncWeakReviews(id, exWeak(fields.weak) ?? [], now);
      } else {
        if (!this.q("SELECT 1 FROM exercises WHERE id = ?").get(id)) throw new Error(`Imprimatur: no exercise ${id}`);
        const set = [];
        const args = [];
        for (const k of ["topic", "goal", "proof", "context"]) {
          if (fields[/** @type {"topic"} */ (k)] === undefined) continue;
          const v = exText(fields[/** @type {"topic"} */ (k)], k, k === "topic" ? EXERCISE_TITLE_MAX : undefined);
          if (k === "topic" && !v) throw new Error("Imprimatur: an exercise needs a topic");
          set.push(`${k} = ?`);
          args.push(v ?? null);
        }
        if (fields.weak !== undefined) set.push("weak = ?"), args.push(json(exWeak(fields.weak)));
        if (fields.weak !== undefined) this.syncWeakReviews(id, exWeak(fields.weak) ?? [], now);
        if (fields.status !== undefined) set.push("status = ?"), args.push(exStatus(fields.status, EXERCISE_STATUSES));
        this.q(`UPDATE exercises SET ${[...set, "updated_at = ?"].join(", ")} WHERE id = ?`).run(...args, now, id);
      }
      // A plugin hears of new weak points (flashcards), after the recall cards above.
      if (fields.weak !== undefined && fields.weak !== null) this.changed_("exercise", id, ["weak"], now);
      const steps = fields.steps ?? [];
      if (!Array.isArray(steps) || steps.length > EXERCISE_STEPS_MAX) throw new Error(`Imprimatur: steps must be a list of at most ${EXERCISE_STEPS_MAX}`);
      for (const s of steps) this.saveStep(/** @type {number} */ (id), s, now);
      // done/active follow the steps, whatever the call said; dropped stays.
      this.settleExercise(/** @type {number} */ (id), now);
      return this.exercise(/** @type {number} */ (id));
    });
  }

  /** One step of an exercise, added or changed. @param {number} exerciseId @param {any} s @param {number} now */
  saveStep(exerciseId, s, now) {
    if (!s || typeof s !== "object") throw new Error("Imprimatur: a step must be an object");
    if (s.id == null) {
      const title = exText(s.title, "step title", EXERCISE_TITLE_MAX);
      if (!title) throw new Error("Imprimatur: a step needs a title");
      let position;
      if (s.parent_id != null) {
        if (!Number.isSafeInteger(s.parent_id)) throw new Error("Imprimatur: parent_id must be a step id");
        const parent = this.q("SELECT * FROM exercise_steps WHERE id = ? AND exercise_id = ?").get(s.parent_id, exerciseId);
        if (!parent) throw new Error(`Imprimatur: no step ${s.parent_id} in exercise ${exerciseId}`);
        if (parent.parent_id) throw new Error("Imprimatur: a smaller step is not split again; add another step under the same one");
        position = (this.q("SELECT max(position) AS p FROM exercise_steps WHERE parent_id = ?").get(s.parent_id).p ?? 0) + 1;
      } else position = (this.q("SELECT max(position) AS p FROM exercise_steps WHERE exercise_id = ? AND parent_id IS NULL").get(exerciseId).p ?? 0) + 1;
      if (s.position != null && (typeof s.position !== "number" || !Number.isFinite(s.position))) throw new Error("Imprimatur: position must be a number");
      const status = exStatus(s.status ?? "open", STEP_STATUSES);
      this.q(`INSERT INTO exercise_steps (exercise_id, parent_id, position, kind, title, why, done_when, minutes, status, note, done_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(exerciseId, s.parent_id ?? null, s.position ?? position, exStatus(s.kind ?? "do", EXERCISE_STEP_KINDS), title, exText(s.why, "why") ?? null,
          exText(s.done_when, "done_when") ?? null, exMinutes(s.minutes), status, exText(s.note, "note") ?? null, status === "done" ? now : null, now);
      return;
    }
    const step = this.q("SELECT * FROM exercise_steps WHERE id = ? AND exercise_id = ?").get(s.id, exerciseId);
    if (!step) throw new Error(`Imprimatur: no step ${s.id} in exercise ${exerciseId}`);
    this.updateStep(s.id, s, now);
  }

  /**
   * A step changed: ticked, skipped, opened again, a note; its exercise's progress follows
   * (settleExercise). @param {number} id @param {any} patch @param {number} [now]
   */
  updateStep(id, patch, now = Date.now()) {
    return this.tx(() => {
      const step = this.q("SELECT * FROM exercise_steps WHERE id = ?").get(id);
      if (!step) throw new Error(`Imprimatur: no step ${id}`);
      const set = [];
      const args = [];
      for (const k of ["title", "why", "done_when", "note"]) {
        if (patch[k] === undefined) continue;
        const v = exText(patch[k], k, k === "title" ? EXERCISE_TITLE_MAX : undefined);
        if (k === "title" && !v) throw new Error("Imprimatur: a step needs a title");
        set.push(`${k} = ?`);
        args.push(v ?? null);
      }
      if (patch.kind !== undefined) set.push("kind = ?"), args.push(exStatus(patch.kind, EXERCISE_STEP_KINDS));
      if (patch.minutes !== undefined) set.push("minutes = ?"), args.push(exMinutes(patch.minutes));
      if (patch.position !== undefined) {
        if (typeof patch.position !== "number" || !Number.isFinite(patch.position)) throw new Error("Imprimatur: position must be a number");
        set.push("position = ?"), args.push(patch.position);
      }
      if (patch.status !== undefined) {
        const status = exStatus(patch.status, STEP_STATUSES);
        set.push("status = ?", "done_at = ?");
        args.push(status, status === "done" ? (step.status === "done" ? step.done_at : now) : null);
      }
      this.q(`UPDATE exercise_steps SET ${[...set, "updated_at = ?"].join(", ")} WHERE id = ?`).run(...args, now, id);
      if (patch.status !== undefined) this.settleExercise(step.exercise_id, now);
      else this.q("UPDATE exercises SET updated_at = ? WHERE id = ?").run(now, step.exercise_id);
      return this.q("SELECT * FROM exercise_steps WHERE id = ?").get(id);
    });
  }

  /**
   * A split step is done when its smaller steps all are (done or skipped), open again when one
   * is; an exercise is done when its steps all are, active again when one opens.
   * @param {number} exerciseId @param {number} now
   */
  settleExercise(exerciseId, now) {
    const steps = this.q("SELECT id, parent_id, status FROM exercise_steps WHERE exercise_id = ?").all(exerciseId);
    const closed = (/** @type {any} */ s) => s.status !== "open";
    for (const p of steps.filter((/** @type {any} */ s) => !s.parent_id)) {
      const kids = steps.filter((/** @type {any} */ s) => s.parent_id === p.id);
      if (!kids.length || p.status === "skipped") continue;
      const want = kids.every(closed) ? "done" : "open";
      if (p.status !== want) {
        this.q("UPDATE exercise_steps SET status = ?, done_at = ?, updated_at = ? WHERE id = ?").run(want, want === "done" ? now : null, now, p.id);
        p.status = want;
      }
    }
    const ex = this.q("SELECT status, topic FROM exercises WHERE id = ?").get(exerciseId);
    const top = steps.filter((/** @type {any} */ s) => !s.parent_id);
    const want = ex.status === "dropped" ? "dropped" : top.length && top.every(closed) ? "done" : "active";
    this.q("UPDATE exercises SET status = ?, updated_at = ? WHERE id = ?").run(want, now, exerciseId);
    // Done: the whole exercise comes back for recall, tomorrow first (once; kept if it reopens).
    if (want === "done" && ex.status !== "done") {
      this.q(`INSERT OR IGNORE INTO exercise_reviews (exercise_id, prompt, whole, due_at, created_at) VALUES (?, ?, 1, ?, ?)`)
        .run(exerciseId, `Recall the whole exercise without notes: ${ex.topic}`, now + REVIEW_DAYS[0] * DAY_MS, now);
    }
  }

  /**
   * The weak points as recall cards (#108 v2): a new one is due tomorrow; one no longer in the list
   * is dropped (a card already answered keeps its history). A card's front is its prompt.
   * @param {number} exerciseId @param {(string | {front: string})[]} weak @param {number} now
   */
  syncWeakReviews(exerciseId, cards, now) {
    const weak = cards.map(weakText);
    for (const w of weak) {
      this.q(`INSERT INTO exercise_reviews (exercise_id, prompt, due_at, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (exercise_id, prompt) DO UPDATE SET status = 'active' WHERE status = 'dropped'`).run(exerciseId, w, now + REVIEW_DAYS[0] * DAY_MS, now);
    }
    const keep = new Set(weak);
    for (const r of this.q("SELECT id, prompt FROM exercise_reviews WHERE exercise_id = ? AND whole = 0 AND status = 'active'").all(exerciseId)) {
      if (!keep.has(r.prompt)) this.q("UPDATE exercise_reviews SET status = 'dropped' WHERE id = ?").run(r.id);
    }
  }

  /**
   * Recall cards, soonest first, with their exercise's topic: due ones (by the end of today) or,
   * with upcoming, every active one. A dropped exercise's cards are left out.
   * @param {{upcoming?: boolean, now?: number, limit?: number}} [o]
   */
  reviews({ upcoming = false, now = Date.now(), limit = 50 } = {}) {
    return this.q(`SELECT r.*, e.topic FROM exercise_reviews r JOIN exercises e ON e.id = r.exercise_id
      WHERE r.status = 'active' AND e.status != 'dropped' AND (? OR r.due_at <= ?)
      ORDER BY r.due_at, r.id LIMIT ?`).all(upcoming ? 1 : 0, endOfDay(now), limit);
  }

  /** How many recalls are due today, and when the next later one is. @param {number} [now] */
  reviewCounts(now = Date.now()) {
    const end = endOfDay(now);
    const row = this.q(`SELECT sum(r.due_at <= ?) AS due, min(CASE WHEN r.due_at > ? THEN r.due_at END) AS next FROM exercise_reviews r
      JOIN exercises e ON e.id = r.exercise_id WHERE r.status = 'active' AND e.status != 'dropped'`).get(end, end);
    return { due: Number(row.due ?? 0), next: row.next ?? null };
  }

  /**
   * A recall answered: right moves the card a stage on (retired past the last), partly keeps its
   * stage, missed starts it over from one day. @param {number} id @param {string} result @param {{note?: string, now?: number}} [o]
   */
  answerReview(id, result, { note, now = Date.now() } = {}) {
    return this.tx(() => {
      const r = this.q("SELECT * FROM exercise_reviews WHERE id = ?").get(id);
      if (!r) throw new Error(`Imprimatur: no recall ${id}`);
      if (r.status !== "active") throw new Error(`Imprimatur: recall ${id} is ${r.status}`);
      exStatus(result, REVIEW_RESULTS);
      const stage = result === "right" ? r.stage + 1 : result === "missed" ? 0 : r.stage;
      const retired = stage >= REVIEW_DAYS.length;
      this.q(`UPDATE exercise_reviews SET stage = ?, due_at = ?, reps = reps + 1, lapses = lapses + ?, last_result = ?, last_at = ?, note = coalesce(?, note), status = ? WHERE id = ?`)
        .run(Math.min(stage, REVIEW_DAYS.length - 1), now + (retired ? 0 : REVIEW_DAYS[stage]) * DAY_MS, result === "missed" ? 1 : 0, result, now,
          exText(note, "note") ?? null, retired ? "retired" : "active", id);
      return this.q("SELECT r.*, e.topic FROM exercise_reviews r JOIN exercises e ON e.id = r.exercise_id WHERE r.id = ?").get(id);
    });
  }

  /** An exercise with its steps in order (a split step's smaller steps right under it). @param {number} id */
  exercise(id) {
    const ex = this.q("SELECT * FROM exercises WHERE id = ?").get(id);
    if (!ex) return undefined;
    const all = this.q("SELECT * FROM exercise_steps WHERE exercise_id = ? ORDER BY position, id").all(id);
    const top = all.filter((/** @type {any} */ s) => !s.parent_id);
    const steps = top.flatMap((/** @type {any} */ s) => [s, ...all.filter((/** @type {any} */ k) => k.parent_id === s.id)]);
    return { ...ex, weak: ex.weak ? JSON.parse(ex.weak) : [], steps };
  }

  /**
   * Exercises, newest change first, with their progress (top-level steps: a split step counts once).
   * @param {{status?: string, limit?: number}} [o] status "all" for every one
   */
  exercises({ status = "active", limit = 100 } = {}) {
    const rows = this.q(`SELECT e.*,
        (SELECT count(*) FROM exercise_steps s WHERE s.exercise_id = e.id AND s.parent_id IS NULL) AS step_count,
        (SELECT count(*) FROM exercise_steps s WHERE s.exercise_id = e.id AND s.parent_id IS NULL AND s.status != 'open') AS closed
      FROM exercises e WHERE (? = 'all' OR e.status = ?) ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`).all(status, status, limit);
    return rows.map((/** @type {any} */ e) => ({ ...e, weak: e.weak ? JSON.parse(e.weak) : [] }));
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

  /**
   * Sets a key only when it is not set yet: true when this call set it (two processes
   * racing for a one-time job, exactly one wins). @param {string} k @param {string} v
   */
  claimMeta(k, v) {
    return Number(this.q("INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)").run(k, v).changes) > 0;
  }

  /**
   * Tells each plugin (#106) what a write changed, in the write's transaction. A plugin that
   * throws is logged and skipped: its failure never undoes the user's write.
   * @param {"repo" | "task" | "record" | "section" | "exercise"} entity
   * @param {any} target the row (repo, task) or its id (record, section, exercise)
   * @param {string[]} fields names from FIELDS @param {number} at
   */
  changed_(entity, target, fields, at) {
    if (!fields.length) return;
    for (const p of this.plugins) {
      if (p.onChange) this.guard_(p, () => p.onChange(this, entity, target, fields, at));
    }
  }

  /**
   * Runs a plugin's hook in a savepoint of the open transaction: it lands whole or not at all,
   * and a throw is logged, not passed on. @param {any} p @param {() => any} fn @returns {any} its result, undefined on a throw
   */
  guard_(p, fn) {
    this.sqlite.exec("SAVEPOINT plugin");
    try {
      const r = fn();
      this.sqlite.exec("RELEASE plugin");
      return r;
    } catch (e) {
      this.sqlite.exec("ROLLBACK TO plugin");
      this.sqlite.exec("RELEASE plugin");
      console.error(`Imprimatur plugin ${p.name ?? "?"}: ${/** @type {Error} */ (e).message}`);
      return undefined;
    }
  }

  /** The first plugin answer to a question (adoptRepo), else undefined. @param {string} hook @param {...any} args */
  ask_(hook, ...args) {
    for (const p of this.plugins) {
      const r = p[hook] && this.guard_(p, () => p[hook](this, ...args));
      if (r !== undefined && r !== false) return r;
    }
    return undefined;
  }
}

/**
 * Plugins (#106): modules config.json names in "plugins" (absolute paths, next to the
 * database), loaded by openDb in every process that opens it: the extension, the hooks and the
 * MCP server. A plugin exports any of:
 *   name                                  for messages
 *   setup(db, lib)                        once per opened database, after its migrations; lib: this module's exports
 *   onChange(db, entity, target, fields, at)  after a write, in its transaction (Db.changed_)
 *   adoptRepo(db, origin)                 a root seen for the first time with this origin: a repo row to take over, or undefined
 *   onOrigin(db, repo)                    a repo has just learnt its origin
 *   activate(api)                         in the extension (extension.js)
 * One that fails to load (or whose setup throws) is logged and left out: Imprimatur works
 * without it. Its writes then go unreported, so meta "plugin:missed:<path>" keeps when that
 * first happened; the plugin reads and clears it (it may want to catch up). Hooks run in a
 * savepoint (Db.guard_): a throw undoes what that hook wrote, and only that.
 * @param {string} file the database @param {string[]} [list] paths instead of config.json's
 */
function loadPlugins(file, list) {
  if (!list) {
    if (file === ":memory:") return [];
    const c = require("./config.js").readConfig(path.join(path.dirname(file), "config.json"));
    list = Array.isArray(c.plugins) ? c.plugins.filter((p) => typeof p === "string") : [];
  }
  const out = [];
  for (const p of list) {
    try {
      // A runtime path: the bundle (scripts/build.mjs) leaves it to Node.
      const mod = require(/** @type {string} */ (p));
      out.push({ name: path.basename(p), ...mod, path: p });
    } catch (e) {
      console.error(`Imprimatur plugin ${p}: ${/** @type {Error} */ (e).message}`);
      out.push({ path: p, failed: true });
    }
  }
  return out;
}

/**
 * Opens (creating if needed) the device database and brings its schema up to date.
 * @param {{path?: string, busyMs?: number, plugins?: string[]}} [o] plugins: paths instead of config.json's
 */
function openDb({ path: file = dbPath(), busyMs = 5000, plugins } = {}) {
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
  for (const p of loadPlugins(file, plugins)) {
    try {
      if (p.failed) throw new Error("did not load");
      p.setup?.(db, module.exports);
      db.plugins.push(p);
    } catch (e) {
      if (!p.failed) console.error(`Imprimatur plugin ${p.name}: ${/** @type {Error} */ (e).message}`);
      // Writes made here go unreported: the plugin finds this the next time it loads (missedSince).
      try {
        db.claimMeta(`plugin:missed:${p.path}`, String(Date.now()));
      } catch {}
    }
  }
  return db;
}

module.exports = {
  openDb, dbPath, onWindowsDrive, normOrigin, refersTo, recordOf, analysisTitle, KINDS, ACTORS, VERSION, MIGRATIONS, FIELDS,
  TRACKER_KEY, TASK_STATUSES, RECORD_STATUSES, EXERCISE_STATUSES, STEP_STATUSES, EXERCISE_STEP_KINDS, EXERCISE_TITLE_MAX, EXERCISE_TEXT_MAX, EXERCISE_STEPS_MAX, weakText, REVIEW_DAYS, REVIEW_RESULTS, DOC_KINDS, ANALYSIS, SECTION_STATUSES, SECTION_KEY, SECTION_BODY_MAX, SECTION_TITLE_MAX, SOURCE_MAX,
};
