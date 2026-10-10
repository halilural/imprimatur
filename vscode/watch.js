// @ts-check
// Follow one file (the records database and its WAL) with fs.watch on its
// folder, throttled (#71): the first event fires at once, then at most once per
// THROTTLE_MS while events keep coming, plus one trailing call after the last. fs.watch can fail later (its folder removed or replaced,
// too many watchers): the watcher's `error` closes it and it is armed again, at
// most once per REARM_MS. A folder not there yet is made, so the watch can start.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const THROTTLE_MS = 50;
/** The panel's backstop (#71): how often it looks at the database's change stamp. */
const POLL_MS = 500;
const REARM_MS = 5000;

/**
 * @param {string} file every name in its folder starting with its name counts (file-wal, file-shm)
 * @param {() => void} onChange throttled: leading and trailing
 * @param {(msg: string) => void} [log]
 * @param {{watch?: typeof fs.watch, mkdir?: (dir: string) => void, now?: () => number, throttleMs?: number, rearmMs?: number}} [deps] for tests
 * @returns {{dispose: () => void, rearm: () => void}}
 */
function watchFile(file, onChange, log = () => {}, deps = {}) {
  const watch = deps.watch ?? fs.watch;
  const mkdir = deps.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true }));
  const now = deps.now ?? Date.now;
  const throttleMs = deps.throttleMs ?? THROTTLE_MS;
  const rearmMs = deps.rearmMs ?? REARM_MS;
  const dir = path.dirname(file);
  const base = path.basename(file);
  /** @type {fs.FSWatcher | undefined} */
  let watcher;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {NodeJS.Timeout | undefined} */
  let rearmTimer;
  /** An event came inside the throttle window: one more call when it ends. */
  let pending = false;
  let armedAt = -Infinity;
  let disposed = false;

  const fire = () => {
    if (disposed) return;
    try {
      onChange();
    } catch (e) {
      log(`records: ${e instanceof Error ? e.message : e}`);
    }
  };
  const windowEnds = () => {
    timer = undefined;
    if (!pending) return;
    pending = false;
    fire();
    timer = setTimeout(windowEnds, throttleMs);
  };
  const changed = () => {
    if (timer) return void (pending = true);
    fire();
    timer = setTimeout(windowEnds, throttleMs);
  };
  const close = () => {
    try {
      watcher?.close();
    } catch {}
    watcher = undefined;
  };
  const arm = () => {
    rearmTimer = undefined;
    if (disposed) return;
    close();
    armedAt = now();
    try {
      mkdir(dir);
      const w = watch(dir, (_e, name) => {
        if (name && String(name).startsWith(base)) changed();
      });
      w.on("error", (e) => {
        log(`records: database watch failed (${e instanceof Error ? e.message : e}); watching again`);
        rearm();
      });
      watcher = w;
    } catch (e) {
      log(`records: cannot watch the database: ${e instanceof Error ? e.message : e}`);
      rearm();
    }
  };
  /** Close and watch again: now, or REARM_MS after the last time. */
  const rearm = () => {
    if (disposed || rearmTimer) return;
    close();
    rearmTimer = setTimeout(() => {
      arm();
      // Writes made while nothing watched are not lost: look once.
      if (watcher) changed();
    }, Math.max(0, armedAt + rearmMs - now()));
  };
  arm();
  return {
    rearm,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(rearmTimer);
      close();
    },
  };
}

/**
 * Says whether the database changed since the last call (#71), by its change stamp
 * (PRAGMA data_version plus this connection's own commits): the watcher, the
 * backstop poll and the extension's own writes share one, so one change draws once.
 * @param {() => string | undefined} stamp undefined when the database cannot be read
 * @returns {(force?: boolean) => boolean}
 */
function changeGate(stamp) {
  /** @type {string | undefined} */
  let seen;
  return (force = false) => {
    let now;
    try {
      now = stamp();
    } catch {
      now = undefined;
    }
    // Unreadable: say changed, the caller draws what it can (an error, the file back).
    if (!force && now !== undefined && now === seen) return false;
    seen = now;
    return true;
  };
}

/**
 * Calls fn every intervalMs between start() and stop() (#71: the panel's backstop
 * while it is visible, in case fs.watch misses an event).
 * @param {() => void} fn @param {number} [intervalMs]
 * @param {{setInterval?: typeof setInterval, clearInterval?: typeof clearInterval}} [deps] for tests
 */
function poller(fn, intervalMs = POLL_MS, deps = {}) {
  const every = deps.setInterval ?? setInterval;
  const stopEvery = deps.clearInterval ?? clearInterval;
  /** @type {any} */
  let timer;
  const stop = () => {
    if (timer !== undefined) stopEvery(timer);
    timer = undefined;
  };
  return {
    start() {
      if (timer === undefined) timer = every(fn, intervalMs);
    },
    stop,
    dispose: stop,
    get running() {
      return timer !== undefined;
    },
  };
}

module.exports = { watchFile, changeGate, poller, THROTTLE_MS, POLL_MS, REARM_MS };
