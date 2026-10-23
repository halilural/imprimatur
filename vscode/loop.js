// A job that runs on a timer and on demand, one run at a time (the issue tracker sync, plugins).

/**
 * Runs a job now, every intervalMs, and debounceMs after kick(); never two at once in this
 * process: now() during a run queues one more run and resolves when that one ends. The issue
 * tracker sync uses it, and plugins (#106) get it for theirs.
 * @param {() => Promise<string>} run returns the line to log
 * @param {(line: string, error?: boolean) => void} log
 * @param {{intervalMs?: number, debounceMs?: number, name?: string}} [o] name: the log line's word for a failed run
 */
function runLoop(run, log, { intervalMs = 60_000, debounceMs = 5_000, name = "job" } = {}) {
  let disposed = false;
  /** @type {Promise<{line?: string, error?: string}> | undefined} */
  let current;
  /** @type {Promise<{line?: string, error?: string}> | undefined} */
  let queued;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  // The server says slow down (#89: an error with status 429 or 503): no run before its
  // retryAfter (seconds), longer each time it says so again (up to 30 min); reset on success.
  let holdUntil = 0;
  let holds = 0;
  const once = async () => {
    if (Date.now() < holdUntil) return { line: `${name}: waiting for the server (until ${new Date(holdUntil).toISOString().slice(11, 19)})` };
    try {
      const line = await run();
      holds = 0;
      log(line);
      return { line };
    } catch (e) {
      const status = /** @type {any} */ (e)?.status;
      if (status === 429 || status === 503) {
        const base = (Number(/** @type {any} */ (e)?.retryAfter) || 60) * 1000;
        holdUntil = Date.now() + Math.min(base * 2 ** holds, 30 * 60_000);
        holds++;
      }
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
  let period = intervalMs;
  let every = setInterval(now, period);
  return {
    now,
    kick,
    /** A new period from now. @param {number} ms */
    setIntervalMs(ms) {
      if (disposed || ms === period) return;
      period = ms;
      clearInterval(every);
      every = setInterval(now, period);
    },
    get intervalMs() {
      return period;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearInterval(every);
    },
  };
}

module.exports = { runLoop };
