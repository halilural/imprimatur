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
    throw new Error(`sync ${route.split("?")[0]}: HTTP ${res.status} ${why}`.trim());
  }
  return JSON.parse(text);
}

/** The next push: oldest queued changes, up to BATCH and BATCH_BYTES. @param {any} db */
function nextBatch(db) {
  const rows = db.outbox(BATCH);
  const out = [];
  let bytes = 0;
  for (const r of rows) {
    const size = Buffer.byteLength(JSON.stringify({ entity: r.entity, key: r.key, field: r.field, value: r.value, at: r.at })) + 1;
    if (out.length && bytes + size > BATCH_BYTES) break;
    bytes += size;
    out.push(r);
  }
  return out;
}

/**
 * Pushes the outbox, then pulls until the server has nothing more.
 * @param {any} db vscode/db.js handle @param {{url: string, token: string}} cfg
 * @param {{fetch?: typeof fetch}} [o]
 * @returns {Promise<{pushed: number, pulled: number, applied: number, pending: number}>}
 */
async function syncOnce(db, cfg, { fetch: fetchFn = fetch } = {}) {
  const device = db.deviceId();
  let pushed = 0;
  for (;;) {
    const rows = nextBatch(db);
    if (!rows.length) break;
    await call(cfg, "/v1/push", { device, changes: rows.map(({ entity, key, field, value, at }) => ({ entity, key, field, value, at })) }, fetchFn);
    db.ackOutbox(rows[rows.length - 1].id);
    pushed += rows.length;
  }
  let pulled = 0;
  let applied = 0;
  let pending = 0;
  for (;;) {
    const since = Number(db.meta("pull_seq") ?? 0);
    const r = await call(cfg, `/v1/pull?since=${since}&device=${encodeURIComponent(device)}&limit=${BATCH}`, undefined, fetchFn);
    const out = db.applyRemote(r.changes, { pullSeq: r.last });
    pulled += r.changes.length;
    applied += out.applied;
    pending = out.pending;
    if (!r.more || r.last <= since) break;
  }
  return { pushed, pulled, applied, pending };
}

/** One line for a log. @param {{pushed: number, pulled: number, applied: number, pending: number}} r */
const describe = (r) => `sync: pushed ${r.pushed}, pulled ${r.pulled}, applied ${r.applied}${r.pending ? `, ${r.pending} waiting` : ""}`;

/**
 * Runs sync now, every intervalMs, and debounceMs after kick(); never two at once.
 * @param {() => Promise<string>} run returns the line to log
 * @param {(line: string, error?: boolean) => void} log
 * @param {{intervalMs?: number, debounceMs?: number}} [o]
 */
function syncLoop(run, log, { intervalMs = 60_000, debounceMs = 5_000 } = {}) {
  let running = false;
  let again = false;
  let disposed = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const now = async () => {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      log(await run());
    } catch (e) {
      log(`sync failed: ${e instanceof Error ? e.message : e}`, true);
    } finally {
      running = false;
      if (again) {
        again = false;
        kick();
      }
    }
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

module.exports = { configPath, readConfig, writeConfig, syncOnce, syncLoop, describe, BATCH, BATCH_BYTES };
