// Tokens per ticket (#214): usage counted once per message and given to the branch's ticket, else
// the one the session last named; transcripts read incrementally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { ticketTokens, ticketOfBranch } = createRequire(import.meta.url)("../vscode/ticket-tokens.js");

const usage = (o) => ({ input_tokens: 1, cache_creation_input_tokens: 9, cache_read_input_tokens: 100, output_tokens: 5, ...o });
const msg = (id, branch, extra = {}) => JSON.stringify({ type: "assistant", sessionId: "S1", gitBranch: branch, message: { id, usage: usage(), content: [], ...extra } });
const call = (id, name, input) => JSON.stringify({ type: "assistant", sessionId: "S1", gitBranch: "main", message: { id, usage: usage(), content: [{ type: "tool_use", name, input }] } });

test("ticket tokens: the branch's ticket, else the one the session last named; a repeated message id counts once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-214-"));
  const file = path.join(dir, "s1.jsonl");
  fs.writeFileSync(file, [
    msg("m1", "feat/212-wasted"),
    msg("m1", "feat/212-wasted"), // the same message, streamed again
    msg("m2", "main"), // nothing named yet: not counted
    call("m3", "mcp__imprimatur__task_get", { key: "#5" }),
    msg("m4", "main"),
    call("m5", "Bash", { command: "git switch -q -c fix/7-thing" }),
    msg("m6", "main"),
    JSON.stringify({ type: "user", message: { content: "hi" } }),
  ].join("\n") + "\n");
  let t = ticketTokens(dir);
  assert.deepEqual(t.get("#212"), { written: 10, cached: 100, output: 5, sessions: 1 });
  assert.deepEqual(t.get("#5"), { written: 20, cached: 200, output: 10, sessions: 1 }, "m3 and m4");
  assert.deepEqual(t.get("#7")?.output, 10, "m5 and m6");
  // A grown file is read from where it stopped; a half-written line waits.
  fs.appendFileSync(file, msg("m7", "feat/212-wasted") + "\n" + '{"type":"assistant","mess');
  t = ticketTokens(dir);
  assert.equal(t.get("#212").output, 10);
  assert.equal(t.get("#5").output, 10, "earlier sums unchanged");
});

test("ticket tokens: branch names", () => {
  assert.deepEqual(["feat/212-wasted", "dev/LATD-12-x", "main", "fix/7", "spike/abc"].map(ticketOfBranch), ["#212", "LATD-12", undefined, "#7", undefined]);
});
