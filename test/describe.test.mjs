import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, diffText, cleanSentence, editTexts } from "../hooks/describe.mjs";

const { graphRows } = createRequire(import.meta.url)("../vscode/graph.js");

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-describe-"));
  const h = path.join(root, ".claude/imprimatur/history");
  fs.mkdirSync(h, { recursive: true });
  const row = (toolUseId, before) => JSON.stringify({ t: "2026-10-05T10:00:00Z", session: "s1", toolUseId, before }) + "\n";
  fs.writeFileSync(path.join(h, "a.md.jsonl"), row("t1", "a\n") + row("t2", "a\nb\n"));
  fs.writeFileSync(path.join(root, "a.md"), "a\nB\n");
  return root;
}

test("describe: an edit's change is its before ↔ the next edit's before (or the file now)", () => {
  const root = repo();
  assert.deepEqual(editTexts(root, "a.md", "t1"), { before: "a\n", after: "a\nb\n" });
  assert.deepEqual(editTexts(root, "a.md", "t2"), { before: "a\nb\n", after: "a\nB\n" });
  assert.equal(editTexts(root, "a.md", "nope"), undefined);
  assert.deepEqual(editTexts(root, "a.md", "#1"), editTexts(root, "a.md", "t1"));
  assert.equal(editTexts(root, "a.md", "#3"), undefined);
  assert.equal(diffText("a\nb\n", "a\nB\nc\n"), "@@\n- b\n+ B\n+ c");
});

test("describe: the model's sentence goes to descriptions.jsonl and becomes the graph's description", async () => {
  const root = repo();
  let asked = "";
  const text = await describe(root, "a.md", "t2", "Turkish", async (p) => {
    asked = p;
    return '\n"b satırı büyük harfe çevrildi."\n';
  });
  assert.equal(text, "b satırı büyük harfe çevrildi.");
  assert.match(asked, /In Turkish/);
  assert.match(asked, /- b\n\+ B/);
  const rows = graphRows(root).rows;
  assert.equal(rows.find((r) => r.n === 2).intent, "b satırı büyük harfe çevrildi.");
  assert.equal(rows.find((r) => r.n === 1).intent, undefined);
});

test("describe: an unchanged edit or a failed call leaves no line", async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "a.md"), "a\nb\n");
  assert.equal(await describe(root, "a.md", "t2", "English", async () => "x"), undefined);
  await assert.rejects(describe(root, "a.md", "t1", "English", async () => { throw new Error("offline"); }));
  assert.equal(fs.existsSync(path.join(root, ".claude/imprimatur/descriptions.jsonl")), false);
  assert.equal(cleanSentence("**Added a line.**\nmore"), "Added a line.");
});
