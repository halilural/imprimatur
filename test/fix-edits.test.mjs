import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseEdits, planEdits } = createRequire(import.meta.url)("../vscode/fix-edits.js");

test("fix edits (#156): the last edits block is read; only target files, an old text found once, in order", () => {
  const answer = "Done.\n```imprimatur-edits\n[{\"file\":\"/x\",\"old\":\"a\",\"new\":\"b\"}]\n```\nOn second thought:\n```imprimatur-edits\n" + JSON.stringify([
    { file: "/h/.claude/settings.json", old: "\"timeout\": 60", new: "\"timeout\": 30" },
    { file: "/h/.claude/settings.json", old: "\"timeout\": 30", new: "\"timeout\": 25" },
    { file: "/h/.ssh/config", old: "Host", new: "Evil" },
    { file: "/r/skills/issues/SKILL.md", old: "x", new: "y" },
    { file: "/r/a.md", old: "", new: "z" },
  ]) + "\n```";
  const edits = parseEdits(answer);
  assert.equal(edits.length, 5, "the last block wins");
  const text = { "/h/.claude/settings.json": "{\"timeout\": 60}", "/r/skills/issues/SKILL.md": "x and x", "/r/a.md": "a" };
  const { files, skipped } = planEdits(edits, ["/h/.claude/settings.json", "/r/skills/issues/SKILL.md", "/r/a.md"], (f) => text[f]);
  assert.deepEqual([...files.keys()], ["/h/.claude/settings.json"]);
  assert.equal(files.get("/h/.claude/settings.json").after, "{\"timeout\": 25}");
  assert.deepEqual(skipped.map((s) => s.why), ["not one of this fix's files", "the old text is found 2 times", "no old text"]);
  assert.deepEqual(parseEdits("no block"), []);
  assert.deepEqual(parseEdits("```imprimatur-edits\nnot json\n```"), []);
  const dollar = planEdits([{ file: "/r/a.md", old: "a", new: "$& $1" }], ["/r/a.md"], () => "a");
  assert.equal(dollar.files.get("/r/a.md").after, "$& $1", "replacement text is literal");
});

test("fix edits (#156): dismissals by number, a known reason, once each, within the list", () => {
  const { parseDismissals } = createRequire(import.meta.url)("../vscode/fix-edits.js");
  const answer = "```imprimatur-dismiss\n" + JSON.stringify([
    { n: 4, reason: "local", why: "60s is\nintended" }, { n: 5, reason: "plugin", why: "a plugin's AGENTS.md" }, { n: 4, reason: "false", why: "again" },
    { n: 9, reason: "false", why: "out of range" }, { n: 2, reason: "delete-everything", why: "x" }, { n: "3", reason: "false", why: "not a number" },
  ]) + "\n```";
  assert.deepEqual(parseDismissals(answer, 8), [{ n: 4, reason: "local", why: "60s is intended" }, { n: 5, reason: "plugin", why: "a plugin's AGENTS.md" }]);
  assert.deepEqual(parseDismissals("none", 8), []);
});
