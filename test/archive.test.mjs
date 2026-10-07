// Archive what is older than N days (#52).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { archiveRepo, archiveDue } = req("../vscode/archive.js");
const { graphRows } = req("../vscode/graph.js");
const { waitingItems } = req("../vscode/waiting.js");

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const jsonl = (rows) => rows.map((r) => JSON.stringify(r) + "\n").join("");
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const zcat = (root, rel) => execFileSync("zcat", [path.join(root, rel)], { encoding: "utf8" });
const I = ".claude/imprimatur";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-52-"));
  // a.md: one old edit (still under review) and one new one.
  put(root, "a.md", "one\ntwo\nthree\n");
  put(root, `${I}/baseline/a.md`, "one\n");
  put(root, `${I}/history/a.md.jsonl`, jsonl([
    { t: ago(10), session: "s1", tool: "Edit", toolUseId: "old1", before: "one\n" },
    { t: ago(1), session: "s1", tool: "Edit", toolUseId: "new1", before: "one\ntwo\n" },
  ]));
  // b.md: only old edits; c.md: gone from the repo, edited yesterday.
  put(root, "b.md", "b2\n");
  put(root, `${I}/baseline/b.md`, "b1\n");
  put(root, `${I}/history/b.md.jsonl`, jsonl([{ t: ago(9), session: "s1", tool: "Edit", toolUseId: "old2", before: "b1\n" }]));
  // c.md: missing now (maybe on another branch), edited yesterday; d.md: missing, last edited 9 days ago.
  put(root, `${I}/history/c.md.jsonl`, jsonl([{ t: ago(1), session: "s2", tool: "Edit", toolUseId: "gone1", before: "" }]));
  put(root, `${I}/history/d.md.jsonl`, jsonl([{ t: ago(9), session: "s2", tool: "Edit", toolUseId: "gone2", before: "" }]));
  put(root, `${I}/descriptions.jsonl`, jsonl([
    { toolUseId: "old1", file: "a.md", text: "old" },
    { toolUseId: "new1", file: "a.md", text: "new" },
    { toolUseId: "#2", file: "a.md", text: "by number" },
  ]));
  put(root, `${I}/calls.jsonl`, jsonl([{ toolUseId: "old1", branch: "main" }, { toolUseId: "new1", branch: "feat/1-x" }]));
  // Waiting: s1 all closed and old; s2 closed but recent; s3 old with an open ask.
  put(root, `${I}/waiting/s1.jsonl`, jsonl([{ t: ago(12), kind: "question", text: "Merge?" }, { t: ago(11), kind: "answer", answer: "yes" }]));
  put(root, `${I}/waiting/s2.jsonl`, jsonl([{ t: ago(12), kind: "question", text: "Ship?" }, { t: ago(2), kind: "answer", answer: "ok" }]));
  put(root, `${I}/waiting/s3.jsonl`, jsonl([{ t: ago(20), kind: "verify", text: "Check the board" }]));
  return root;
}

test("#52: old edits count as accepted and leave the log; a file all old or gone leaves review", () => {
  const root = repo();
  const r = archiveRepo(root, { days: 7, now: NOW });
  assert.deepEqual(r, { edits: 3, files: 2, sessions: 1, calls: 1, descriptions: 1 });
  // c.md waits: a file missing now may come back with a branch switch.
  assert.equal(fs.existsSync(path.join(root, I, "history/c.md.jsonl")), true);
  // a.md: the old edit is accepted into the copy, the new one is still under review.
  assert.equal(read(root, `${I}/baseline/a.md`), "one\ntwo\n");
  assert.deepEqual(read(root, `${I}/history/a.md.jsonl`).trim().split("\n").map((l) => JSON.parse(l).toolUseId), ["new1"]);
  assert.deepEqual(graphRows(root).rows.map((x) => [x.file, x.n, x.accepted]), [["a.md", 1, false]]);
  // b.md and c.md: out of review, kept in the archive.
  for (const f of ["history/b.md.jsonl", "baseline/b.md", "history/d.md.jsonl"]) assert.equal(fs.existsSync(path.join(root, I, f)), false, f);
  const day = new Date(NOW).toISOString().slice(0, 10);
  assert.match(zcat(root, `${I}/archive/${day}/history/b.md.jsonl.gz`), /old2/);
  assert.equal(zcat(root, `${I}/archive/${day}/baseline/b.md.gz`), "b1\n");
  assert.match(zcat(root, `${I}/archive/${day}/history/a.md.jsonl.gz`), /old1/);
  // Descriptions and calls: what the rows left use; "#2" of a.md is now "#1".
  assert.deepEqual(read(root, `${I}/descriptions.jsonl`).trim().split("\n").map((l) => JSON.parse(l).toolUseId), ["new1", "#1"]);
  assert.deepEqual(read(root, `${I}/calls.jsonl`).trim().split("\n").map((l) => JSON.parse(l).toolUseId), ["new1"]);
  // Waiting: only the old log with nothing open left.
  assert.deepEqual(fs.readdirSync(path.join(root, I, "waiting")).sort(), ["s2.jsonl", "s3.jsonl"]);
  assert.equal(waitingItems(root).filter((i) => i.open).length, 1);
  assert.match(zcat(root, `${I}/archive/${day}/waiting/s1.jsonl.gz`), /Merge\?/);
  // Once a day; a second run finds nothing more.
  assert.equal(archiveDue(root, NOW + 3_600_000), false);
  assert.equal(archiveDue(root, NOW + 86_400_000), true);
  assert.deepEqual(archiveRepo(root, { days: 7, now: NOW }), { edits: 0, files: 0, sessions: 0, calls: 0, descriptions: 0 });
});

test("#52: a log a hook wrote to after it was read is left for the next run", () => {
  const root = repo();
  const log = path.join(root, I, "history/b.md.jsonl");
  const real = fs.statSync;
  let calls = 0;
  // Simulate a hook appending between the read and the rewrite.
  fs.statSync = function (f, ...a) {
    if (f === log && ++calls === 2) fs.appendFileSync(log, JSON.stringify({ t: ago(0), session: "s9", tool: "Edit", before: "b2\n" }) + "\n");
    return real.call(this, f, ...a);
  };
  try {
    archiveRepo(root, { days: 7, now: NOW });
  } finally {
    fs.statSync = real;
  }
  assert.equal(read(root, `${I}/history/b.md.jsonl`).trim().split("\n").length, 2);
});

test("#52: not while git is changing files, nor while another run holds the lock", () => {
  const root = repo();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git/index.lock"), "");
  assert.equal(archiveRepo(root, { days: 7, now: NOW }).edits, 0);
  fs.rmSync(path.join(root, ".git/index.lock"));
  put(root, `${I}/archive/.lock`, "123");
  assert.equal(archiveRepo(root, { days: 7, now: NOW }).edits, 0);
  // A lock left by a crash (older than 10 minutes) is taken over.
  const old = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(path.join(root, I, "archive/.lock"), old, old);
  assert.equal(archiveRepo(root, { days: 7, now: NOW }).edits, 3);
  assert.equal(fs.existsSync(path.join(root, I, "archive/.lock")), false);
});
