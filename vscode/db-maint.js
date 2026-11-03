// @ts-check
// The database's daily upkeep from the extension (#117, #121): db.maintain() on the host's
// connection (milliseconds); the version tables compacted losslessly (#121; a full copy of
// the database is written once, before the first run); and, when free pages pass 5% of the
// file, a VACUUM. The copy and the VACUUM run in a worker thread, so their second or two
// never freeze the extension host.
"use strict";
const path = require("node:path");
const { vacuumFile, backupFile } = require("./db.js");

/**
 * Runs a self-contained db.js function in a worker. Its source goes in as text: the
 * extension is one bundled file, with no db.js on disk for a worker to load.
 * @param {Function} fn takes (...args, {DatabaseSync}) @param {any[]} args
 */
function inWorker(fn, args) {
  const { Worker } = require("node:worker_threads");
  const code = `const { parentPort, workerData } = require("node:worker_threads");
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w && w.message || w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = require("node:sqlite");
const fn = ${fn.toString()};
try { parentPort.postMessage({ ok: fn(...workerData.args, { DatabaseSync }) }); }
catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }`;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { args } });
    w.once("message", (m) => (m.error ? reject(new Error(m.error)) : resolve(m.ok)));
    w.once("error", reject);
    w.once("exit", (c) => c && reject(new Error(`${fn.name} worker exited ${c}`)));
  });
}

/** @param {string} file @returns {Promise<{before: number, after: number}>} */
const vacuumInWorker = (file) => inWorker(vacuumFile, [file]);
/** @param {string} file @param {string} to @returns {Promise<{to: string, bytes: number}>} */
const backupInWorker = (file, to) => inWorker(backupFile, [file, to]);

/** One upkeep at a time in this process. */
let running = false;

/**
 * The daily upkeep: maintain(), the version compaction, then the VACUUM the file needs. A
 * failed step is logged and tried again at the next daily run.
 * @param {any} db @param {(line: string) => void} [log]
 * @param {{now?: number, vacuum?: (file: string) => Promise<{before: number, after: number}>, backup?: (file: string, to: string) => Promise<{to: string, bytes: number}>}} [o]
 */
async function maintainDb(db, log = () => {}, { now = Date.now(), vacuum = vacuumInWorker, backup = backupInWorker } = {}) {
  const r = db.maintain({ now });
  if (!r) return undefined;
  const mb = (/** @type {number} */ n) => `${(n / 1e6).toFixed(1)} MB`;
  log(`db upkeep: WAL checkpoint ${JSON.stringify(r.checkpoint)}, ${r.free} of ${r.pages} pages free${r.freed ? `, ${r.freed} given back` : ""}`);
  if (running || db.file === ":memory:") return r;
  running = true;
  /** @type {any} */
  const out = { ...r };
  try {
    // #121: before the first compaction, a full copy (it runs once per database).
    try {
      if (!db.meta("compact:backup")) {
        const to = path.join(path.dirname(db.file), `imprimatur-backup-${new Date(now).toISOString().slice(0, 10)}.db`);
        const b = await backup(db.file, to);
        db.setMeta("compact:backup", b.to);
        log(`db upkeep: full copy before the first version compaction: ${b.to} (${mb(b.bytes)})`);
      }
      const since = { record: Number(db.meta("compact:record") ?? 0), doc: Number(db.meta("compact:doc") ?? 0) };
      const c = db.compactVersions({ since });
      db.setMeta("compact:record", c.maxRecordVersion);
      db.setMeta("compact:doc", c.maxDocVersion);
      out.compacted = c;
      if (c.records || c.sections) log(`db upkeep: versions compacted losslessly (${c.records} record, ${c.sections} section versions), ${mb(c.bytesBefore)} → ${mb(c.bytesAfter)}`);
    } catch (e) {
      log(`db upkeep: version compaction skipped (tried again at the next daily run): ${e instanceof Error ? e.message : e}`);
    }
    const g = (/** @type {string} */ q) => /** @type {any} */ (Object.values(db.sqlite.prepare(q).get())[0]);
    const pages = g("PRAGMA page_count");
    if (!(r.vacuum || (pages > 0 && g("PRAGMA freelist_count") / pages > 0.05))) return out;
    try {
      const v = await vacuum(db.file);
      log(`db upkeep: VACUUM, ${mb(v.before)} → ${mb(v.after)}`);
      out.vacuumed = v;
    } catch (e) {
      log(`db upkeep: VACUUM failed (tried again at the next daily run): ${e instanceof Error ? e.message : e}`);
    }
    return out;
  } finally {
    running = false;
  }
}

module.exports = { maintainDb, vacuumInWorker, backupInWorker };
