// #122: the archive and document backups are kept for a while, not for ever; an old waiting
// log that still asks keeps only what its open asks need.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { pruneRepo, openOnly, archiveRepo } = require("../vscode/archive.js");
const { itemsOf, readLog } = require("../vscode/waiting.js");

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-03T12:00:00Z");
const repo = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-122-")));
const t = (daysAgo, min = 0) => new Date(NOW - daysAgo * DAY + min * 60_000).toISOString();
const asLines = (recs) => recs.map((r) => ({ line: JSON.stringify(r), r }));

test("openOnly: the cut log gives the same open asks; closed ones and the chatter go", () => {
  const S = "s1";
  const log = [
    { t: t(40, 0), session: S, kind: "question", text: "Old question" },
    { t: t(40, 1), session: S, kind: "answer", answer: "yes" }, // closes it
    { t: t(40, 2), session: S, kind: "step", text: "noise" },
    { t: t(39, 0), session: S, kind: "verify", text: "check A\ncheck B" },
    { t: t(39, 1), session: S, kind: "check", item: t(39, 0), i: 0, on: true },
    { t: t(39, 2), session: S, kind: "answer", answer: "a note for the verify step" },
    { t: t(38, 0), session: S, kind: "command", text: "Run the migration" },
  ];
  const kept = openOnly(asLines(log), S);
  assert.ok(kept, "something to cut");
  const after = kept.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(after.length < log.length);
  const open = (recs) => JSON.stringify(itemsOf(recs, S).filter((it) => it.open));
  assert.equal(open(after), open(log), "the very same open asks, ticks and notes");
  assert.ok(!after.some((r) => r.text === "Old question" || r.kind === "step"));
  assert.equal(openOnly(asLines(after), S), undefined, "nothing more to cut");
});

test("archiveRepo: a waiting log quiet for 30 days that still asks is cut (whole copy archived); a newer one is left", () => {
  const root = repo();
  const dir = path.join(root, ".claude", "imprimatur", "waiting");
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, recs, daysAgo) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const at = (NOW - daysAgo * DAY) / 1000;
    fs.utimesSync(f, at, at);
    return f;
  };
  const old = write("old.jsonl", [
    { t: t(40), session: "old", kind: "question", text: "Done long ago" },
    { t: t(40, 1), session: "old", kind: "answer", answer: "ok" },
    { t: t(35), session: "old", kind: "command", text: "Still to do" },
  ], 35);
  const recent = write("recent.jsonl", [
    { t: t(10), session: "recent", kind: "question", text: "Q" },
    { t: t(10, 1), session: "recent", kind: "answer", answer: "a" },
    { t: t(9), session: "recent", kind: "command", text: "Open" },
  ], 9);
  const r = archiveRepo(root, { days: 7, now: NOW });
  assert.equal(r.trimmed, 1);
  assert.deepEqual(readLog(old).map((x) => x.text ?? x.answer), ["Still to do"]);
  assert.equal(readLog(recent).length, 3, "under 30 days: whole");
  assert.ok(fs.existsSync(path.join(root, ".claude", "imprimatur", "archive", "2026-11-03", "waiting", "old.jsonl.gz")), "the whole log is archived");
});

test("pruneRepo: archive days past keepDays go, then the oldest past maxBytes; backups keep each file's newest; unread.json goes", () => {
  const root = repo();
  const base = path.join(root, ".claude", "imprimatur");
  const day = (daysAgo, bytes) => {
    const d = path.join(base, "archive", new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "history.gz"), Buffer.alloc(bytes));
  };
  day(120, 1000);
  day(60, 4000);
  day(30, 4000);
  day(1, 4000);
  fs.writeFileSync(path.join(base, "archive", "state.json"), "{}");
  const bdir = path.join(base, "docs-backup");
  fs.mkdirSync(bdir, { recursive: true });
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(bdir, `ARCHITECTURE-${NOW - (i * 20 + 1) * DAY}.md`), "x");
  fs.writeFileSync(path.join(bdir, `PRODUCT-${NOW - 200 * DAY}.md`), "only one, old");
  fs.writeFileSync(path.join(base, "unread.json"), "{}");
  const r = pruneRepo(root, { keepDays: 90, maxBytes: 9000, now: NOW });
  const left = fs.readdirSync(path.join(base, "archive")).sort();
  assert.deepEqual(left.filter((n) => n !== "state.json").length, 2, left.join(","));
  assert.ok(left.includes("state.json"), "the archive's own state stays");
  assert.equal(r.days, 2, "120 days by age, then 60 by size");
  assert.ok(r.archiveBytes <= 9000);
  const backups = fs.readdirSync(bdir);
  assert.equal(backups.filter((n) => n.startsWith("ARCHITECTURE")).length, 5, "at most 5, and none past 90 days but the newest");
  assert.ok(backups.some((n) => n.startsWith("PRODUCT")), "a file's newest backup stays whatever its age");
  assert.equal(r.unread, true);
  assert.ok(!fs.existsSync(path.join(base, "unread.json")));
  // The newest day stays even over the size limit.
  pruneRepo(root, { keepDays: 0, maxBytes: 1, now: NOW });
  assert.equal(fs.readdirSync(path.join(base, "archive")).filter((n) => n !== "state.json").length, 1);
});
