// #115: the panel's input stamp changes when any input may have, and costs little.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { dataStamp, panelStamp } = require("../vscode/panel-stamp.js");

const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-stamp-"));
  const data = path.join(root, ".claude", "imprimatur");
  for (const d of ["history/docs", "baseline/docs", "waiting", "activity", "archive", "pending"]) fs.mkdirSync(path.join(data, d), { recursive: true });
  fs.writeFileSync(path.join(data, "history", "docs", "a.md.jsonl"), "{}\n");
  fs.writeFileSync(path.join(data, "baseline", "docs", "a.md"), "one\n");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "a.md"), "one\ntwo\n");
  return { root, data };
};
let tick = Date.now() / 1000;
const touch = (f, text) => {
  fs.writeFileSync(f, text);
  tick += 5;
  fs.utimesSync(f, tick, tick);
};

test("panel stamp: same inputs, same stamp; any page input moves it, archive and pending do not", () => {
  const { root, data } = mk();
  const s0 = dataStamp(root);
  assert.equal(dataStamp(root), s0);
  const moves = [
    () => touch(path.join(data, "waiting", "s1.jsonl"), "{}\n"),
    () => touch(path.join(data, "activity", "s1.jsonl"), "{}\n"),
    () => touch(path.join(data, "history", "docs", "a.md.jsonl"), "{}\n{}\n"),
    () => touch(path.join(data, "baseline", "docs", "a.md"), "one\ntwo\n"),
    () => touch(path.join(data, "descriptions.jsonl"), "{}\n"),
    () => touch(path.join(root, "docs", "a.md"), "one\n"), // the file under review, in the repo
    () => touch(path.join(root, ".claude", "imprimatur.json"), "{}"),
  ];
  let last = s0;
  for (const m of moves) {
    m();
    const now = dataStamp(root);
    assert.notEqual(now, last, String(m));
    last = now;
  }
  touch(path.join(data, "archive", "x.jsonl"), "{}\n");
  touch(path.join(data, "pending", "x.json"), "{}");
  assert.equal(dataStamp(root), last, "archive/ and pending/ are not page inputs");
});

test("panel stamp: the view, the database, an error, open documents and the minute are in it", () => {
  const { root } = mk();
  let n = 0;
  const db = { changeStamp: () => `1:${n}` };
  const at = 1_800_000_000_000;
  const base = { view: { tab: "home", flash: null }, db, docs: "", now: at };
  const s = panelStamp(root, base);
  const minute = at - (at % 60_000);
  assert.equal(panelStamp(root, { ...base, now: minute + 59_000 }), panelStamp(root, { ...base, now: minute + 1 }), "within the same minute");
  assert.notEqual(panelStamp(root, { ...base, view: { tab: "home", flash: 7 } }), s);
  assert.notEqual(panelStamp(root, { ...base, docs: "/r/a.md@3" }), s);
  assert.notEqual(panelStamp(root, { ...base, error: "locked" }), s);
  assert.notEqual(panelStamp(root, { ...base, now: at + 60_000 }), s);
  n++;
  assert.notEqual(panelStamp(root, base), s);
  assert.equal(panelStamp(root, { ...base, db: { changeStamp: () => { throw new Error("closed"); } } }), undefined, "a failing part: build as before");
});

test("panel stamp: 200 files under review (many edits each) stamp in under 10 ms", () => {
  const { root, data } = mk();
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(data, "history", `f${i}.md.jsonl`), "{}\n");
  dataStamp(root);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) dataStamp(root);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  assert.ok(ms < 10, `stamp ${ms.toFixed(1)} ms`);
});
