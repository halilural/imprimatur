import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTurn } from "../hooks/audit.mjs";

const req = createRequire(import.meta.url);
const { audit, parseAudit, auditPrompt, overlap, pointedAsks } = req("../vscode/audit.js");
const { waitingItems, openSteps, waitingSteps } = req("../vscode/waiting.js");

function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-audit-"));
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const rec = (r) => JSON.stringify({ session: "s1", ...r }) + "\n";
  fs.writeFileSync(
    log,
    rec({ t: "T1", kind: "verify", text: "Shall I merge the 0.22.0 changes?\nExtension installed, 79 tests pass." }) +
      rec({ t: "T2", kind: "verify", text: "Shall I close #11?" }),
  );
  return { root, log };
}

test("audit: the agent's turn ticks settled steps and adds what it really asks, as short steps", async () => {
  const { root, log } = session();
  let asked = "";
  const res = await audit(log, { message: "PR #18 merged.\n\n👉 Shall I merge the new changes too?", request: "ok, merge", session: "s1" }, async (p) => {
    asked = p;
    return 'Sure:\n{"settled": ["A", "B", "Z"], "asks": ["Shall I merge the new changes?"]}';
  });
  // 👉 lines are the asks; the model writes them out clearly, as many as there are.
  assert.deepEqual(res, { settled: [1, 2], asks: ["Shall I merge the new changes?"], whys: [""], task: undefined });
  assert.match(asked, /A\. Shall I merge the 0\.22\.0 changes\?/);
  assert.match(asked, /<user_request>ok, merge<\/user_request>/);
  assert.match(asked, /<new_asks>\n- Shall I merge the new changes too\?/);
  assert.match(asked, /the new_asks rewritten: exactly 1 entry,/);
  const items = waitingItems(root);
  const t1 = items.find((i) => i.t === "T1");
  assert.deepEqual([t1.open, t1.chat[0]], [false, "audit: agent: PR #18 merged."]);
  assert.equal(items.find((i) => i.t === "T2").open, true);
  assert.deepEqual(openSteps(log).map((s) => s.text), ["Shall I close #11?", "Shall I merge the new changes?"]);
});

test("audit: an ask in nearly the same words replaces the old step, even if the model keeps it", async () => {
  const { log } = session();
  const res = await audit(log, { message: "👉 Shall I close #11 now?" }, async () => '{"settled": []}');
  assert.deepEqual(res.settled, [3]);
  assert.deepEqual(openSteps(log).map((s) => s.text), ["Shall I merge the 0.22.0 changes?", "Extension installed, 79 tests pass.", "Shall I close #11 now?"]);
  assert.ok(overlap("Chat sync is not committed yet; shall I commit and merge to main?", "Earlier changes (chat sync) are still not committed; shall I commit and merge to main?") >= 0.5);
  assert.ok(overlap("Shall I do both of them?", "Shall I close #11?") < 0.5);
});

test("audit: without 👉 lines the model writes the asks", async () => {
  const { log } = session();
  let asked = "";
  const res = await audit(log, { message: "Installed. You can open the panel and look at the badges." }, async (p) => ((asked = p), 'x\n{"settled": [], "asks": ["Open the panel and look at the badges"]}'));
  assert.deepEqual(res, { settled: [], asks: ["Open the panel and look at the badges"], whys: [""], task: undefined });
  assert.match(asked, /"asks"/);
  assert.deepEqual(pointedAsks("- Tried it with the 👉 message.\n👉 Shall I merge?"), ["Shall I merge?"]);
  assert.ok(openSteps(log).some((s) => s.text === "Open the panel and look at the badges"));
});

test("audit: the review alone (Audit button) only closes; a failed model falls back to the rules", async () => {
  const { root, log } = session();
  assert.doesNotMatch(auditPrompt(openSteps(log), {}), /"asks"/);
  await audit(log, {}, async () => '{"settled": ["B"]}');
  assert.deepEqual(openSteps(log).map((s) => s.n + s.text), ["1Shall I merge the 0.22.0 changes?", "2Shall I close #11?"]);
  assert.throws(() => parseAudit("no json", []));
  await auditTurn(log, { message: "Installed.\n👉 Can you check the panel?" }, async () => {
    throw new Error("offline");
  });
  assert.ok(waitingItems(root).some((i) => i.open && i.text === "Can you check the panel?"));
});

test("audit: asks are self-contained, with a why and the task; a rewrite that loses a 👉 line keeps them verbatim", async () => {
  const { root, log } = session();
  let asked = "";
  await audit(log, { message: "Mail is ready.\n👉 Send Tim the follow-up mail", request: "follow-up for LATD-13937", session: "s1" }, async (p) => (
    (asked = p),
    '{"settled": [], "asks": [{"text": "LATD-13937: Send Tim the follow-up mail for review !2690", "why": "The review has been waiting for two days."}], "task": "LATD-13937"}'
  ));
  assert.match(asked, /<task_hint>LATD-13937<\/task_hint>/);
  assert.match(asked, /make sense on its own a week later/);
  const step = waitingSteps(root).find((s) => s.text.startsWith("LATD-13937"));
  assert.deepEqual([step.why, step.task], ["The review has been waiting for two days.", "LATD-13937"]);
  // The model dropped a line: the agent's own words stay.
  const res = await audit(log, { message: "👉 Do A\n👉 Do B" }, async () => '{"settled": [], "asks": ["A and B"]}');
  assert.deepEqual(res.asks, ["Do A", "Do B"]);
  // A routine 👉 line next to a real ask is left out.
  const res2 = await audit(log, { message: "👉 Write to Tim\n👉 Reload Window" }, async () => '{"settled": [], "asks": [{"text": "LATD-1: Write to Tim"}, {"text": ""}]}');
  assert.deepEqual(res2.asks, ["LATD-1: Write to Tim"]);
});

test("audit: the model's JSON may be fenced and spread over lines", () => {
  const out = 'A: open, nobody answered\n```json\n{\n  "settled": [],\n  "asks": [{"text": "LATD-1: x", "why": "y"}],\n  "task": "LATD-1"\n}\n```';
  assert.deepEqual(parseAudit(out, []), { settled: [], asks: ["LATD-1: x"], whys: ["y"], task: "LATD-1", count: 1 });
});
