// @ts-check
// Live updates (#71): one WebSocket per extension host to the sync Worker's `Live`
// Durable Object (cloud/src/server.js, GET /v1/live). The Worker says "sync" after
// another device pushed (pull now) and "tracker" after a GitHub issue changed (run
// the tracker for that repo). Auth: the same Bearer token as push/pull, in the
// upgrade request's Authorization header (Node's WebSocket, undici, takes headers).
// Reconnects with exponential backoff and jitter (1 s → 30 s), reset only once a
// connection held 10 s or carried a message; the pull on (re)connect runs at most once
// per 10 s. A failed connection asks the server why (a plain GET /v1/live): 401/403 →
// try again every 5 min until the settings change; 404/501 (an older Worker, no live
// endpoint) → stop, the timed sync goes on. A "ping" every 30 s (the Durable Object
// answers "pong" without waking) finds a dead connection.
// No vscode here: unit tests drive it with a fake WebSocket and timers.
"use strict";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_MS = 30_000;
/** A connection this old (or one that carried a message) resets the backoff. */
const STABLE_MS = 10_000;
/** The pull on (re)connect: at most once per this. */
const PULL_MIN_MS = 10_000;
/** The token was refused: the next try after this. */
const AUTH_RETRY_MS = 300_000;

/** The live endpoint for a sync URL: https → wss, http → ws. @param {string} url */
const liveUrl = (url) => `${url.replace(/\/+$/, "").replace(/^http/i, "ws")}/v1/live`;

/**
 * The wait before reconnect attempt n (0 first): 1 s doubling to 30 s, a random half to all of it.
 * @param {number} attempt @param {() => number} [random]
 */
function backoff(attempt, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 10));
  return Math.round(base / 2 + (random() * base) / 2);
}

/**
 * @typedef {{t: "sync", seq?: number, device?: string} | {t: "tracker", repo?: string}} LiveMessage
 * @param {{
 *   url: string, token: string, device: string,
 *   onSync?: (m: any) => void, onTracker?: (repo: string) => void,
 *   onState?: (connected: boolean) => void, onPull?: () => void, onUnavailable?: () => void, log?: (line: string) => void,
 *   WebSocket?: any, fetch?: typeof fetch, now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout,
 *   setInterval?: typeof setInterval, clearInterval?: typeof clearInterval, random?: () => number, pingMs?: number,
 * }} o onPull: pull now (on connect, throttled); onUnavailable: the server has no live endpoint, live stopped
 * @returns {{dispose: () => void, readonly connected: boolean, readonly attempt: number, readonly stopped: boolean}}
 */
function liveClient(o) {
  const WS = o.WebSocket ?? globalThis.WebSocket;
  const log = o.log ?? (() => {});
  const later = o.setTimeout ?? setTimeout;
  const cancel = o.clearTimeout ?? clearTimeout;
  const every = o.setInterval ?? setInterval;
  const stopEvery = o.clearInterval ?? clearInterval;
  const random = o.random ?? Math.random;
  const pingMs = o.pingMs ?? PING_MS;
  const clock = o.now ?? Date.now;
  const fetchFn = o.fetch ?? globalThis.fetch;
  const url = liveUrl(o.url);
  let disposed = false;
  /** No live endpoint on this server: no more tries. */
  let stopped = false;
  /** Said the token was refused: not again. */
  let saidAuth = false;
  /** @type {any} */
  let stableTimer;
  let lastPull = -Infinity;
  /** @type {any} */
  let pullTimer;
  let connected = false;
  let attempt = 0;
  /** Said "cannot connect" since the last connection: not again until one works. */
  let saidDown = false;
  /** @type {any} */
  let ws;
  /** @type {any} */
  let retry;
  /** @type {any} */
  let pinger;
  /** A message came since the last ping. */
  let alive = true;

  if (typeof WS !== "function") {
    log("live: this VS Code has no WebSocket; syncing every minute instead");
    return { dispose() {}, connected: false, attempt: 0, stopped: true };
  }

  /** The pull on connect, at most once per PULL_MIN_MS; one inside the window runs at its end. */
  const pull = () => {
    if (!o.onPull || pullTimer !== undefined) return;
    const wait = lastPull + PULL_MIN_MS - clock();
    const run = () => {
      pullTimer = undefined;
      if (disposed || !connected) return;
      lastPull = clock();
      o.onPull?.();
    };
    if (wait <= 0) run();
    else pullTimer = later(run, wait);
  };
  /**
   * Why the upgrade failed, by a plain GET: "auth" (401/403), "absent" (404/501: no live
   * endpoint), else "retry" (426 is a live endpoint refusing a non-upgrade: try again).
   * @returns {Promise<"auth" | "absent" | "retry">}
   */
  const probe = async () => {
    try {
      const res = await fetchFn(`${o.url.replace(/\/+$/, "")}/v1/live`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel?.().catch?.(() => {});
      if (res.status === 401 || res.status === 403) return "auth";
      if (res.status === 404 || res.status === 501) return "absent";
    } catch {}
    return "retry";
  };

  const stopPing = () => {
    if (pinger !== undefined) stopEvery(pinger);
    pinger = undefined;
  };
  /** The socket ended (closed, failed, or found dead): once per socket. @param {any} sock @param {string} why */
  const ended = (sock, why) => {
    if (sock !== ws) return;
    ws = undefined;
    stopPing();
    if (stableTimer !== undefined) cancel(stableTimer);
    stableTimer = undefined;
    const wasConnected = connected;
    try {
      sock.close();
    } catch {}
    if (connected) {
      connected = false;
      log(`live: disconnected (${why}); reconnecting`);
      saidDown = true;
      o.onState?.(false);
    } else if (!saidDown) {
      saidDown = true;
      log(`live: cannot connect (${why}); retrying in the background, syncing every minute meanwhile`);
    }
    if (disposed) return;
    if (wasConnected) return void (retry = later(connect, backoff(attempt++, random)));
    // Never opened: ask why before trying again.
    retry = true;
    probe().then((kind) => {
      if (disposed) return;
      if (kind === "absent") {
        stopped = true;
        retry = undefined;
        log("live: the sync server has no live endpoint (deploy the Worker again for live updates); syncing every minute");
        return o.onUnavailable?.();
      }
      if (kind === "auth") {
        if (!saidAuth) log("live: the sync server refused the token; trying again every 5 min");
        saidAuth = true;
        retry = later(connect, AUTH_RETRY_MS);
        return;
      }
      retry = later(connect, backoff(attempt++, random));
    });
  };
  /** @param {any} data */
  const message = (data) => {
    alive = true;
    attempt = 0;
    if (typeof data !== "string" || data === "pong") return;
    /** @type {any} */
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m?.t === "sync") {
      // Our own push comes back too: nothing new to pull.
      if (m.device !== o.device) o.onSync?.(m);
    } else if (m?.t === "tracker" && typeof m.repo === "string") {
      o.onTracker?.(m.repo);
    }
  };
  function connect() {
    retry = undefined;
    if (disposed) return;
    /** @type {any} */
    let sock;
    try {
      sock = new WS(url, { headers: { authorization: `Bearer ${o.token}` } });
    } catch (e) {
      ws = {};
      return ended(ws, e instanceof Error ? e.message : String(e));
    }
    ws = sock;
    sock.onopen = () => {
      if (sock !== ws) return;
      connected = true;
      saidDown = false;
      saidAuth = false;
      alive = true;
      // A connection that drops at once must not reset the backoff (a flapping server).
      stableTimer = later(() => {
        stableTimer = undefined;
        attempt = 0;
      }, STABLE_MS);
      log("live: connected");
      pinger = every(() => {
        if (!alive) return ended(sock, "no answer to ping");
        alive = false;
        try {
          sock.send("ping");
        } catch {}
      }, pingMs);
      o.onState?.(true);
      pull();
    };
    sock.onmessage = (/** @type {any} */ e) => {
      if (sock === ws) message(e?.data);
    };
    sock.onerror = (/** @type {any} */ e) => ended(sock, e?.message || e?.error?.message || "error");
    sock.onclose = (/** @type {any} */ e) => ended(sock, `closed${e?.code ? ` ${e.code}` : ""}`);
  }
  connect();
  return {
    dispose() {
      disposed = true;
      if (retry !== undefined && retry !== true) cancel(retry);
      if (stableTimer !== undefined) cancel(stableTimer);
      if (pullTimer !== undefined) cancel(pullTimer);
      stopPing();
      const sock = ws;
      ws = undefined;
      connected = false;
      try {
        sock?.close(1000, "bye");
      } catch {}
    },
    get connected() {
      return connected;
    },
    get attempt() {
      return attempt;
    },
    get stopped() {
      return stopped;
    },
  };
}

module.exports = { liveClient, liveUrl, backoff, BACKOFF_MIN_MS, BACKOFF_MAX_MS, PING_MS, STABLE_MS, PULL_MIN_MS, AUTH_RETRY_MS };
