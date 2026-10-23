import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openSteps, resolve, settledIn } from "../hooks/resolve.mjs";

const { waitingItems } = createRequire(import.meta.url)("../vscode/waiting.js");

function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resolve-"));
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const rec = (r) => JSON.stringify({ session: "s1", ...r }) + "\n";
  fs.writeFileSync(
    log,
    rec({ t: "T1", kind: "verify", text: "Can you reload the window and read the descriptions?\nShall I commit and merge to main?" }) +
      rec({ t: "T2", kind: "answer", answer: "ok, merge" }),
  );
  return { root, log };
}

test("resolve: a chat decision ticks the steps it settles, marked as from chat", async () => {
  const { root, log } = session();
  assert.deepEqual(openSteps(log).map((s) => [s.n, s.i]), [[1, 0], [2, 1]]);
  let asked = "";
  const ticked = await resolve(log, "ok, merge", async (p) => ((asked = p), "A. open\nB. settled: \"ok, merge\"\nB"));
  assert.deepEqual(ticked, [2]);
  assert.match(asked, /B\. Shall I commit and merge to main\?/);
  const [item] = waitingItems(root);
  assert.deepEqual([item.open, item.checked, item.chat], [true, [1], { 1: "ok, merge" }]);
  // Settling the other one closes the item.
  await resolve(log, "I looked, nice", async () => "A");
  assert.equal(waitingItems(root)[0].open, false);
});

test("resolve: without the model, a reply answers the question steps", async () => {
  const { log } = session();
  fs.appendFileSync(log, JSON.stringify({ t: "T3", kind: "verify", text: "Test the panel" }) + "\n");
  const ticked = await resolve(log, "sure", async () => {
    throw new Error("offline");
  });
  assert.deepEqual(ticked, [1, 2]); // both T1 lines end in "?"; "Test the panel" stays
  const steps = [1, 2, 3].map((n) => ({ n, label: "ABC"[n - 1] }));
  assert.deepEqual(settledIn("A. open\nB. settled: \"let's try that 2\"\nB, C", steps), [2, 3]);
  assert.deepEqual(settledIn("2", steps), []); // a number is never a step
  assert.deepEqual(settledIn("none", steps), []);
});

test("resolve: a message naming a task weighs its steps from other sessions, ticked in their own log (#43)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resolve-"));
  const dir = path.join(root, ".claude/imprimatur/waiting");
  fs.mkdirSync(dir, { recursive: true });
  const write = (s, ...rs) => fs.writeFileSync(path.join(dir, `${s}.jsonl`), rs.map((r) => JSON.stringify({ session: s, ...r }) + "\n").join(""));
  write("a", { t: "2026-10-06T08:00:00Z", kind: "question", text: "Should LATD-13977 be closed?", task: "LATD-13977" });
  write("b", { t: "2026-10-06T08:10:00Z", kind: "verify", text: "Do the A/B fix", task: "LATD-13977" });
  write("c", { t: "2026-10-06T08:20:00Z", kind: "verify", text: "Send Tim a mail", task: "LATD-13937" });
  const here = path.join(dir, "here.jsonl"); // the session the user writes in: no log yet
  let asked = "";
  const ticked = await resolve(here, "13977 closed", async (p) => ((asked = p), "A. settled\nB. settled\nA, B"));
  assert.deepEqual(ticked, [1, 2]);
  assert.match(asked, /A\. \(LATD-13977, asked in another session\) Should LATD-13977 be closed\?/);
  assert.doesNotMatch(asked, /Tim/); // another task: not shown
  assert.equal(fs.existsSync(here), false);
  const items = waitingItems(root);
  assert.deepEqual(items.filter((i) => i.open).map((i) => i.session), ["c"]); // the question closes too, once ticked
  // Without the model, another session's steps are never guessed.
  write("d", { t: "2026-10-06T08:30:00Z", kind: "question", text: "Approval for LATD-13990?", task: "LATD-13990" });
  assert.deepEqual(await resolve(here, "LATD-13990 ok", async () => { throw new Error("offline"); }), []);
});
