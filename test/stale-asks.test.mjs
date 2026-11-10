import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

test("waiting on you: a closed task's open asks and a turn-end ask older than a week are not counted", () => {
  const { openDb } = require("../vscode/db.js");
  const db = openDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-stale-"));
  const repo = db.repoOf(root);
  const t1 = db.upsertTask(repo.id, "#1", { title: "open one" });
  const t2 = db.upsertTask(repo.id, "#2", { title: "closed one" });
  db.addRecord(t1.id, { kind: "todo", owner: "K", title: "do this" }, { kind: "user" });
  db.addRecord(t2.id, { kind: "todo", owner: "K", title: "left over" }, { kind: "user" });
  db.addRecord(t2.id, { kind: "test", owner: "K", title: "check it" }, { kind: "user" });
  db.upsertTask(repo.id, "#2", { status: "done" });
  assert.deepEqual(db.openAsks({ repoId: repo.id }).map((r) => r.title), ["do this"]);
  assert.deepEqual(db.openTests({ repoId: repo.id }).map((r) => r.title), []);
  const { inboxCount } = require("../vscode/inbox.js");
  const now = Date.now();
  const turn = [{ session: "s", state: "open", kind: "verify", t: new Date(now - 3600e3).toISOString(), item: "a", i: 0, text: "x" },
    { session: "s", state: "open", kind: "verify", t: new Date(now - 8 * 86400e3).toISOString(), item: "b", i: 0, text: "y" },
    { session: "todo-files", state: "open", kind: "verify", t: new Date(now).toISOString(), item: "c", i: 0, text: "z" }];
  assert.equal(inboxCount(undefined, root, turn), 1, "the recent one only; the old one and the records' mirror are not counted");
  fs.rmSync(root, { recursive: true, force: true });
});
