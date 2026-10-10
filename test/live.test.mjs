// Live updates (#71): the database watcher's throttle and its data_version backstop, the
// Worker's Live Durable Object (fake ctx), /v1/live and /v1/github, and the client's
// reconnect/backoff and messages (fake WebSocket and timers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle, Live, hmacHex, ISSUE_ACTIONS } from "../cloud/src/server.js";
import { githubRepos, hookCommand } from "../scripts/github-webhooks.mjs";

const require = createRequire(import.meta.url);
const { watchFile, changeGate, poller, THROTTLE_MS, POLL_MS } = require("../vscode/watch.js");
const { liveClient, liveUrl, backoff, BACKOFF_MAX_MS } = require("../vscode/live.js");
const { syncLoop } = require("../vscode/sync.js");
const { openDb } = require("../vscode/db.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "s3cret-token";
const SECRET = "hook-secret";

// --- the local path: throttle and backstop ---

test("watch: throttle fires on the first event at once, at most once per window during a burst, and once after it", async () => {
  /** @type {EventEmitter & {cb?: Function, close: () => void}} */
  let w;
  const fakeWatch = (_dir, cb) => (w = Object.assign(new EventEmitter(), { cb, close() {} }));
  const calls = [];
  const t0 = Date.now();
  const watcher = watchFile("/x/imprimatur.db", () => calls.push(Date.now() - t0), () => {}, { watch: /** @type {any} */ (fakeWatch), mkdir: () => {}, throttleMs: 40 });
  try {
    w.cb("change", "imprimatur.db-wal");
    assert.equal(calls.length, 1, "leading call, synchronously");
    // A burst of events every 5 ms for 200 ms.
    for (let i = 0; i < 40; i++) {
      w.cb("change", "imprimatur.db-wal");
      await sleep(5);
    }
    const during = calls.length;
    await sleep(120);
    assert.ok(calls.length > during || calls.length >= 2, "a trailing call after the burst");
    // ~200 ms of events at 40 ms windows: about 5-7 calls, never one per event.
    assert.ok(calls.length >= 3 && calls.length <= 9, `calls: ${calls}`);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i] - calls[i - 1] >= 35, `spaced by the window: ${calls}`);
    const n = calls.length;
    await sleep(120);
    assert.equal(calls.length, n, "quiet afterwards");
    w.cb("change", "other.txt");
    assert.equal(calls.length, n, "other names are ignored");
  } finally {
    watcher.dispose();
  }
  assert.equal(THROTTLE_MS, 50);
});

test("watch: one event fires once (no trailing call without a second event)", async () => {
  let cb;
  const watcher = watchFile("/x/imprimatur.db", () => n++, () => {}, { watch: /** @type {any} */ ((_d, f) => ((cb = f), Object.assign(new EventEmitter(), { close() {} }))), mkdir: () => {}, throttleMs: 20 });
  let n = 0;
  cb("change", "imprimatur.db");
  await sleep(80);
  assert.equal(n, 1);
  watcher.dispose();
});

test("changeGate: data_version sees another connection's commit, this connection's own, and nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-live-"));
  const file = path.join(dir, "imprimatur.db");
  const a = openDb({ path: file });
  const b = openDb({ path: file });
  try {
    const moved = changeGate(() => a.changeStamp());
    assert.equal(moved(), true, "first look");
    assert.equal(moved(), false, "nothing changed");
    const repo = b.repoOf(path.join(dir, "repo"), { name: "r" });
    assert.equal(moved(), true, "another connection's commit (PRAGMA data_version)");
    assert.equal(moved(), false);
    a.upsertTask(repo.id, "#1", { title: "t" });
    assert.equal(moved(), true, "this connection's own commit");
    assert.equal(moved(true), true, "forced");
    assert.equal(moved(), false, "the forced look counts: the watcher after it draws nothing");
    const broken = changeGate(() => {
      throw new Error("closed");
    });
    assert.equal(broken(), true, "unreadable: changed");
    assert.equal(broken(), true);
  } finally {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("poller: runs only between start and stop, at POLL_MS; start twice keeps one timer", () => {
  const timers = new Map();
  let id = 0;
  const deps = { setInterval: (fn, ms) => (timers.set(++id, { fn, ms }), id), clearInterval: (t) => timers.delete(t) };
  let n = 0;
  const p = poller(() => n++, undefined, /** @type {any} */ (deps));
  assert.equal(p.running, false);
  p.start();
  p.start();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, POLL_MS);
  assert.equal(POLL_MS, 500);
  [...timers.values()][0].fn();
  assert.equal(n, 1);
  p.stop();
  assert.equal(timers.size, 0);
  assert.equal(p.running, false);
});

test("backstop: a write fs.watch never reported is drawn within one poll", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-live-"));
  const file = path.join(dir, "imprimatur.db");
  const mine = openDb({ path: file });
  const other = openDb({ path: file });
  try {
    const moved = changeGate(() => mine.changeStamp());
    moved();
    let draws = 0;
    const p = poller(() => moved() && draws++, 20);
    p.start();
    await sleep(60);
    assert.equal(draws, 0, "no change, no draw");
    other.repoOf(path.join(dir, "r"), { name: "r" });
    await sleep(60);
    assert.equal(draws, 1, "drawn once");
    p.stop();
  } finally {
    mine.close();
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("syncLoop: setIntervalMs moves the period (5 min live, 60 s otherwise)", async () => {
  let runs = 0;
  const loop = syncLoop(async () => (runs++, "ok"), () => {}, { intervalMs: 60_000 });
  try {
    assert.equal(loop.intervalMs, 60_000);
    loop.setIntervalMs(25);
    await sleep(90);
    assert.ok(runs >= 2, `ran ${runs} times`);
    loop.setIntervalMs(300_000);
    const n = runs;
    await sleep(60);
    assert.ok(runs <= n + 1);
    assert.equal(loop.intervalMs, 300_000);
  } finally {
    loop.dispose();
  }
});

// --- the Worker ---

/** A Durable Object state with the Hibernation API's socket methods. */
function fakeCtx() {
  const sockets = [];
  return {
    sockets,
    auto: undefined,
    acceptWebSocket(ws) {
      sockets.push(ws);
    },
    getWebSockets() {
      return sockets.filter((s) => !s.closed);
    },
    setWebSocketAutoResponse(pair) {
      this.auto = pair;
    },
  };
}
const fakeSocket = (fail = false) => ({
  sent: [],
  closed: false,
  send(t) {
    if (fail) throw new Error("gone");
    this.sent.push(t);
  },
  close(code, reason) {
    this.closed = { code, reason };
  },
});
/** Live with its runtime pieces faked: the 101 is a 200 that carries the client end. */
function fakeLive() {
  const ctx = fakeCtx();
  const live = new Live(ctx, {}, {
    pair: () => [{ end: "client" }, fakeSocket()],
    upgraded: (client) => Object.assign(new Response(null, { status: 200 }), { webSocket: client }),
    autoResponse: () => ({ request: "ping", response: "pong" }),
  });
  return { ctx, live };
}
/** env.LIVE as the runtime gives it: idFromName, get → a stub whose fetch reaches the object. */
const liveNs = (live) => {
  const names = [];
  return { names, idFromName: (n) => (names.push(n), `id:${n}`), get: () => ({ fetch: (r, init) => live.fetch(r instanceof Request ? r : new Request(r, init)) }) };
};

test("Live: an upgrade is accepted for hibernation; ping/pong is answered by the runtime", async () => {
  const { ctx, live } = fakeLive();
  assert.deepEqual(ctx.auto, { request: "ping", response: "pong" });
  const res = await live.fetch(new Request("https://x/v1/live", { headers: { upgrade: "websocket" } }));
  assert.deepEqual(/** @type {any} */ (res).webSocket, { end: "client" });
  assert.equal(ctx.sockets.length, 1, "ctx.acceptWebSocket(server)");
  assert.equal((await live.fetch(new Request("https://x/other"))).status, 404);
});

test("Live: notify broadcasts to every socket, skips a dead one; close and error handlers close the socket", async () => {
  const { ctx, live } = fakeLive();
  const a = fakeSocket();
  const b = fakeSocket(true);
  const c = fakeSocket();
  ctx.sockets.push(a, b, c);
  const res = await live.fetch(new Request("https://live.internal/notify", { method: "POST", body: JSON.stringify({ t: "sync", seq: 7, device: "d1" }) }));
  assert.deepEqual(await res.json(), { sent: 2 });
  assert.deepEqual(a.sent, ['{"t":"sync","seq":7,"device":"d1"}']);
  assert.deepEqual(c.sent, a.sent);
  live.webSocketMessage(a, "hello");
  assert.equal(a.sent.length, 1, "messages from clients are ignored");
  live.webSocketClose(a, 1000, "bye");
  assert.deepEqual(a.closed, { code: 1000, reason: "bye" });
  live.webSocketClose({ close: () => { throw new Error("1006 is reserved"); } }, 1006, "");
  live.webSocketError(c);
  assert.equal(c.closed.code, 1011);
  assert.equal((await live.fetch(new Request("https://live.internal/notify", { method: "POST", body: "nope" }))).status, 400);
});

const auth = { authorization: `Bearer ${TOKEN}` };

test("/v1/live: the same Bearer check as push/pull, an upgrade only, then the one 'default' object", async () => {
  const { ctx, live } = fakeLive();
  const LIVE = liveNs(live);
  const env = { SYNC_TOKEN: TOKEN, LIVE, DB: {} };
  const up = { upgrade: "websocket" };
  assert.equal((await handle(new Request("https://s/v1/live", { headers: up }), env)).status, 401);
  assert.equal((await handle(new Request("https://s/v1/live", { headers: { ...up, authorization: "Bearer wrong" } }), env)).status, 401);
  assert.equal((await handle(new Request("https://s/v1/live", { headers: auth }), env)).status, 426);
  const res = await handle(new Request("https://s/v1/live", { headers: { ...up, ...auth } }), env);
  assert.ok(/** @type {any} */ (res).webSocket);
  assert.equal(ctx.sockets.length, 1);
  assert.deepEqual(LIVE.names, ["default"]);
  assert.equal((await handle(new Request("https://s/v1/live", { headers: { ...up, ...auth } }), { SYNC_TOKEN: TOKEN, DB: {} })).status, 501);
  // /notify is not reachable from outside: only upgrades are forwarded.
  assert.equal((await handle(new Request("https://s/notify", { method: "POST", headers: auth, body: "{}" }), env)).status, 404);
});

test("push notifies the Live object with the new seq and the pushing device (through waitUntil)", async () => {
  const { ctx, live } = fakeLive();
  const sock = fakeSocket();
  ctx.sockets.push(sock);
  const DB = {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => [{}, { results: [{ last: 42 }] }],
  };
  const waits = [];
  const env = { SYNC_TOKEN: TOKEN, DB, LIVE: liveNs(live) };
  const body = JSON.stringify({ device: "dev-A", changes: [{ entity: "task", key: "k", field: "title", value: '"x"', at: 1 }] });
  const res = await handle(new Request("https://s/v1/push", { method: "POST", headers: auth, body }), env, { waitUntil: (p) => waits.push(p) });
  assert.deepEqual(await res.json(), { last: 42 });
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.deepEqual(sock.sent.map((t) => JSON.parse(t)), [{ t: "sync", seq: 42, device: "dev-A" }]);
  // A failing object never fails the push.
  const broken = { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("down"); } }) };
  const res2 = await handle(new Request("https://s/v1/push", { method: "POST", headers: auth, body }), { ...env, LIVE: broken });
  assert.equal(res2.status, 200);
});

/** A GitHub delivery, signed with secret (or a given signature). */
async function delivery(event, payload, { secret = SECRET, sig } = {}) {
  const body = JSON.stringify(payload);
  return new Request("https://s/v1/github", {
    method: "POST",
    headers: { "x-github-event": event, "content-type": "application/json", ...(sig !== null && { "x-hub-signature-256": sig ?? `sha256=${await hmacHex(secret, body)}` }) },
    body,
  });
}

test("/v1/github: HMAC valid → tracker message; invalid, missing or no secret → 401; ping and other events ignored", async () => {
  const { ctx, live } = fakeLive();
  const sock = fakeSocket();
  ctx.sockets.push(sock);
  const env = { SYNC_TOKEN: TOKEN, GITHUB_WEBHOOK_SECRET: SECRET, LIVE: liveNs(live), DB: {} };
  const issue = (action) => ({ action, repository: { full_name: "halilural/imprimatur" }, issue: { number: 71 } });

  // Known HMAC vector: RFC 4231 test case 2.
  assert.equal(await hmacHex("Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");

  const ok = await handle(await delivery("issues", issue("closed")), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(sock.sent.map((t) => JSON.parse(t)), [{ t: "tracker", repo: "halilural/imprimatur" }]);

  assert.equal((await handle(await delivery("issues", issue("closed"), { secret: "wrong" }), env)).status, 401, "signed with another secret");
  assert.equal((await handle(await delivery("issues", issue("closed"), { sig: "sha256=00" }), env)).status, 401, "a bad signature");
  assert.equal((await handle(await delivery("issues", issue("closed"), { sig: null }), env)).status, 401, "no signature");
  assert.equal((await handle(await delivery("issues", issue("closed")), { ...env, GITHUB_WEBHOOK_SECRET: undefined })).status, 401, "no secret set: nobody gets in");
  // A tampered body with the original signature.
  const good = await delivery("issues", issue("closed"));
  const tampered = new Request("https://s/v1/github", { method: "POST", headers: good.headers, body: JSON.stringify(issue("reopened")) });
  assert.equal((await handle(tampered, env)).status, 401);

  assert.deepEqual(await (await handle(await delivery("ping", { zen: "hi" }), env)).json(), { ok: true });
  assert.deepEqual(await (await handle(await delivery("push", { repository: { full_name: "a/b" } }), env)).json(), { ignored: true });
  assert.deepEqual(await (await handle(await delivery("issues", issue("labeled")), env)).json(), { ignored: true });
  for (const a of ISSUE_ACTIONS) assert.equal((await handle(await delivery("issues", issue(a)), env)).status, 200);
  assert.equal(sock.sent.length, 1 + ISSUE_ACTIONS.length, "only the signed issue changes were sent on");
  // The webhook needs no Bearer token, and a Bearer token alone does not pass it.
  const bearerOnly = new Request("https://s/v1/github", { method: "POST", headers: { ...auth, "x-github-event": "issues" }, body: JSON.stringify(issue("closed")) });
  assert.equal((await handle(bearerOnly, env)).status, 401);
});

// --- the client ---

/** A WebSocket the test drives, and fake timers that record their delays. */
function fakes() {
  const sockets = [];
  class FakeWS {
    constructor(url, init) {
      this.url = url;
      this.init = init;
      this.sent = [];
      this.closed = undefined;
      sockets.push(this);
    }
    send(t) {
      this.sent.push(t);
    }
    close(code) {
      this.closed = code ?? 1005;
    }
    open() {
      this.onopen?.({});
    }
    msg(data) {
      this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
    }
    drop(code = 1006) {
      this.onerror?.({ message: "boom" });
      this.onclose?.({ code });
    }
  }
  const timeouts = [];
  const intervals = [];
  const timers = {
    setTimeout: (fn, ms) => (timeouts.push({ fn, ms, live: true }), timeouts.length),
    clearTimeout: (id) => id && (timeouts[id - 1].live = false),
    setInterval: (fn, ms) => (intervals.push({ fn, ms, live: true }), intervals.length),
    clearInterval: (id) => id && (intervals[id - 1].live = false),
  };
  /** Runs the newest pending timeout. */
  const fireTimeout = () => {
    const t = timeouts.findLast((t) => t.live);
    t.live = false;
    t.fn();
    return t.ms;
  };
  return { sockets, FakeWS, timeouts, intervals, timers, fireTimeout };
}

test("live client: connects with the Bearer header to wss://…/v1/live; connected → onState(true), logged once", () => {
  const f = fakes();
  const states = [];
  const logs = [];
  const c = liveClient({ url: "https://sync.example/", token: TOKEN, device: "me", WebSocket: f.FakeWS, ...f.timers, onState: (s) => states.push(s), log: (l) => logs.push(l) });
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, "wss://sync.example/v1/live");
  assert.deepEqual(f.sockets[0].init, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(c.connected, false);
  f.sockets[0].open();
  assert.equal(c.connected, true);
  assert.deepEqual(states, [true]);
  assert.deepEqual(logs, ["live: connected"]);
  assert.equal(liveUrl("http://localhost:8787"), "ws://localhost:8787/v1/live");
  c.dispose();
});

test("live client: 'sync' from another device kicks a pull, its own is ignored; 'tracker' names the repo; junk is ignored", () => {
  const f = fakes();
  const syncs = [];
  const trackers = [];
  const c = liveClient({ url: "https://s", token: "t", device: "me", WebSocket: f.FakeWS, ...f.timers, onSync: (m) => syncs.push(m), onTracker: (r) => trackers.push(r) });
  const ws = f.sockets[0];
  ws.open();
  ws.msg({ t: "sync", seq: 5, device: "other" });
  ws.msg({ t: "sync", seq: 6, device: "me" });
  ws.msg({ t: "tracker", repo: "o/r" });
  ws.msg({ t: "tracker" });
  ws.msg("pong");
  ws.msg("not json");
  ws.msg({ t: "unknown" });
  assert.deepEqual(syncs, [{ t: "sync", seq: 5, device: "other" }]);
  assert.deepEqual(trackers, ["o/r"]);
  c.dispose();
});

test("live client: reconnects with exponential backoff and jitter, 1 s → 30 s; a connection resets it", () => {
  const f = fakes();
  const logs = [];
  const states = [];
  const c = liveClient({ url: "https://s", token: "t", device: "me", WebSocket: f.FakeWS, ...f.timers, random: () => 1, log: (l) => logs.push(l), onState: (s) => states.push(s) });
  const delays = [];
  for (let i = 0; i < 8; i++) {
    f.sockets.at(-1).drop();
    delays.push(f.fireTimeout());
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(f.sockets.length, 9, "one socket per attempt; error then close schedule one retry");
  assert.equal(logs.length, 1, `'cannot connect' said once: ${logs}`);
  f.sockets.at(-1).open();
  assert.equal(c.attempt, 0);
  f.sockets.at(-1).drop();
  assert.deepEqual(states, [true, false]);
  assert.match(logs.at(-1), /^live: disconnected/);
  assert.equal(f.timeouts.findLast((t) => t.live).ms, 1000, "back to 1 s");
  f.fireTimeout();
  f.sockets.at(-1).open();
  assert.deepEqual(states, [true, false, true], "every reconnect says connected (the extension pulls then)");
  c.dispose();
  // Jitter: half to all of the step.
  for (let n = 0; n < 12; n++) {
    const lo = backoff(n, () => 0);
    const hi = backoff(n, () => 1);
    assert.equal(lo * 2, hi);
    assert.ok(hi <= BACKOFF_MAX_MS);
  }
});

test("live client: a ping without an answer by the next one reconnects; dispose closes and stops retrying", () => {
  const f = fakes();
  const c = liveClient({ url: "https://s", token: "t", device: "me", WebSocket: f.FakeWS, ...f.timers, pingMs: 30_000 });
  const ws = f.sockets[0];
  ws.open();
  const ping = f.intervals.at(-1);
  assert.equal(ping.ms, 30_000);
  ping.fn();
  assert.deepEqual(ws.sent, ["ping"]);
  ws.msg("pong");
  ping.fn();
  assert.deepEqual(ws.sent, ["ping", "ping"]);
  ping.fn(); // no pong since the last ping
  assert.ok(ws.closed, "the dead socket is closed");
  assert.equal(ping.live, false, "its ping stops");
  assert.equal(c.connected, false);
  f.fireTimeout();
  const ws2 = f.sockets.at(-1);
  assert.notEqual(ws2, ws);
  ws2.open();
  c.dispose();
  assert.equal(ws2.closed, 1000);
  ws2.onclose?.({ code: 1000 });
  assert.equal(f.timeouts.filter((t) => t.live).length, 0, "no retry after dispose");
  assert.equal(f.sockets.length, 2);
});

test("live client: no WebSocket in this runtime → nothing to dispose, said once", () => {
  const logs = [];
  const c2 = liveClient({ url: "https://s", token: "t", device: "me", WebSocket: /** @type {any} */ ("none"), log: (l) => logs.push(l) });
  assert.equal(c2.connected, false);
  assert.match(logs.at(-1), /no WebSocket/);
  c2.dispose();
});

test("live client over a real socket: the upgrade carries Authorization (Node's WebSocket takes headers)", async () => {
  const http = await import("node:http");
  const seen = await new Promise((resolve) => {
    const srv = http.createServer();
    srv.on("upgrade", (req, sock) => {
      sock.destroy();
      srv.close();
      resolve(req.headers.authorization);
    });
    srv.listen(0, "127.0.0.1", () => {
      const c = liveClient({ url: `http://127.0.0.1:${srv.address().port}`, token: TOKEN, device: "me", random: () => 0 });
      setTimeout(() => c.dispose(), 200);
    });
  });
  assert.equal(seen, `Bearer ${TOKEN}`);
});

// --- the webhook script ---

test("github-webhooks: one gh api command per GitHub repo in the database; the secret stays a variable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-hooks-"));
  const file = path.join(dir, "imprimatur.db");
  const db = openDb({ path: file });
  try {
    db.repoOf(path.join(dir, "a"), { name: "a", origin: "git@github.com:Owner/One.git" });
    db.repoOf(path.join(dir, "b"), { name: "b", origin: "https://github.com/owner/one" });
    db.repoOf(path.join(dir, "c"), { name: "c", origin: "https://gitlab.com/x/y.git" });
    db.repoOf(path.join(dir, "d"), { name: "d", origin: "https://github.com/me/two.git" });
  } finally {
    db.close();
  }
  try {
    const repos = githubRepos(file);
    assert.equal(repos.length, 2, `${repos}`);
    assert.ok(repos.some((r) => r.toLowerCase() === "owner/one"));
    assert.ok(repos.includes("me/two"));
    const cmd = hookCommand("me/two", "https://imprimatur-sync.me.workers.dev/");
    assert.equal(cmd, `gh api 'repos/me/two/hooks' --method POST -f name=web -F active=true -f 'events[]=issues' -f 'config[url]=https://imprimatur-sync.me.workers.dev/v1/github' -f 'config[content_type]=json' -f "config[secret]=$GITHUB_WEBHOOK_SECRET"`);
    assert.deepEqual(githubRepos(path.join(dir, "missing.db")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
