import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { checklistOf } = createRequire(import.meta.url)("../vscode/setup-checklist.js");

test("checklist (#142): outdated plugins, upstream changes, health problems and open recommendations, each with an action; empty says so", () => {
  const plugin = { label: "ponytail@ponytail", summary: "v4.10.0 · project scope · update available: v5.3.3", update: { id: "ponytail@ponytail" } };
  const skill = { label: "etf", summary: "upstream changed 2026-10-24 · from x", compare: "https://github.com/a/b/compare/1...2" };
  const { count, node } = checklistOf([
    { label: "investment", global: false, items: [plugin], health: [{ file: "/r/.claude/settings.json", level: "error", message: "Not valid JSON", line: 3 }] },
    { label: "Global (~)", global: true, items: [{ label: "nested", summary: "", children: [skill] }], health: [] },
  ], 2);
  assert.equal(count, 4);
  assert.equal(node.description, "4 to do");
  const [u, r, h, recs] = node.children;
  assert.deepEqual([u.label, u.description, u.command, u.args[0].item], ["Update ponytail@ponytail", "investment · v5.3.3", "imprimatur.setup.updatePlugin", plugin]);
  assert.deepEqual([r.label, r.description, r.command], ["Review the upstream change of etf", "2026-10-24", "imprimatur.setup.showUpstream"]);
  assert.deepEqual([h.label, h.abs, h.line, h.icon], ["Not valid JSON", "/r/.claude/settings.json", 3, "error"]);
  assert.deepEqual([recs.label, recs.command], ["2 open recommendations", "imprimatur.setup.audit"]);
  for (const row of node.children) assert.ok(row.tooltip && (row.command || row.abs), `${row.label} says what to do and has an action`);
  const none = checklistOf([{ label: "x", global: false, items: [{ label: "fine", summary: "v1" }], health: [] }], 0);
  assert.deepEqual([none.count, none.node.description], [0, "nothing to do"]);
});
