// #210: an approved list is done, not asked about again.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { isApproval, lastUserText, reaskFinding } = require("../vscode/approvals.js");
const { check } = require("../vscode/process.js");

const transcript = (last) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imp-ap-")), "t.jsonl");
  const rows = [{ type: "user", message: { content: "earlier question?" } }, { type: "assistant", message: { content: [{ type: "text", text: "👉 do X?" }] } },
    { type: "user", message: { content: last } }, { type: "assistant", message: { content: [{ type: "tool_use", id: "1", name: "Bash", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] } }];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return f;
};

test("isApproval: short approvals in Turkish and English; a question or a long message is not one", () => {
  for (const t of ["hepsini yap", "Hepsini yap.", "okey devam", "devam", "tamam", "evet", "yes", "do all", "go ahead", "ok, devam et"]) assert.ok(isApproval(t), t);
  assert.ok(isApproval("hepsini yap neden surekli bana sorup duruyorsun? bunun icin imprimatur da birsey yok muydu"), "a strong approval leads a long message");
  for (const t of ["evet ama önce bana neyin değiştiğini anlat, sonra karar vereceğim", "neden?", "hayır", "bunu yapma", "yapma", undefined]) assert.ok(!isApproval(t), String(t));
});

test("lastUserText: the user's own last message, not a tool result", () => {
  assert.equal(lastUserText(transcript("hepsini yap")), "hepsini yap");
});

test("reaskFinding and the Stop hook: an approval answered with 👉 asks sends the agent back once", () => {
  assert.match(reaskFinding("Done some.\n\n👉 Silinsin mi?", transcript("hepsini yap")), /user approved \("hepsini yap"\).*1 👉 line/);
  assert.equal(reaskFinding("Hepsi yapıldı.", transcript("hepsini yap")), undefined, "no ask, no finding");
  assert.equal(reaskFinding("👉 Hangisi?", transcript("bu ne işe yarıyor")), undefined, "not an approval");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-ap-repo-"));
  execFileSync("git", ["init", "-q", root]);
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude/imprimatur.json"), JSON.stringify({ process: { status: false, keepGoing: false, issueFields: false, evidence: false } }));
  const input = { cwd: root, session_id: "s", transcript_path: transcript("hepsini yap"), last_assistant_message: "👉 Commit atayım mı?" };
  assert.match(check("Stop", input, { records: { repoId: () => undefined } }).block ?? "", /reask/);
  assert.equal(check("Stop", { ...input, stop_hook_active: true }, { records: { repoId: () => undefined } }).block, undefined, "once: not again after the agent went back");
  fs.rmSync(root, { recursive: true, force: true });
});
