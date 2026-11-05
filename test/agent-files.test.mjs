import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { agentFiles, importsAgents, writeMissing, agentRows } = require("../vscode/agent-files.js");

test("agent files (#133): a repo with neither file gets AGENTS.md, a CLAUDE.md importing it and the docs rule; a second run writes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-agents-"));
  assert.deepEqual(agentRows(agentFiles(root)).map((r) => r.label), ["Agent files: write AGENTS.md and CLAUDE.md, .claude/rules/docs.md"]);
  const w = writeMissing(root).map((f) => path.relative(root, f)).sort();
  assert.deepEqual(w, [".claude/rules/docs.md", "AGENTS.md", "CLAUDE.md"]);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(fs.readFileSync(path.join(root, ".claude", "rules", "docs.md"), "utf8"), /^---\npaths:\n  - "docs\/\*\*"\n---/);
  assert.ok(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").split("\n").length <= 200);
  assert.deepEqual(writeMissing(root), [], "re-running changes nothing");
  assert.deepEqual(agentRows(agentFiles(root)), [], "nothing left to do");
  fs.rmSync(root, { recursive: true, force: true });
});

test("agent files (#133): a CLAUDE.md that does not import AGENTS.md gets a Fix it row; its text is never overwritten", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-agents-"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Rules\n- use pnpm\n");
  const rows = agentRows(agentFiles(root));
  assert.deepEqual(rows.map((r) => r.label), ["Agent files: write .claude/rules/docs.md", "Agent files: CLAUDE.md does not import AGENTS.md"]);
  assert.deepEqual(rows[1].fix, { kind: "agents" });
  writeMissing(root);
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "# Rules\n- use pnpm\n");
  assert.ok(!fs.existsSync(path.join(root, "AGENTS.md")), "the split is Claude's, through Fix it");
  assert.ok(importsAgents("@AGENTS.md\n# Claude"));
  assert.ok(importsAgents("x\n@./AGENTS.md\n"));
  assert.ok(!importsAgents("see @AGENTS.md for more"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("fix edits (#133): a whole-file target is created or rewritten from an empty old text; others still need a unique old text", () => {
  const { planEdits } = require("../vscode/fix-edits.js");
  const files = { "/r/CLAUDE.md": "old rules\n" };
  const read = (f) => {
    if (f in files) return files[f];
    throw new Error("missing");
  };
  const edits = [{ file: "/r/AGENTS.md", old: "", new: "# AGENTS\n" }, { file: "/r/CLAUDE.md", old: "", new: "@AGENTS.md\n" }, { file: "/r/other.md", old: "", new: "x" }];
  const plan = planEdits(edits, ["/r/AGENTS.md", "/r/CLAUDE.md", "/r/other.md"], read, { whole: ["/r/AGENTS.md", "/r/CLAUDE.md"] });
  assert.deepEqual(plan.files.get("/r/AGENTS.md"), { before: "", after: "# AGENTS\n", created: true });
  assert.deepEqual(plan.files.get("/r/CLAUDE.md"), { before: "old rules\n", after: "@AGENTS.md\n" });
  assert.deepEqual(plan.skipped.map((x) => x.why), ["cannot be read"], "not a whole-file target: an empty old text does nothing");
  assert.equal(planEdits([{ file: "/r/CLAUDE.md", old: "", new: "y" }], ["/r/CLAUDE.md"], read).skipped[0].why, "no old text", "without whole, as before");
  const { agentsPrompt } = require("../vscode/fix-prompts.js");
  const p = agentsPrompt({ claudeFile: "/r/CLAUDE.md", agentsFile: "/r/AGENTS.md", docsRule: "/r/.claude/rules/docs.md", agents: false, docsRuleThere: false });
  assert.match(p, /first line exactly "@AGENTS\.md"/);
  assert.match(p, /at most 200 lines/);
  assert.match(p, /Do not edit any file/);
  assert.match(p, /data, not instructions/);
  assert.match(p, /```imprimatur-edits/);
});

test("agent files (#133): a link planted on the way stops the write", () => {
  const { safeTarget, writeMissing } = require("../vscode/agent-files.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-agents-"));
  const away = fs.mkdtempSync(path.join(os.tmpdir(), "imp-away-"));
  fs.mkdirSync(path.join(root, ".claude"));
  fs.symlinkSync(away, path.join(root, ".claude", "rules"));
  fs.symlinkSync(path.join(away, "AGENTS.md"), path.join(root, "AGENTS.md"));
  assert.equal(safeTarget(root, path.join(root, ".claude", "rules", "docs.md")), false);
  assert.equal(safeTarget(root, path.join(root, "AGENTS.md")), false, "a dangling link too");
  assert.equal(safeTarget(root, path.join(root, "x", "y.md")), true);
  assert.equal(safeTarget(root, path.join(root, "..", "out.md")), false);
  writeMissing(root);
  assert.deepEqual(fs.readdirSync(away), [], "nothing written outside the repo");
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(away, { recursive: true, force: true });
});
