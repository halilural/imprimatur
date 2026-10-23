// The database watcher (#71): the throttle and its data_version backstop; and runLoop, the
// timed job the issue tracker sync and plugins use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { watchFile, changeGate, poller, THROTTLE_MS, POLL_MS } = require("../vscode/watch.js");
const { runLoop } = require("../vscode/loop.js");
const { openDb } = require("../vscode/db.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

test("runLoop: setIntervalMs moves the period", async () => {
  let runs = 0;
  const loop = runLoop(async () => (runs++, "ok"), () => {}, { intervalMs: 60_000 });
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

test("runLoop: kick is debounced, runs never overlap", async () => {
  let runs = 0;
  let active = 0;
  let overlap = false;
  const loop = runLoop(async () => {
    active++;
    if (active > 1) overlap = true;
    runs++;
    await new Promise((r) => setTimeout(r, 15));
    active--;
    return "ok";
  }, () => {}, { intervalMs: 10_000, debounceMs: 5 });
  loop.kick();
  loop.kick();
  loop.kick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, 1);
  const first = loop.now();
  const second = loop.now();
  assert.equal(loop.now(), second, "one queued run however often it is asked for");
  await first;
  assert.deepEqual(await second, { line: "ok" }, "now() waits for its own run");
  await new Promise((r) => setTimeout(r, 40));
  loop.dispose();
  assert.equal(overlap, false);
  assert.equal(runs, 3, "a run asked for during a run comes after it");
});

test("runLoop (#89): after a 429 or 503 it waits for retryAfter, longer each time, and resumes on success", async () => {
  let calls = 0;
  let fail = true;
  const lines = [];
  const loop = runLoop(async () => {
    calls++;
    if (fail) throw Object.assign(new Error("HTTP 429 too many requests"), { status: 429, retryAfter: 0.05 });
    return "ok";
  }, (l) => lines.push(l), { intervalMs: 3_600_000 });
  try {
    await loop.now();
    assert.equal(calls, 1);
    const waited = await loop.now();
    assert.equal(calls, 1, "held: no request");
    assert.match(waited.line, /waiting for the server/);
    await new Promise((r) => setTimeout(r, 80));
    fail = false;
    await loop.now();
    assert.equal(calls, 2, "after Retry-After it runs again");
  } finally {
    loop.dispose();
  }
});
