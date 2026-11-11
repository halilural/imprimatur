// #209: evidence before claims — the rule, the two skills and the turn-end check.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { claimsIn, turnTools, evidenceFinding } = require("../vscode/evidence.js");
const { check } = require("../vscode/process.js");

const transcript = (rows) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imp-ev-")), "t.jsonl");
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
};
const user = (text) => ({ type: "user", message: { content: text } });
const tool = (name) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input: {} }] } });
const result = () => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });

test("claimsIn: success claims in English and Turkish; quoted or fenced words and plain status lines are not", () => {
  assert.deepEqual(claimsIn("Done. All tests pass and the build succeeds."), ["All tests pass", "build succeeds"]);
  assert.ok(claimsIn("I fixed the parser.").length);
  assert.ok(claimsIn("Testlerin hepsi geçiyor.").length);
  assert.ok(claimsIn("Hata düzeldi.").length);
  assert.deepEqual(claimsIn("Senkron çalışıyor; iş makinesi bağlı."), []);
  assert.deepEqual(claimsIn("Ajan `testler geçiyor` dedi.\n> I fixed it\n```\nall tests pass\n```"), []);
});

test("turnTools: only the tools after the user's last own message; tool results do not start a turn", () => {
  const f = transcript([user("first"), tool("Bash"), result(), user("second"), tool("Read"), result(), tool("Edit")]);
  assert.deepEqual(turnTools(f), ["Read", "Edit"]);
  assert.equal(turnTools(path.join(os.tmpdir(), "no-such-transcript.jsonl")), undefined);
});

test("evidenceFinding: a claim in a turn without a command is a finding; with Bash, or unreadable, it is not", () => {
  assert.match(evidenceFinding("All tests pass.", transcript([user("go"), tool("Edit")])), /claims "All tests pass" but this turn ran no command/);
  assert.equal(evidenceFinding("All tests pass.", transcript([user("go"), tool("Edit"), tool("Bash")])), undefined);
  assert.equal(evidenceFinding("All tests pass.", undefined), undefined, "no transcript, no guess");
  assert.equal(evidenceFinding("Here is the plan.", transcript([user("go")])), undefined);
});

test("Stop hook (#209): the evidence finding reaches the user as a notice in a repo with process settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-ev-repo-"));
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude/imprimatur.json"), JSON.stringify({ process: { status: false, keepGoing: false, issueFields: false } }));
  const t = transcript([user("fix it"), tool("Edit")]);
  const out = check("Stop", { cwd: root, session_id: "s", transcript_path: t, last_assistant_message: "I fixed it; all tests pass." }, { records: { repoId: () => undefined } });
  assert.match(out.notice?.[0] ?? "", /evidence.*no command/);
  assert.equal(out.block, undefined, "never blocks");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the two skills ship with their notices, and the rules file points at them", () => {
  for (const s of ["diagnosing-bugs", "verification-before-completion"]) {
    assert.match(fs.readFileSync(new URL(`../skills/${s}/SKILL.md`, import.meta.url), "utf8"), new RegExp(`^---\\nname: ${s}\\n`));
    assert.match(fs.readFileSync(new URL(`../skills/${s}/NOTICE.md`, import.meta.url), "utf8"), /MIT License/);
  }
  const { TEXT } = require("../vscode/own-rules.js");
  assert.match(TEXT, /## Evidence before claims/);
  assert.match(TEXT, /verification-before-completion/);
});
