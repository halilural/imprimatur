import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksIn, recordOf, recordWaiting } from "../hooks/waiting.mjs";

const { itemsOf, waitingItems } = createRequire(import.meta.url)("../vscode/waiting.js");

test("waiting: asks in a final message, code and tables skipped", () => {
  const msg = [
    "Değişiklikler hazır, 64 test geçiyor.",
    "",
    "| a | b? |",
    "```",
    "why?",
    "```",
    "- **Gözle:** Reload Window yap, panel açılıyor mu kontrol et.",
    "Başlayayım mı?",
  ].join("\n");
  assert.deepEqual(asksIn(msg), { lines: ["Gözle: Reload Window yap, panel açılıyor mu kontrol et.", "Başlayayım mı?"], question: true });
  assert.deepEqual(asksIn("Done. Nothing committed yet."), { lines: [], question: false });
  assert.deepEqual(asksIn("Please verify the panel in VS Code."), { lines: ["Please verify the panel in VS Code."], question: false });
});

test("waiting: hook events to records", () => {
  const q = recordOf({
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which tab?", options: [{ label: "Same", description: "one table" }, { label: "Own" }] }] },
  });
  assert.deepEqual(q, { kind: "question", text: "Which tab?", detail: "Which tab?\n  • Same — one table\n  • Own" });
  assert.deepEqual(recordOf({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push\n", description: "Push" } }), {
    kind: "command",
    text: "Bash: git push",
    detail: "Push\n\ngit push\n",
  });
  assert.deepEqual(recordOf({ hook_event_name: "Stop", last_assistant_message: "All done." }), { kind: "step", closeOnly: true });
  assert.equal(recordOf({ hook_event_name: "Stop", last_assistant_message: "Shall I commit?" }).kind, "question");
  assert.equal(recordOf({ hook_event_name: "Stop", last_assistant_message: "Lütfen panelde test et." }).kind, "verify");
  assert.deepEqual(recordOf({ hook_event_name: "UserPromptSubmit", prompt: "evet\nbaşla" }), { kind: "answer", answer: "evet", closeOnly: true });
  assert.deepEqual(recordOf({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_response: { answers: { "Which tab?": "Own" } } }), {
    kind: "answer",
    answer: "Own",
    closeOnly: true,
  });
  assert.equal(recordOf({ hook_event_name: "Notification", notification_type: "idle_prompt" }), undefined);
  assert.equal(recordOf({ hook_event_name: "Notification", notification_type: "agent_needs_input", message: "Pick one" }).kind, "input");
  assert.equal(recordOf({ hook_event_name: "PreToolUse", tool_name: "Edit" }), undefined);
});

test("waiting: each record closes the session's earlier open items, answers carry the reply", () => {
  const items = itemsOf(
    [
      { t: "2026-10-05T10:00:00Z", kind: "command", text: "Bash: git push" },
      { t: "2026-10-05T10:00:05Z", kind: "question", text: "Shall I commit?" },
      { t: "2026-10-05T10:01:00Z", kind: "answer", answer: "evet" },
      { t: "2026-10-05T10:02:00Z", kind: "verify", text: "Reload Window" },
    ],
    "s1",
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.open, i.answer]),
    [
      ["command", false, undefined],
      ["question", false, "evet"],
      ["verify", true, undefined],
    ],
  );
});

test("waiting: the hook writes per-session logs; quiet events start none", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-waiting-"));
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  assert.equal(recordWaiting({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" }, root), undefined);
  assert.equal(fs.existsSync(log), false);
  assert.equal(recordWaiting({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: "Shall I start?" }, root), log);
  recordWaiting({ hook_event_name: "Stop", session_id: "s2", last_assistant_message: "Test et lütfen." }, root);
  recordWaiting({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "evet" }, root);
  const items = waitingItems(root);
  assert.deepEqual(
    items.map((i) => [i.session, i.kind, i.open, i.answer ?? null]),
    [
      ["s2", "verify", true, null],
      ["s1", "question", false, "evet"],
    ],
  );
});

test("waiting: no logs, no items", () => {
  assert.deepEqual(waitingItems(fs.mkdtempSync(path.join(os.tmpdir(), "agent-waiting-"))), []);
});
