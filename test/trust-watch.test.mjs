// Workspace Trust guard and the records database watcher (#65).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { trustGate } = require("../vscode/trust.js");
const { watchFile } = require("../vscode/watch.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("trust: untrusted skips with one log line per kind of work; trusted runs", () => {
  let trusted = false;
  const lines = [];
  const allowed = trustGate(() => trusted, (m) => lines.push(m));
  assert.equal(allowed("audit"), false);
  assert.equal(allowed("audit"), false);
  assert.equal(allowed("scan"), false);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /untrusted workspace: audit skipped/);
  trusted = true;
  assert.equal(allowed("audit"), true);
  assert.equal(lines.length, 2);
});

test("watch: a change to the file or its WAL fires once, debounced; other names do not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-watch-"));
  const file = path.join(dir, "imprimatur.db");
  let n = 0;
  const w = watchFile(file, () => n++, () => {}, { debounceMs: 30 });
  try {
    fs.writeFileSync(path.join(dir, "other.txt"), "x");
    fs.writeFileSync(`${file}-wal`, "a");
    fs.writeFileSync(`${file}-wal`, "b");
    await sleep(150);
    assert.equal(n, 1);
  } finally {
    w.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watch: a folder not there yet is made and watched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-watch-"));
  const file = path.join(root, "a", "b", "imprimatur.db");
  let n = 0;
  const w = watchFile(file, () => n++, () => {}, { debounceMs: 20 });
  try {
    assert.ok(fs.existsSync(path.dirname(file)));
    fs.writeFileSync(file, "x");
    await sleep(120);
    assert.equal(n, 1);
  } finally {
    w.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watch: an error closes the watcher and arms it again, at most once per rearm period", async () => {
  /** @type {Array<EventEmitter & {closed?: boolean}>} */
  const made = [];
  const fakeWatch = () => {
    const e = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true; } });
    made.push(e);
    return e;
  };
  const logs = [];
  let changes = 0;
  const w = watchFile("/x/imprimatur.db", () => changes++, (m) => logs.push(m), { watch: /** @type {any} */ (fakeWatch), mkdir: () => {}, debounceMs: 5, rearmMs: 80 });
  try {
    assert.equal(made.length, 1);
    made[0].emit("error", new Error("EPERM"));
    made[0].emit("error", new Error("EPERM")); // a second error before the re-arm: no second timer
    assert.equal(made[0].closed, true);
    assert.equal(logs.length, 2);
    await sleep(40);
    assert.equal(made.length, 1, "not re-armed before the period");
    await sleep(80);
    assert.equal(made.length, 2, "re-armed once");
    await sleep(20);
    assert.equal(changes, 1, "looks once after re-arming");
  } finally {
    w.dispose();
  }
  assert.equal(made[1].closed, true);
});
