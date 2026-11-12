// A warning the agent keeps getting becomes a blocking hook (#218).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { candidates, makeBlock } = req("../vscode/warn-to-block.js");
const { checkFindings } = req("../vscode/ticket-tokens.js");

test("warn to block: a warn check with 5 findings in 2 sessions is suggested; fewer, one session, block mode, off or context lines are not", () => {
  const f = new Map([["designFirst", { count: 5, sessions: 2 }], ["docUpdate", { count: 4, sessions: 3 }], ["issueFields", { count: 9, sessions: 1 }],
    ["status", { count: 9, sessions: 3 }], ["sweep", { count: 9, sessions: 3 }], ["issueCreate", { count: 50, sessions: 5 }], ["repoLang", { count: 50, sessions: 5 }]]);
  const settings = { designFirst: { mode: "warn" }, docUpdate: { mode: "warn" }, issueFields: { mode: "warn" }, status: { mode: "block" }, sweep: { mode: false }, issueCreate: { mode: "warn" } };
  assert.deepEqual(candidates(f, settings).map((c) => c.name), ["designFirst"]);
  assert.deepEqual(candidates(f, undefined), []);
});

test("warn to block: makeBlock writes block, keeping an object setting's other fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-218-"));
  fs.mkdirSync(path.join(root, ".claude"));
  const file = path.join(root, ".claude", "imprimatur.json");
  fs.writeFileSync(file, JSON.stringify({ lang: "English", process: { mainGuard: { mode: "warn", branch: "main", allow: ["^docs/"] } } }));
  makeBlock(root, "mainGuard");
  makeBlock(root, "designFirst");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { lang: "English", process: { mainGuard: { mode: "block", branch: "main", allow: ["^docs/"] }, designFirst: "block" } });
});

test("warn to block: findings are counted from the hook output the agent was given, not from text that quotes it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-218t-"));
  const t = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "s.jsonl"), [
    JSON.stringify({ type: "attachment", sessionId: "A", timestamp: t, attachment: { type: "hook_success", content: "Imprimatur (designFirst): #5 has no spec" } }),
    JSON.stringify({ type: "attachment", sessionId: "B", timestamp: t, attachment: { type: "hook_success", content: "Imprimatur (designFirst): x\nImprimatur (designFirst): y" } }),
    JSON.stringify({ type: "assistant", sessionId: "A", timestamp: t, message: { id: "m", content: [{ type: "text", text: "Imprimatur (docUpdate) said so" }] } }),
  ].join("\n") + "\n");
  assert.deepEqual([...checkFindings(dir, 0)], [["designFirst", { count: 2, sessions: 2 }]]);
});
