// @ts-check
// Follow one file (the records database and its WAL) with fs.watch on its
// folder, debounced. fs.watch can fail later (its folder removed or replaced,
// too many watchers): the watcher's `error` closes it and it is armed again, at
// most once per REARM_MS. A folder not there yet is made, so the watch can start.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DEBOUNCE_MS = 300;
const REARM_MS = 5000;

/**
 * @param {string} file every name in its folder starting with its name counts (file-wal, file-shm)
 * @param {() => void} onChange debounced
 * @param {(msg: string) => void} [log]
 * @param {{watch?: typeof fs.watch, mkdir?: (dir: string) => void, now?: () => number, debounceMs?: number, rearmMs?: number}} [deps] for tests
 * @returns {{dispose: () => void, rearm: () => void}}
 */
function watchFile(file, onChange, log = () => {}, deps = {}) {
  const watch = deps.watch ?? fs.watch;
  const mkdir = deps.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true }));
  const now = deps.now ?? Date.now;
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const rearmMs = deps.rearmMs ?? REARM_MS;
  const dir = path.dirname(file);
  const base = path.basename(file);
  /** @type {fs.FSWatcher | undefined} */
  let watcher;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {NodeJS.Timeout | undefined} */
  let rearmTimer;
  let armedAt = -Infinity;
  let disposed = false;

  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
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

module.exports = { watchFile, DEBOUNCE_MS, REARM_MS };
