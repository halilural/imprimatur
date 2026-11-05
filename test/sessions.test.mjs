import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { recordSession, readSessions, tokensSince } = createRequire(import.meta.url)("../vscode/sessions.js");

const msg = (id, i, o, cw = 0, cr = 0) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr } } });

test("sessions (#149): one row per session, replaced on each update, tokens from the transcript read where the last read stopped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-sess-"));
  const root = path.join(dir, "repo");
  fs.mkdirSync(root);
  const tr = path.join(dir, "t.jsonl");
  // A message's usage repeats on each of its content lines: counted once.
  fs.writeFileSync(tr, [msg("m1", 10, 5, 100, 1000), msg("m1", 10, 5, 100, 1000), JSON.stringify({ type: "user", message: { content: "hi" } })].join("\n") + "\n");
  const input = (cost, added) => ({ session_id: "s1", transcript_path: tr, model: { id: "claude-opus-5-5" },
    cost: { total_cost_usd: cost, total_duration_ms: 60000, total_api_duration_ms: 20000, total_lines_added: added, total_lines_removed: 2 } });
  const a = recordSession(root, input(0.5, 10), { now: 1000 });
  assert.deepEqual(a.tokens, { input: 10, output: 5, cacheWrite: 100, cacheRead: 1000 });
  assert.equal(recordSession(root, input(0.5, 10), { now: 2000 }), undefined, "the same numbers within 5 s write nothing");
  fs.appendFileSync(tr, msg("m2", 1, 2) + "\n" + '{"type":"assistant","message":{"id":"m3","usage":{"input_tokens":7');
  const b = recordSession(root, input(0.8, 20), { now: 3000 });
  assert.deepEqual(b.tokens, { input: 11, output: 7, cacheWrite: 100, cacheRead: 1000 }, "only the new whole lines; a half-written one waits");
  recordSession(root, { ...input(0.1, 1), session_id: "s2", transcript_path: "" }, { now: 4000 });
  const rows = readSessions(root);
  assert.deepEqual(rows.map((r) => [r.session, r.cost, r.added, r.removed, r.durationMs, r.apiMs, r.started]), [["s1", 0.8, 20, 2, 60000, 20000, 1000], ["s2", 0.1, 1, 2, 60000, 20000, 4000]],
    "the session's row replaced, not added again; its start kept");
  assert.equal(recordSession(root, { ...input(1, 1), session_id: "../x" }), undefined, "a session id that is not plain is refused");
  assert.deepEqual(tokensSince(path.join(dir, "missing.jsonl"), {}).tokens, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});
