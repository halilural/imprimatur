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
    rec({ t: "T1", kind: "verify", text: "Reload Window yapıp açıklamalara bakar mısın?\nCommit edip main'e birleştireyim mi?" }) +
      rec({ t: "T2", kind: "answer", answer: "tamam birleştir" }),
  );
  return { root, log };
}

test("resolve: a chat decision ticks the steps it settles, marked as from chat", async () => {
  const { root, log } = session();
  assert.deepEqual(openSteps(log).map((s) => [s.n, s.i]), [[1, 0], [2, 1]]);
  let asked = "";
  const ticked = await resolve(log, "tamam birleştir", async (p) => ((asked = p), "A. open\nB. settled: \"tamam birleştir\"\nB"));
  assert.deepEqual(ticked, [2]);
  assert.match(asked, /B\. Commit edip main'e birleştireyim mi\?/);
  const [item] = waitingItems(root);
  assert.deepEqual([item.open, item.checked, item.chat], [true, [1], { 1: "tamam birleştir" }]);
  // Settling the other one closes the item.
  await resolve(log, "baktım, güzel", async () => "A");
  assert.equal(waitingItems(root)[0].open, false);
});

test("resolve: without the model, a reply answers the question steps", async () => {
  const { log } = session();
  fs.appendFileSync(log, JSON.stringify({ t: "T3", kind: "verify", text: "Paneli test et" }) + "\n");
  const ticked = await resolve(log, "olur", async () => {
    throw new Error("offline");
  });
  assert.deepEqual(ticked, [1, 2]); // both T1 lines end in "?"; "Paneli test et" stays
  const steps = [1, 2, 3].map((n) => ({ n, label: "ABC"[n - 1] }));
  assert.deepEqual(settledIn("A. open\nB. settled: \"şu 2'yi deneyelim\"\nB, C", steps), [2, 3]);
  assert.deepEqual(settledIn("2", steps), []); // a number is never a step
  assert.deepEqual(settledIn("none", steps), []);
});
