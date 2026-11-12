// Where did this line come from (#215): a line to the recorded agent edit that wrote it.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { lineOrigin } = createRequire(import.meta.url)("../vscode/provenance.js");
const hook = path.resolve(import.meta.dirname, "../hooks/baseline.mjs");

/** One Bash call through the baseline hook: before, the change, after. */
function bashEdit(dir, id, text) {
  const run = (event) => spawnSync("node", [hook], { input: JSON.stringify({ hook_event_name: event, session_id: "s1", tool_name: "Bash", tool_use_id: id, cwd: dir, tool_input: { command: "write a.md" } }), env: { ...process.env, CLAUDE_PROJECT_DIR: dir, IMPRIMATUR_DESCRIBE: "off" } });
  run("PreToolUse");
  fs.writeFileSync(path.join(dir, "a.md"), text);
  run("PostToolUse");
}

test("line origin: the newest edit whose lines still read there; its ticket from the branch; no history, no origin", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-215-")));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.md"), "");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  git("switch", "-q", "-c", "feat/7-first");
  bashEdit(dir, "t1", "alpha\nbeta\ngamma\n");
  // By hand between two agent edits: a Bash edit's "after" is the next edit's "before", so this line
  // goes to the first edit (a known limit of the record, said in #215).
  fs.writeFileSync(path.join(dir, "a.md"), "alpha\nbeta\ngamma\nby hand\n");
  git("switch", "-q", "-c", "fix/8-second");
  bashEdit(dir, "t2", "alpha\nBETA\ngamma\nby hand\n");
  const now = fs.readFileSync(path.join(dir, "a.md"), "utf8");
  assert.equal(lineOrigin(dir, "a.md", now, 0)?.ticket, "#7");
  assert.equal(lineOrigin(dir, "a.md", now, 1)?.ticket, "#8", "the later edit rewrote it");
  assert.equal(lineOrigin(dir, "a.md", now, 2)?.ticket, "#7");
  assert.equal(lineOrigin(dir, "b.md", "x", 0), undefined, "no history");
});
