// Did it work? (#217): the week before and after a rule change, per turn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { compare } = req("../vscode/did-it-work.js");
const { dailyUsage } = req("../vscode/ticket-tokens.js");

test("did it work: tokens and asks per turn over the 7 days before and the days after; a side with no turns has none", () => {
  const days = new Map([["2026-11-03", { turns: 10, output: 10000 }], ["2026-11-05", { turns: 10, output: 30000 }], ["2026-11-06", { turns: 10, output: 5000 }]]);
  const at = Date.parse("2026-11-06T15:00:00Z");
  const asks = ["2026-11-03T10:00:00Z", "2026-11-03T11:00:00Z", "2026-11-05T09:00:00Z", "2026-11-06T16:00:00Z"].map(Date.parse);
  const c = compare(days, asks, at, Date.parse("2026-11-07T08:00:00Z"));
  assert.deepEqual(c.before, { turns: 20, tokensPerTurn: 2000, asksPerTurn: 0.15 });
  assert.deepEqual(c.after, { turns: 10, tokensPerTurn: 500, asksPerTurn: 0.1 });
  assert.deepEqual([c.tokens, c.asks], [-75, -33]);
  const none = compare(new Map([["2026-11-03", { turns: 4, output: 400 }]]), [], at, Date.parse("2026-11-07T08:00:00Z"));
  assert.equal(none.after, undefined);
  assert.equal(none.tokens, undefined);
});

test("did it work: a turn is the user's own prompt, not a tool result or a meta line; output counted once per message", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-217-"));
  const line = (o) => JSON.stringify({ sessionId: "S", timestamp: "2026-11-06T10:00:00Z", ...o });
  fs.writeFileSync(path.join(dir, "s.jsonl"), [
    line({ type: "user", message: { content: "do it" } }),
    line({ type: "user", message: { content: [{ type: "text", text: "and this" }, { type: "image" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    line({ type: "user", isMeta: true, message: { content: "caveat" } }),
    line({ type: "assistant", message: { id: "a", usage: { output_tokens: 7 } } }),
    line({ type: "assistant", message: { id: "a", usage: { output_tokens: 7 } } }),
  ].join("\n") + "\n");
  assert.deepEqual(dailyUsage(dir).get("2026-11-06"), { turns: 2, output: 7 });
});
