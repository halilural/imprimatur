// @ts-check
// The database's daily upkeep from the extension (#117): db.maintain() on the host's
// connection (milliseconds), and, when free pages pass 5% of the file, a VACUUM in a worker
// thread, so its second or two never freezes the extension host.
"use strict";
const { vacuumFile } = require("./db.js");

/**
 * Runs vacuumFile in a worker. Its source goes in as text: the extension is one bundled
 * file, with no db.js on disk for a worker to load.
 * @param {string} file @returns {Promise<{before: number, after: number}>}
 */
function vacuumInWorker(file) {
  const { Worker } = require("node:worker_threads");
  const code = `const { parentPort, workerData } = require("node:worker_threads");
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w && w.message || w)) ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = require("node:sqlite");
const vacuumFile = ${vacuumFile.toString()};
try { parentPort.postMessage({ ok: vacuumFile(workerData.file, { DatabaseSync }) }); }
catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }`;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { file } });
    w.once("message", (m) => (m.error ? reject(new Error(m.error)) : resolve(m.ok)));
    w.once("error", reject);
    w.once("exit", (c) => c && reject(new Error(`vacuum worker exited ${c}`)));
  });
}

/** One VACUUM at a time in this process. */
let vacuuming = false;

/**
 * The daily upkeep: maintain(), then the VACUUM it asks for. A failed one is tried again at
 * the next daily run.
 * @param {any} db @param {(line: string) => void} [log] @param {{now?: number, vacuum?: (file: string) => Promise<{before: number, after: number}>}} [o]
 */
async function maintainDb(db, log = () => {}, { now = Date.now(), vacuum = vacuumInWorker } = {}) {
  const r = db.maintain({ now });
  if (!r) return undefined;
  const mb = (/** @type {number} */ n) => `${(n / 1e6).toFixed(1)} MB`;
  log(`db upkeep: WAL checkpoint ${JSON.stringify(r.checkpoint)}, ${r.free} of ${r.pages} pages free${r.freed ? `, ${r.freed} given back` : ""}`);
  if (!r.vacuum || vacuuming || db.file === ":memory:") return r;
  vacuuming = true;
  try {
    const v = await vacuum(db.file);
    log(`db upkeep: VACUUM, ${mb(v.before)} → ${mb(v.after)}`);
    return { ...r, vacuumed: v };
  } catch (e) {
    log(`db upkeep: VACUUM failed (tried again at the next daily run): ${e instanceof Error ? e.message : e}`);
    return r;
  } finally {
    vacuuming = false;
  }
}

module.exports = { maintainDb, vacuumInWorker };
