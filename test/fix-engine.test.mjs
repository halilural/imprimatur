import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { runFix, undoLog, undo } = createRequire(import.meta.url)("../vscode/fix-engine.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const answer = (edits) => `Done.\n\`\`\`imprimatur-edits\n${JSON.stringify(edits)}\n\`\`\`\n`;
const ran = (stdout, code = 0) => async () => ({ code, stdout, stderr: code ? "boom" : "" });

test("fix engine: applies the edits after a backup, and undo puts the file back (#230)", async () => {
  const repo = tmp("fix-engine-repo-"), dir = tmp("fix-engine-data-");
  const f = path.join(repo, "CLAUDE.md");
  fs.writeFileSync(f, "use npm\n");
  const res = await runFix({ prompt: "p", label: "rule", edit: [f] }, { run: ran(answer([{ file: f, old: "npm", new: "pnpm" }])), dir, runId: "r1" });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(f, "utf8"), "use pnpm\n");
  assert.equal(res.applied.length, 1);
  assert.equal(fs.readFileSync(res.applied[0].backup, "utf8"), "use npm\n");
  const [line] = undoLog(dir);
  assert.equal(line.file, f);
  assert.deepEqual(undo(dir, line), { ok: true });
  assert.equal(fs.readFileSync(f, "utf8"), "use npm\n");
  assert.equal(undoLog(dir)[0].undone, true);
  assert.equal(undo(dir, undoLog(dir)[0]).ok, false);
});

test("fix engine: an edit that does not match, a file outside the fix, or a failed run changes nothing (#230)", async () => {
  const repo = tmp("fix-engine-repo-"), dir = tmp("fix-engine-data-");
  const f = path.join(repo, "a.md"), other = path.join(repo, "b.md");
  fs.writeFileSync(f, "one\n");
  fs.writeFileSync(other, "two\n");
  const res = await runFix({ prompt: "p", label: "x", edit: [f] },
    { run: ran(answer([{ file: f, old: "missing", new: "x" }, { file: other, old: "two", new: "2" }])), dir, runId: "r2" });
  assert.equal(res.applied.length, 0);
  assert.equal(res.skipped.length, 2);
  assert.equal(fs.readFileSync(f, "utf8"), "one\n");
  assert.equal(fs.readFileSync(other, "utf8"), "two\n");
  const failed = await runFix({ prompt: "p", label: "x", edit: [f] }, { run: ran(answer([{ file: f, old: "one", new: "1" }]), 1), dir, runId: "r3" });
  assert.equal(failed.ok, false);
  assert.equal(fs.readFileSync(f, "utf8"), "one\n");
  assert.deepEqual(undoLog(dir), []);
});

test("fix engine: undo is refused when the file changed after the fix (#230)", async () => {
  const repo = tmp("fix-engine-repo-"), dir = tmp("fix-engine-data-");
  const f = path.join(repo, "a.md");
  fs.writeFileSync(f, "one\n");
  await runFix({ prompt: "p", label: "x", edit: [f] }, { run: ran(answer([{ file: f, old: "one", new: "1" }])), dir, runId: "r4" });
  fs.writeFileSync(f, "1 and later work\n");
  assert.equal(undo(dir, undoLog(dir)[0]).ok, false);
  assert.equal(fs.readFileSync(f, "utf8"), "1 and later work\n");
});

test("fix engine: a whole file it creates is logged, and undo removes it (#230)", async () => {
  const repo = tmp("fix-engine-repo-"), dir = path.join(tmp("fix-engine-data-"), "not-yet");
  const f = path.join(repo, "AGENTS.md");
  const res = await runFix({ prompt: "p", label: "agents", edit: [f], whole: [f] }, { run: ran(answer([{ file: f, old: "", new: "# Rules\n" }])), dir, runId: "r5" });
  assert.equal(res.applied.length, 1);
  assert.equal(fs.readFileSync(f, "utf8"), "# Rules\n");
  assert.equal(undo(dir, undoLog(dir)[0]).ok, true);
  assert.equal(fs.existsSync(f), false);
});
