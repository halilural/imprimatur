// The graph shows what the agent really did (#46).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { editBranch } from "../hooks/baseline.mjs";

const req = createRequire(import.meta.url);
const { historyEdits } = req("../vscode/review-state.js");
const { toolCallOf } = req("../vscode/narration.js");
const { graphRows } = req("../vscode/graph.js");
const hook = path.resolve(import.meta.dirname, "../hooks/baseline.mjs");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("#46: a Bash edit's branch: the one that is not the default when the command switched", () => {
  assert.equal(editBranch(undefined, "main"), "main");
  assert.equal(editBranch("feat/7-x", "feat/7-x"), "feat/7-x");
  assert.equal(editBranch("feat/7-x", "main"), "feat/7-x"); // edit, commit, back to main
  assert.equal(editBranch("main", "feat/7-x"), "feat/7-x"); // new branch, then edit
  assert.equal(editBranch("feat/7-x", "fix/8-y"), "fix/8-y");
});

function bash(dir, id, command, event) {
  const input = JSON.stringify({ hook_event_name: event, session_id: "s1", tool_name: "Bash", tool_use_id: id, cwd: dir, tool_input: { command } });
  return spawnSync("node", [hook], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, IMPRIMATUR_DESCRIBE: "off" } }).status;
}
const history = (dir, file) =>
  fs.readFileSync(path.join(dir, ".claude/imprimatur/history", `${file}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));

test("#46: a Bash command that edits on its branch and switches back to main records its branch", () => {
  const dir = tmp("imprimatur-46b-");
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("switch", "-q", "-c", "feat/7-x");
  fs.writeFileSync(path.join(dir, "a.md"), "one\n");
  const cmd = "sed -i s/one/two/ a.md && git switch main";
  bash(dir, "t1", cmd, "PreToolUse");
  fs.writeFileSync(path.join(dir, "a.md"), "two\n");
  git("switch", "-q", "main");
  bash(dir, "t1", cmd, "PostToolUse");
  assert.equal(history(dir, "a.md")[0].branch, "feat/7-x");
});

test("#46: a pending file in the old format (the files alone) is still read", () => {
  const dir = tmp("imprimatur-46p-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const f = path.join(dir, "a.md");
  fs.writeFileSync(f, "two\n");
  const pending = path.join(dir, ".claude/imprimatur/pending");
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, "t2.json"), JSON.stringify({ [f]: "one\n" }));
  bash(dir, "t2", "sed -i s/one/two/ a.md", "PostToolUse");
  assert.equal(history(dir, "a.md")[0].before, "one\n");
});

/** A Claude Code transcript with the given tool calls ({id, name, input, failed?}). */
function transcript(dir, calls) {
  const f = path.join(dir, "t.jsonl");
  const lines = calls.flatMap((c) => [
    { type: "assistant", message: { id: `m-${c.id}`, content: [{ type: "tool_use", id: c.id, name: c.name, input: c.input }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: c.id, is_error: !!c.failed, content: c.failed ? "denied" : "ok" }] } },
  ]);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

function fileWithHistory(rows, current) {
  const root = tmp("imprimatur-46g-");
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, "a.md.jsonl"), rows.map((r) => JSON.stringify(r) + "\n").join(""));
  fs.writeFileSync(path.join(root, "a.md"), current);
  return { root, log: path.join(h, "a.md.jsonl") };
}

test("#46: an Edit's after is what the call wrote; the rest is an outside edit", () => {
  const dir = tmp("imprimatur-46t-");
  const tr = transcript(dir, [{ id: "e1", name: "Edit", input: { old_string: "one", new_string: "ONE" } }]);
  const { log } = fileWithHistory([{ t: "2026-10-07T10:00:00.000Z", session: "s1", tool: "Edit", transcript: tr, toolUseId: "e1", before: "one\ntwo\n" }], "");
  // After the edit, someone also changed "two" by hand.
  const edits = historyEdits(log, "ONE\nTWO\n", { toolCall: toolCallOf });
  assert.deepEqual(edits.map((e) => [e.n, e.tool, e.before, e.after, !!e.outside]), [
    [1.5, "outside", "ONE\ntwo\n", "ONE\nTWO\n", true],
    [1, "Edit", "one\ntwo\n", "ONE\ntwo\n", false],
  ]);
  // Without the transcript reader, as before: one edit takes it all.
  assert.deepEqual(historyEdits(log, "ONE\nTWO\n").map((e) => e.after), ["ONE\nTWO\n"]);
});

test("#46: a failed Edit changed nothing; a Write's after is its content; an unknown call keeps the old reading", () => {
  const dir = tmp("imprimatur-46f-");
  const tr = transcript(dir, [
    { id: "e1", name: "Edit", input: { old_string: "one", new_string: "ONE" }, failed: true },
    { id: "w1", name: "Write", input: { content: "w\n" } },
  ]);
  const { log } = fileWithHistory(
    [
      { t: "2026-10-07T10:00:00.000Z", tool: "Edit", transcript: tr, toolUseId: "e1", before: "one\n" },
      { t: "2026-10-07T10:01:00.000Z", tool: "Write", transcript: tr, toolUseId: "w1", before: "one\n" },
      { t: "2026-10-07T10:02:00.000Z", tool: "Edit", transcript: tr, toolUseId: "missing", before: "w\n" },
    ],
    "",
  );
  const edits = historyEdits(log, "w2\n", { toolCall: toolCallOf }).reverse();
  assert.deepEqual(edits.map((e) => [e.n, e.after]), [[1, "one\n"], [2, "w\n"], [3, "w2\n"]]);
  assert.equal(edits[0].added + edits[0].removed, 0);
});

test("#46: the graph shows the outside change in its edit's lane and hides edits that changed nothing", () => {
  const dir = tmp("imprimatur-46r-");
  const tr = transcript(dir, [
    { id: "e1", name: "Edit", input: { old_string: "one", new_string: "ONE" } },
    { id: "e2", name: "Edit", input: { old_string: "zzz", new_string: "y" }, failed: true },
  ]);
  const { root } = fileWithHistory(
    [
      { t: "2026-10-07T10:00:00.000Z", session: "s1", tool: "Edit", prompt: "fix", branch: "fix/9-x", transcript: tr, toolUseId: "e1", before: "one\ntwo\n" },
      { t: "2026-10-07T10:05:00.000Z", session: "s1", tool: "Edit", prompt: "fix", branch: "fix/9-x", transcript: tr, toolUseId: "e2", before: "ONE\nTWO\n" },
    ],
    "ONE\nTWO\n",
  );
  const { rows } = graphRows(root);
  assert.deepEqual(rows.map((r) => [r.n, r.tool, r.task, !!r.outside, r.added, r.removed]), [
    [1.5, "outside", "#9", true, 1, 1],
    [1, "Edit", "#9", false, 1, 1],
  ]);
  assert.match(rows[0].intent, /^Outside change/);
});
