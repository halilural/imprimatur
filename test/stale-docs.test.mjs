// Possibly stale documents (#211): a part tied to files is flagged when a later commit changed one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { staleParts, markReviewed, pathsIn } = req("../vscode/stale-docs.js");
const agent = { kind: "agent", id: "t" };

/** A git repo with src/a.js and src/b.js committed at `at` (seconds), and a temp database. */
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-211-")));
  const git = (/** @type {string[]} */ args, /** @type {number} */ at) =>
    execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.js"), "1");
  fs.writeFileSync(path.join(root, "src/b.js"), "1");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  git(["add", "."], 1000);
  git(["commit", "-qm", "first"], 1000);
  const commit = (/** @type {string} */ file, /** @type {number} */ at, /** @type {string} */ msg) => {
    fs.appendFileSync(path.join(root, file), "x");
    git(["commit", "-qam", msg], at);
  };
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#1", { title: "T", status: "open" });
  return { root, db, repo, task, commit };
}

/** Sets a record's or section's last-written time (ms). */
const writtenAt = (/** @type {any} */ db, /** @type {string} */ table, /** @type {number} */ id, /** @type {number} */ ms) => db.q(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(ms, id);

test("stale docs (#211): an ADR whose linked file changed later is flagged with that commit; others are not", () => {
  const { root, db, repo, task, commit } = setup();
  const adr = db.addRecord(task.id, { kind: "adr", status: "done", title: "A is pure", links: { files: ["src/a.js", "package.json"] } }, agent);
  const other = db.addRecord(task.id, { kind: "adr", status: "done", title: "B", links: { files: ["src/b.js"] } }, agent);
  db.addRecord(task.id, { kind: "adr", status: "done", title: "No tie" }, agent);
  writtenAt(db, "records", adr.id, 1_500_000);
  writtenAt(db, "records", other.id, 1_500_000);
  commit("src/a.js", 2000, "change a");
  commit("package.json", 2100, "bump");
  const got = staleParts(db, repo, root);
  assert.deepEqual(got.map((p) => [p.id, p.files, p.commits.map((c) => c.subject)]), [[adr.id, ["src/a.js"], ["change a"]]]);
});

test("stale docs: marking reviewed clears it until the next change; editing the part clears it too", () => {
  const { root, db, repo, task, commit } = setup();
  const adr = db.addRecord(task.id, { kind: "decision", status: "done", title: "A", links: { files: ["src/a.js"] } }, agent);
  writtenAt(db, "records", adr.id, 1_500_000);
  commit("src/a.js", 2000, "change a");
  assert.equal(staleParts(db, repo, root).length, 1);
  markReviewed(db, adr.uid, 2_500_000);
  assert.equal(staleParts(db, repo, root).length, 0);
  commit("src/a.js", 3000, "again");
  assert.deepEqual(staleParts(db, repo, root).map((p) => p.commits.map((c) => c.subject)), [["again"]]);
  writtenAt(db, "records", adr.id, 3_500_000);
  assert.equal(staleParts(db, repo, root).length, 0);
});

test("stale docs: a section is tied by backticked repo paths and by its records; a top-level folder ties nothing", () => {
  const { root, db, repo, commit } = setup();
  const doc = db.docOf(repo.id, "project");
  const s = db.upsertSection(doc.id, "parts", { title: "Parts", chapter: "stack", body: "The core is `src/a.js`; see `nope/x.js` and `src/`." }, agent);
  writtenAt(db, "doc_sections", s.id, 1_500_000);
  assert.deepEqual(pathsIn("`src/a.js` `nope/x.js` `src/` `../etc/passwd`", root), ["src/a.js"]);
  commit("src/b.js", 2000, "b only");
  assert.equal(staleParts(db, repo, root).length, 0);
  commit("src/a.js", 3000, "a");
  assert.deepEqual(staleParts(db, repo, root).map((p) => [p.kind, p.doc, p.files]), [["section", "project", ["src/a.js"]]]);
});

test("stale docs: the panel's ADR page warns over a stale ADR; Agent Setup's checklist has one row with the count", () => {
  const { root, db, repo, task, commit } = setup();
  const adr = db.addRecord(task.id, { kind: "adr", status: "done", title: "A is pure", links: { files: ["src/a.js"] } }, agent);
  db.addRecord(task.id, { kind: "adr", status: "done", title: "B", links: { files: ["src/b.js"] } }, agent);
  writtenAt(db, "records", adr.id, 1_500_000);
  commit("src/a.js", 2000, "change a");
  const { appModel } = req("../vscode/app/model.js");
  const page = appModel(db, repo, root, { area: "docs", doc: "adrs" }).reading;
  assert.deepEqual(page.sections.map((s) => s.body.startsWith("> ⚠ **Possibly stale:** `src/a.js` changed in 1 commit")), [true, false]);
  const { checklistOf } = req("../vscode/setup-checklist.js");
  const list = checklistOf([], 0, [], undefined, { noChapter: 0, stale: 1 });
  assert.deepEqual([list.count, list.node.children.map((r) => [r.label, r.command])], [1, [["Documents: 1 possibly stale", "imprimatur.staleDocs"]]]);
});

test("stale docs: task_get gives a stale ADR a stale field and a line telling the agent to check the code", async () => {
  const { root, db, repo, task, commit } = setup();
  const adr = db.addRecord(task.id, { kind: "adr", status: "done", title: "A is pure", links: { files: ["src/a.js"] } }, agent);
  writtenAt(db, "records", adr.id, 1_500_000);
  commit("src/a.js", 2000, "change a");
  const { callTool, digest } = await import("../mcp/server.mjs");
  const out = callTool(db, "task_get", { key: "#1", status: "all", repo: root });
  assert.deepEqual(out.records.find((r) => r.id === adr.id).stale.files, ["src/a.js"]);
  assert.match(digest("task_get", out, { status: "all" }), /possibly stale \(#211\): src\/a\.js changed in 1 commit since it was written/);
  assert.equal(repo.id, db.repoByRoot(root).id);
});
