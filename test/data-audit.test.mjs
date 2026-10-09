// Fixes from the data audit of 2026-10-07 (#45).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHooks } from "../scripts/setup.mjs";

const req = createRequire(import.meta.url);
const { latestBefore } = req("../vscode/review-state.js");
const { normKey, leadKey, stepTask } = req("../vscode/tasks.js");
const { waitingItems, waitingSteps } = req("../vscode/waiting.js");
const { closeDoneTasks } = req("../vscode/todo-done.js");
const { audit, parseAudit } = req("../vscode/audit.js");
const { graphRows } = req("../vscode/graph.js");
const hook = path.resolve(import.meta.dirname, "../hooks/baseline.mjs");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-45-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}
function bash(dir, id, command, event) {
  const input = JSON.stringify({ hook_event_name: event, session_id: "s1", tool_name: "Bash", tool_use_id: id, cwd: dir, tool_input: { command } });
  return spawnSync("node", [hook], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } }).status;
}
const history = (dir, file) =>
  fs.readFileSync(path.join(dir, ".claude/imprimatur/history", `${file}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
const pendingDir = (dir) => path.join(dir, ".claude/imprimatur/pending");

test("#45: a Bash command that fails after editing is still recorded, and leaves no pending file", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  const cmd = "sed -i s/one/two/ a.md && false";
  assert.equal(bash(dir, "t1", cmd, "PreToolUse"), 0);
  fs.writeFileSync(path.join(dir, "a.md"), "two\n"); // the sed ran, then the command failed
  assert.equal(bash(dir, "t1", cmd, "PostToolUseFailure"), 0);
  const [h] = history(dir, "a.md");
  assert.deepEqual([h.before, h.toolUseId, h.tool], ["one\n", "t1", "Bash"]);
  assert.deepEqual(fs.readdirSync(pendingDir(dir)), []);
});

test("#45: a pending file whose after event never came is swept by the next Bash edit", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  fs.mkdirSync(pendingDir(dir), { recursive: true });
  const old = path.join(pendingDir(dir), "lost.json");
  const fresh = path.join(pendingDir(dir), "running.json");
  fs.writeFileSync(old, "{}");
  fs.writeFileSync(fresh, "{}");
  const day = new Date(Date.now() - 864e5);
  fs.utimesSync(old, day, day);
  bash(dir, "t2", "sed -i s/one/two/ a.md", "PreToolUse");
  assert.deepEqual(fs.readdirSync(pendingDir(dir)).sort(), ["running.json", "t2.json"]);
});

test("#45: a variable's path is not a file path", async () => {
  const { pathsInCommand } = await import(hook);
  assert.deepEqual(pathsInCommand("cp $R/todos/1/TODO.md ${R}/b.md docs/a.md", ["md"]), ["/b.md", "docs/a.md"]);
});

test("#45: setup adds the Bash failure hook", () => {
  const { settings, changes } = mergeHooks({}, { root: "/r" });
  assert.ok(changes.includes("added   PostToolUseFailure [Bash] → baseline.mjs"));
  assert.equal(settings.hooks.PostToolUseFailure[0].hooks[0].command, 'node "/r/hooks/baseline.mjs" md mdx');
});

test("#45: task keys are normalized; a step's own leading key is its task", () => {
  assert.equal(normKey("80"), "#80");
  assert.equal(normKey(" #80 "), "#80");
  assert.equal(normKey("LATD-13977"), "LATD-13977");
  assert.equal(normKey("none"), undefined);
  assert.equal(leadKey("#88: Panoyu kontrol et"), "#88");
  assert.equal(leadKey("LATD-1: mail"), "LATD-1");
  assert.equal(leadKey("PR #36'yı incele"), undefined);
  assert.equal(leadKey("UTF-8 dosyalarını kontrol et"), undefined);
  assert.equal(leadKey("#658 ve 503 hatası"), "#658");
  const it = { task: "#76", text: "#88: Panoyu kontrol et\nMaili gönder" };
  assert.equal(stepTask(it, "#88: Panoyu kontrol et"), "#88");
  assert.equal(stepTask(it, "Maili gönder"), "#76");
  assert.equal(stepTask({ task: "80", text: "x" }, "x"), "#80");
});

function waitingRepo(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-45w-"));
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, records.map((r) => JSON.stringify({ session: "s1", ...r }) + "\n").join(""));
  return { root, log };
}

test("#45: a record of an unknown kind closes nothing", () => {
  const { root } = waitingRepo([
    { t: "2026-10-05T10:00:00Z", kind: "question", text: "Birleştireyim mi?" },
    { t: "2026-10-05T10:01:00Z", kind: "sent", item: "2026-10-05T10:00:00Z", i: 0 },
  ]);
  assert.equal(waitingItems(root)[0].open, true);
});

test("#45: a done task ticks only the steps about its task, also when the item names another", () => {
  const { root, log } = waitingRepo([{ t: "2026-10-06T08:00:00Z", kind: "verify", task: "#76", text: "#88: Panoyu kontrol et\n#76: Notu güncelle" }]);
  const file = path.join(root, "imprimatur.db");
  process.env.IMPRIMATUR_DB = file;
  req("../vscode/records.js").reset();
  const db = req("../vscode/db.js").openDb({ path: file });
  db.upsertTask(db.repoOf(root).id, "#88", { status: "done" });
  db.close();
  assert.equal(closeDoneTasks(root), 1);
  const steps = waitingSteps(root);
  assert.deepEqual(steps.map((s) => [s.task, s.state]), [["#88", "done"], ["#76", "open"]]);
  assert.ok(fs.readFileSync(log, "utf8").includes('"by":"file"'));
});

test("#45: audit keeps the task every ask starts with, and normalizes the model's key", async () => {
  assert.equal(parseAudit('{"settled": [], "asks": [], "task": "80"}', []).task, "#80");
  const { root, log } = waitingRepo([]);
  fs.writeFileSync(log, "");
  await audit(log, { message: "Bitti.", task: "#76" }, async () => '{"settled": [], "asks": [{"text": "#88: Panoyu kontrol et"}], "task": "#76"}');
  assert.equal(waitingItems(root)[0].task, "#88");
});

test("#45: a deleted file's history is not in the graph", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-45g-"));
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(h, { recursive: true });
  const row = JSON.stringify({ t: "2026-10-02T10:00:00Z", session: "s1", tool: "Edit", before: "" }) + "\n";
  fs.writeFileSync(path.join(h, "kept.md.jsonl"), row);
  fs.writeFileSync(path.join(h, "gone.md.jsonl"), row);
  fs.writeFileSync(path.join(root, "kept.md"), "x\n");
  assert.deepEqual(graphRows(root).rows.map((r) => r.file), ["kept.md"]);
  // An open, unsaved document still counts.
  assert.deepEqual(graphRows(root, (abs) => (abs.endsWith("gone.md") ? "y\n" : undefined)).rows.map((r) => r.file).sort(), ["gone.md", "kept.md"]);
});

test("#45: latestBefore reads the last line from the end, with or without a final newline, across chunks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-45l-"));
  const log = path.join(dir, "a.md.jsonl");
  const big = "ş".repeat(100_000); // longer than one 64 KB chunk, multi-byte
  fs.writeFileSync(log, JSON.stringify({ before: "first" }) + "\n" + JSON.stringify({ before: big }) + "\n");
  assert.equal(latestBefore(log), big);
  fs.writeFileSync(log, JSON.stringify({ before: "first" }) + "\n" + JSON.stringify({ before: "last" }));
  assert.equal(latestBefore(log), "last");
  fs.writeFileSync(log, JSON.stringify({ before: "only" }) + "\n");
  assert.equal(latestBefore(log), "only");
  fs.writeFileSync(log, JSON.stringify({ before: "a" }) + "\r\n" + JSON.stringify({ before: "b" }) + "\r\n\r\n\n");
  assert.equal(latestBefore(log), "b");
  fs.writeFileSync(log, "");
  assert.equal(latestBefore(log), undefined);
});
