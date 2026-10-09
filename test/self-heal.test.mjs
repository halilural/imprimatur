// Data recorded under older rules corrects itself when read (#47).
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { callOf, keptCalls, CALLS } = req("../vscode/calls.js");
const { graphRows } = req("../vscode/graph.js");
const { closeDoneTasks } = req("../vscode/todo-done.js");
const { waitingItems } = req("../vscode/waiting.js");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A transcript: tool calls ({id, name, input, branch, failed, running}). */
function transcript(dir, calls) {
  const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  const lines = calls.flatMap((c) => [
    { type: "assistant", gitBranch: c.branch, message: { id: `m-${c.id}`, content: [{ type: "tool_use", id: c.id, name: c.name, input: c.input }] } },
    ...(c.running ? [] : [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: c.id, is_error: !!c.failed, content: "x" }] } }]),
  ]);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

test("#47: a finished call is kept in the repo and read from there once its transcript is gone", () => {
  const root = tmp("imprimatur-47c-");
  const tr = transcript(root, [
    { id: "e1", name: "Edit", input: { old_string: "a", new_string: "b" }, branch: "feat/3-x" },
    { id: "b1", name: "Bash", input: { command: "ls" }, branch: "main", failed: true },
    { id: "r1", name: "Edit", input: { old_string: "a", new_string: "c" }, branch: "feat/3-x", running: true },
  ]);
  assert.deepEqual(callOf(root, tr, "e1"), { toolUseId: "e1", branch: "feat/3-x", name: "Edit", input: { old_string: "a", new_string: "b" }, failed: false });
  assert.deepEqual(callOf(root, tr, "b1"), { toolUseId: "b1", branch: "main" });
  assert.equal(callOf(root, tr, "r1")?.name, "Edit");
  // Kept: the finished ones only (a running call's result is not known yet).
  assert.deepEqual([...keptCalls(root).keys()].sort(), ["b1", "e1"]);
  fs.rmSync(tr);
  assert.equal(callOf(root, tr, "e1")?.input.new_string, "b");
  assert.equal(callOf(root, tr, "r1"), undefined);
  // Read twice, kept once.
  assert.equal(fs.readFileSync(path.join(root, CALLS), "utf8").trimEnd().split("\n").length, 2);
});

test("#47: an older Bash row recorded the branch after the command: the graph corrects it from the transcript", () => {
  const root = tmp("imprimatur-47b-");
  const tr = transcript(root, [
    { id: "b1", name: "Bash", input: { command: "sed -i s/a/b/ a.md && git commit -qam x && git switch main" }, branch: "fix/692-reroute" },
    { id: "b2", name: "Bash", input: { command: "sed -i s/b/c/ a.md" }, branch: "feat/5-y" },
  ]);
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(
    path.join(h, "a.md.jsonl"),
    [
      { t: "2026-10-06T10:00:00Z", session: "s1", tool: "Bash", prompt: "p1", transcript: tr, toolUseId: "b1", branch: "main", before: "a\n" },
      // Before branches were recorded at all.
      { t: "2026-10-06T11:00:00Z", session: "s1", tool: "Bash", prompt: "p2", transcript: tr, toolUseId: "b2", before: "b\n" },
    ].map((r) => JSON.stringify(r) + "\n").join(""),
  );
  fs.writeFileSync(path.join(root, "a.md"), "c\n");
  assert.deepEqual(graphRows(root).rows.map((r) => [r.n, r.task]), [[2, "#5"], [1, "#692"]]);
});

test("#47: a done-cache written under older rules is read again from scratch", () => {
  const root = tmp("imprimatur-47t-");
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // The item's task field names another task; the step itself is about #37.
  fs.writeFileSync(log, JSON.stringify({ t: "2026-10-06T08:00:00Z", session: "s1", kind: "verify", task: "#36", text: "#37 için panelde kutuları tikle" }) + "\n");
  const file = path.join(root, "imprimatur.db");
  process.env.IMPRIMATUR_DB = file;
  req("../vscode/records.js").reset();
  const db = req("../vscode/db.js").openDb({ path: file });
  const repoId = db.repoOf(root).id;
  db.upsertTask(repoId, "#37", { status: "done" });
  const at = Date.parse("2026-10-06T10:00:00Z");
  db.sqlite.prepare("UPDATE tasks SET updated_at = ? WHERE repo_id = ? AND key = '#37'").run(at, repoId);
  db.close();
  // The old cache (file-based rules) saw this task already.
  fs.writeFileSync(path.join(root, ".claude/imprimatur/todo-done.json"), JSON.stringify({ rules: 2, tasks: { "#37": at } }));
  assert.equal(closeDoneTasks(root), 1);
  assert.equal(waitingItems(root)[0].open, false);
  // The new cache: nothing to do twice.
  assert.equal(closeDoneTasks(root), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".claude/imprimatur/todo-done.json"), "utf8")).rules, 3);
});

test("#49: a row from before tool calls were recorded is matched to its call by file and time, and kept", () => {
  const { linkIn, keptLinks } = req("../vscode/calls.js");
  // Transcripts in a temp dir, not the user's ~/.claude/projects.
  const home = tmp("imprimatur-49h-");
  process.env.IMPRIMATUR_TRANSCRIPTS = home;
  const root = tmp("imprimatur-49r-");
  // The session's transcript, where Claude Code keeps it (~/.claude/projects/<slug>/<session>.jsonl).
  const session = `s49-${Math.random().toString(36).slice(2)}`;
  const projects = path.join(home, "project-49");
  fs.mkdirSync(projects, { recursive: true });
  const tr = path.join(projects, `${session}.jsonl`);
  const use = (id, name, at, input) => ({ type: "assistant", timestamp: at, cwd: root, gitBranch: "feat/12-x", message: { id: `m${id}`, content: [{ type: "tool_use", id, name, input }] } });
  const done = (id) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  fs.writeFileSync(
    tr,
    [
      { type: "ai-title", aiTitle: "Task 12" },
      use("b1", "Bash", "2026-10-03T10:00:00.000Z", { command: "sed -i s/a/b/ docs/a.md", description: "Rename a to b" }),
      done("b1"),
      use("e1", "Edit", "2026-10-03T10:05:00.000Z", { file_path: path.join(root, "docs/a.md"), old_string: "b", new_string: "c" }),
      done("e1"),
      use("e2", "Edit", "2026-10-03T10:06:00.000Z", { file_path: path.join(root, "other.md"), old_string: "x", new_string: "y" }),
      done("e2"),
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  try {
    const h = path.join(root, ".claude/imprimatur/history/docs");
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(
      path.join(h, "a.md.jsonl"),
      [
        { t: "2026-10-03T10:00:03.000Z", session, tool: "Bash", prompt: "p", before: "a\n" },
        { t: "2026-10-03T10:05:01.000Z", session, tool: "Edit", prompt: "p", before: "b\n" },
      ].map((r) => JSON.stringify(r) + "\n").join(""),
    );
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/a.md"), "c\n");
    const link = linkIn(root, path.join("docs", "a.md"));
    assert.equal(link({ t: "2026-10-03T10:00:03.000Z", session, tool: "Bash" })?.toolUseId, "b1");
    assert.equal(link({ t: "2026-10-03T10:05:01.000Z", session, tool: "Edit" })?.toolUseId, "e1");
    assert.equal(link({ t: "2026-10-03T09:00:00.000Z", session, tool: "Edit" }), undefined); // no call before it
    assert.equal(keptLinks(root).size, 2);
    const { rows, sessions } = graphRows(root);
    assert.deepEqual(rows.map((r) => [r.n, r.intent, r.task, r.title]), [
      [2, undefined, "#12", "Task 12"],
      [1, "Rename a to b", "#12", "Task 12"],
    ]);
    assert.equal(sessions[0].title, "Task 12");
    // The transcript gone: the matches, the title and the Bash description stay.
    fs.rmSync(tr);
    assert.deepEqual(graphRows(root).rows.map((r) => [r.intent, r.task, r.title]), [
      [undefined, "#12", "Task 12"],
      ["Rename a to b", "#12", "Task 12"],
    ]);
  } finally {
    delete process.env.IMPRIMATUR_TRANSCRIPTS;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("#49: a Bash command naming another file with the same name is no match; Edit beats Bash when the tool is unknown", () => {
  const { linkIn } = req("../vscode/calls.js");
  const home = tmp("imprimatur-49x-");
  process.env.IMPRIMATUR_TRANSCRIPTS = home;
  try {
    const root = tmp("imprimatur-49y-");
    const session = `s49x-${Math.random().toString(36).slice(2)}`;
    fs.mkdirSync(path.join(home, "p"), { recursive: true });
    const use = (id, name, at, input) => ({ type: "assistant", timestamp: at, cwd: root, message: { id: `m${id}`, content: [{ type: "tool_use", id, name, input }] } });
    fs.writeFileSync(
      path.join(home, "p", `${session}.jsonl`),
      [
        use("e1", "Edit", "2026-10-03T10:00:00.000Z", { file_path: path.join(root, "docs/a/README.md"), old_string: "a", new_string: "b" }),
        use("b1", "Bash", "2026-10-03T10:01:00.000Z", { command: "cat docs/a/README.md" }),
        use("b2", "Bash", "2026-10-03T10:02:00.000Z", { command: "sed -i s/x/y/ docs/b/README.md" }),
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    const link = linkIn(root, path.join("docs", "a", "README.md"));
    // Tool unknown (older rows): the Edit, not the later cat.
    assert.equal(link({ t: "2026-10-03T10:01:30.000Z", session })?.toolUseId, "e1");
    // A Bash row: docs/b/README.md is another file.
    assert.equal(link({ t: "2026-10-03T10:02:30.000Z", session, tool: "Bash" })?.toolUseId, "b1");
    assert.equal(link({ t: "2026-10-03T10:03:00.000Z", session, tool: "Bash" }), undefined);
  } finally {
    delete process.env.IMPRIMATUR_TRANSCRIPTS;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
