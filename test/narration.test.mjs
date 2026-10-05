import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { narrationOf } = createRequire(import.meta.url)("../vscode/narration.js");

test("narration: the text written in the same message as the tool call, read as the transcript grows", () => {
  const tr = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-narration-")), "t.jsonl");
  const rec = (id, content) => JSON.stringify({ type: "assistant", message: { id, content: [content] } }) + "\n";
  // The call is in the transcript before its text (as Claude Code writes it).
  fs.writeFileSync(tr, rec("m1", { type: "text", text: "Earlier words." }) + rec("m2", { type: "tool_use", id: "t2" }) + '{"type":"assis');
  assert.equal(narrationOf(tr, "t2"), undefined);
  fs.writeFileSync(tr, rec("m1", { type: "text", text: "Earlier words." }) + rec("m2", { type: "tool_use", id: "t2" }));
  fs.appendFileSync(tr, rec("m2", { type: "text", text: "Tim'e cevabı TODO'ya yazıyorum. Sonra testler.\nikinci satır" }) + rec("m3", { type: "tool_use", id: "t3" }));
  assert.equal(narrationOf(tr, "t2"), "Tim'e cevabı TODO'ya yazıyorum.");
  assert.equal(narrationOf(tr, "t3"), undefined); // a call without words of its own
  fs.appendFileSync(tr, rec("m4", { type: "text", text: "Deneyelim. İki düzenleme yapıyorum. Sonra bakarız." }) + rec("m4", { type: "tool_use", id: "t4" }));
  assert.equal(narrationOf(tr, "t4"), "Deneyelim. İki düzenleme yapıyorum.");
  assert.equal(narrationOf(path.join(path.dirname(tr), "gone.jsonl"), "t2"), undefined);
  assert.equal(narrationOf(undefined, "t2"), undefined);
});
