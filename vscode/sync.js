// @ts-check
// Sync between machines (#61): pushes this device's queued field changes (the
// database's outbox) to the Imprimatur sync Worker (cloud/) and applies everyone
// else's; the database merges them field by field, last writer wins.
// Config: <database folder>/config.json {sync: {url, token}}, mode 0600.
// No vscode here: the extension, scripts/sync.mjs and the tests share it.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const BATCH = 1000;
/** Under the Worker's 1 MB body limit, with room for the envelope. */
const BATCH_BYTES = 900_000;
const TIMEOUT_MS = 30_000;
/** The Worker's limits (cloud/src/worker.js): a value or key over them is refused. */
const MAX_VALUE = 100_000;
const MAX_KEY = 2000;

/** @param {string} dbFile */
const configPath = (dbFile) => path.join(path.dirname(dbFile), "config.json");

/** The sync settings, or undefined when not set up. @param {string} dbFile @returns {{url: string, token: string} | undefined} */
function readConfig(dbFile) {
  try {
    const sync = JSON.parse(fs.readFileSync(configPath(dbFile), "utf8"))?.sync;
    return typeof sync?.url === "string" && typeof sync?.token === "string" && sync.url && sync.token ? { url: sync.url, token: sync.token } : undefined;
  } catch {
    return undefined;
  }
}

/** Saves url and token (only this user can read the file). @param {string} dbFile @param {{url: string, token: string}} sync */
function writeConfig(dbFile, sync) {
  const file = configPath(dbFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...old, sync: { url: sync.url.replace(/\/+$/, ""), token: sync.token } }, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * One request to the Worker. @param {{url: string, token: string}} cfg @param {string} route
 * @param {any} [body] POST when given @param {typeof fetch} [fetchFn]
 */
async function call(cfg, route, body, fetchFn = fetch) {
  const res = await fetchFn(`${cfg.url.replace(/\/+$/, "")}${route}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${cfg.token}`, ...(body && { "content-type": "application/json" }) },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let why = text;
    try {
      why = JSON.parse(text).error ?? text;
    } catch {}
    throw Object.assign(new Error(`sync ${route.split("?")[0]}: HTTP ${res.status} ${why}`.trim()), { status: res.status });
  }
  return JSON.parse(text);
}

/**
 * A queued change as the Worker takes it: a value over MAX_VALUE is cut (text keeps its
 * start and ends in "…", an object becomes {truncated: true}); undefined when it cannot be sent.
 * The local database keeps the whole value.
 * @param {{entity: string, key: string, field: string, value: string | null, at: number}} r
 */
function wire(r) {
  if (r.key.length > MAX_KEY) return undefined;
  let value = r.value;
  if (value != null && value.length > MAX_VALUE) {
    let v;
    try {
      v = JSON.parse(value);
    } catch {
      return undefined;
    }
    if (typeof v === "string") {
      let n = MAX_VALUE - 100;
      do {
        value = JSON.stringify(v.slice(0, n) + "…");
        n = Math.floor(n * 0.9);
      } while (value.length > MAX_VALUE);
    } else if (v && typeof v === "object") {
      value = JSON.stringify({ truncated: true });
    } else {
      return undefined;
    }
  }
  return { entity: r.entity, key: r.key, field: r.field, value, at: r.at };
}

/**
 * The next push: oldest queued changes, up to BATCH and BATCH_BYTES, as sent.
 * @param {any} db @returns {{rows: Array<{id: number, change: any}>, unsendable: number[]}}
 */
function nextBatch(db) {
  const rows = [];
  const unsendable = [];
  let bytes = 0;
  for (const r of db.outbox(BATCH)) {
    const change = wire(r);
    if (!change) {
      unsendable.push(r.id);
      continue;
    }
    const size = Buffer.byteLength(JSON.stringify(change)) + 1;
    if (rows.length && bytes + size > BATCH_BYTES) break;
    bytes += size;
    rows.push({ id: r.id, change });
  }
  return { rows, unsendable };
}

/**
 * Pushes rows; a batch the Worker refuses (400/413) is split until the one bad change is
 * found, which is dropped (logged) so it cannot hold up the rest. Acks exactly what was sent.
 * @param {any} db @param {{url: string, token: string}} cfg @param {string} device
 * @param {Array<{id: number, change: any}>} rows @param {typeof fetch} fetchFn @param {(line: string) => void} log
 * @returns {Promise<{pushed: number, dropped: number}>}
 */
async function pushRows(db, cfg, device, rows, fetchFn, log) {
  try {
    await call(cfg, "/v1/push", { device, changes: rows.map((r) => r.change) }, fetchFn);
    db.ackOutbox(rows.map((r) => r.id));
    return { pushed: rows.length, dropped: 0 };
  } catch (e) {
    const status = /** @type {any} */ (e).status;
    if (status !== 400 && status !== 413) throw e;
    if (rows.length === 1) {
      const c = rows[0].change;
      log(`sync: dropped a change the server refused (${c.entity} ${c.key.replace("\t", " ")} ${c.field}): ${/** @type {Error} */ (e).message}`);
      db.ackOutbox([rows[0].id]);
      return { pushed: 0, dropped: 1 };
    }
    const half = Math.ceil(rows.length / 2);
    const a = await pushRows(db, cfg, device, rows.slice(0, half), fetchFn, log);
    const b = await pushRows(db, cfg, device, rows.slice(half), fetchFn, log);
    return { pushed: a.pushed + b.pushed, dropped: a.dropped + b.dropped };
  }
}

/**
 * Pushes the outbox, then pulls until the server has nothing more. A failed push does not
 * stop the pull; its error is thrown after it. Two syncs at once (two windows) are safe:
 * a change pushed twice changes nothing, and each acks only what it sent.
 * @param {any} db vscode/db.js handle @param {{url: string, token: string}} cfg
 * @param {{fetch?: typeof fetch, log?: (line: string) => void}} [o]
 * @returns {Promise<{pushed: number, pulled: number, applied: number, pending: number, dropped: number}>}
 */
async function syncOnce(db, cfg, { fetch: fetchFn = fetch, log = () => {} } = {}) {
  const device = db.deviceId();
  let pushed = 0;
  let dropped = 0;
  /** @type {unknown} */
  let pushError;
  try {
    for (;;) {
      const { rows, unsendable } = nextBatch(db);
      if (unsendable.length) {
        log(`sync: dropped ${unsendable.length} change${unsendable.length === 1 ? "" : "s"} too large to send`);
        db.ackOutbox(unsendable);
        dropped += unsendable.length;
      }
      if (!rows.length) {
        if (unsendable.length) continue;
        break;
      }
      const r = await pushRows(db, cfg, device, rows, fetchFn, log);
      pushed += r.pushed;
      dropped += r.dropped;
    }
  } catch (e) {
    pushError = e;
  }
  let pulled = 0;
  let applied = 0;
  let pending = 0;
  for (;;) {
    const since = Number(db.meta("pull_seq") ?? 0);
    const r = await call(cfg, `/v1/pull?since=${since}&device=${encodeURIComponent(device)}&limit=${BATCH}`, undefined, fetchFn);
    const out = db.applyRemote(r.changes, { pullSeq: r.last, lastPage: !r.more || r.last <= since });
    if (out.dropped) log(`sync: gave up on ${out.dropped} pulled change${out.dropped === 1 ? "" : "s"} whose record never arrived`);
    pulled += r.changes.length;
    applied += out.applied;
    pending = out.pending;
    if (!r.more || r.last <= since) break;
  }
  const result = { pushed, pulled, applied, pending, dropped };
  if (pushError) {
    throw new Error(`${pushError instanceof Error ? pushError.message : pushError} (pull went on: ${describe(result)})`);
  }
  return result;
}

/** One line for a log. @param {{pushed: number, pulled: number, applied: number, pending: number, dropped?: number}} r */
const describe = (r) =>
  `sync: pushed ${r.pushed}, pulled ${r.pulled}, applied ${r.applied}${r.pending ? `, ${r.pending} waiting` : ""}${r.dropped ? `, ${r.dropped} dropped` : ""}`;

/**
 * Runs sync now, every intervalMs, and debounceMs after kick(); never two at once in this
 * process: now() during a run queues one more run and resolves when that one ends.
 * @param {() => Promise<string>} run returns the line to log
 * @param {(line: string, error?: boolean) => void} log
 * @param {{intervalMs?: number, debounceMs?: number, name?: string}} [o] name: the log line's word for a failed run
 */
function syncLoop(run, log, { intervalMs = 60_000, debounceMs = 5_000, name = "sync" } = {}) {
  let disposed = false;
  /** @type {Promise<{line?: string, error?: string}> | undefined} */
  let current;
  /** @type {Promise<{line?: string, error?: string}> | undefined} */
  let queued;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const once = async () => {
    try {
      const line = await run();
      log(line);
      return { line };
    } catch (e) {
      const error = `${name} failed: ${e instanceof Error ? e.message : e}`;
      log(error, true);
      return { error };
    }
  };
  /** @returns {Promise<{line?: string, error?: string}>} */
  const now = () => {
    if (disposed) return Promise.resolve({});
    if (!current) {
      current = once().finally(() => {
        current = undefined;
      });
      return current;
    }
    queued ??= current.then(() => {
      queued = undefined;
      return now();
    });
    return queued;
  };
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(now, debounceMs);
  };
  const every = setInterval(now, intervalMs);
  return {
    now,
    kick,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearInterval(every);
    },
  };
}

module.exports = { configPath, readConfig, writeConfig, syncOnce, syncLoop, describe, wire, BATCH, BATCH_BYTES, MAX_VALUE, MAX_KEY };
