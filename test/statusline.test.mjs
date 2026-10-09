import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const HOOK = path.join(import.meta.dirname, "..", "hooks", "statusline.mjs");

/** A temp git repo (a .git folder is enough) and database. */
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imp-statusline-"));
  const root = path.join(tmp, "repo");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  return { tmp, root, dbFile: path.join(tmp, "i.db") };
}

let n = 0;
/** @param {any} input @param {string} dbFile */
const run = (input, dbFile) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, IMPRIMATUR_DB: dbFile, NO_COLOR: "1" },
  });
  return { ...r, line: r.stdout.trimEnd() };
};
const session = () => `s-${process.pid}-${Date.now()}-${n++}`;

test("statusline: counts the user's asks and open waiting steps, shows this session's 👉", () => {
  const { root, dbFile } = fixture();
  const db = require("../vscode/db.js").openDb({ path: dbFile });
  const repoId = db.repoOf(root).id;
  const t = db.upsertTask(repoId, "#64", { title: "Statusline", status: "active" });
  const sid = session();
  const agent = { kind: "agent", id: `claude:${sid}` };
  db.addRecord(t.id, { kind: "todo", owner: "K", title: "Try the line" }, agent);
  db.addRecord(t.id, { kind: "question", owner: "K", title: "Which colors?" }, agent);
  db.addRecord(t.id, { kind: "todo", owner: "C", title: "Not the user's" }, agent);
  db.addRecord(t.id, { kind: "todo", owner: "C", title: "discover cache and keep it short enough to need cutting", pointer: true }, agent);
  db.close();
  const dir = path.join(root, ".claude", "imprimatur", "waiting");
  fs.mkdirSync(dir, { recursive: true });
  const rec = (o) => JSON.stringify(o) + "\n";
  fs.writeFileSync(path.join(dir, "w1.jsonl"),
    rec({ t: "2026-10-01T10:00:00Z", session: "w1", kind: "verify", text: "Reload\nCheck the panel\nRun tests" }) +
    rec({ t: "2026-10-01T10:01:00Z", session: "w1", kind: "check", item: "2026-10-01T10:00:00Z", i: 0, on: true }));

  const r = run({ session_id: sid, cwd: path.join(root, "src"), workspace: { current_dir: path.join(root, "src") } }, dbFile);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  // 2 asks of the user + 2 unticked steps; the title cut to 40 characters.
  assert.equal(r.line, "Imprimatur · 4 waiting on you · #64 👉 discover cache and keep it short enough…");

  // Another session: no task of its own.
  assert.equal(run({ session_id: session(), cwd: root }, dbFile).line, "Imprimatur · 4 waiting on you");
});

test("statusline: nothing to say is the name; no database is no error", () => {
  const { root, tmp } = fixture();
  const r = run({ session_id: session(), cwd: root }, path.join(tmp, "missing.db"));
  assert.equal(r.status, 0);
  assert.equal(r.line, "Imprimatur");
  assert.ok(!fs.existsSync(path.join(tmp, "missing.db")), "the status line does not create the database");
});

test("statusline: bad input or no repo prints nothing and exits 0", () => {
  const { tmp, dbFile } = fixture();
  for (const input of ["", "not json", "null", "42", { session_id: "x" }, { cwd: 7 }, { cwd: path.join(tmp, "nowhere") }]) {
    const r = run(input, dbFile);
    assert.equal(r.status, 0, JSON.stringify(input));
    assert.equal(r.stdout, "", JSON.stringify(input));
  }
});

test("statusline: a second run within 2 s answers from its cache", () => {
  const { root, dbFile } = fixture();
  const sid = session();
  assert.equal(run({ session_id: sid, cwd: root }, dbFile).line, "Imprimatur");
  const dir = path.join(root, ".claude", "imprimatur", "waiting");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "w.jsonl"), JSON.stringify({ t: "2026-10-01T10:00:00Z", session: "w", kind: "verify", text: "Reload" }) + "\n");
  assert.equal(run({ session_id: sid, cwd: root }, dbFile).line, "Imprimatur");
  assert.equal(run({ session_id: session(), cwd: root }, dbFile).line, "Imprimatur · 1 waiting on you");
});
