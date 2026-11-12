// Agent rule files that repeat or contradict each other (#213).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const { ruleDrift, driftRows } = createRequire(import.meta.url)("../vscode/rule-drift.js");

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-213-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

test("rule drift: a shared rule is one repeat; an always/never pair may contradict; imports, headings, tables and the generated file add nothing", () => {
  const root = repo({
    "AGENTS.md": "# Rules\n\n- Run the full test suite before every commit.\n- Keep components outside the app folder please.\n| Layer | Path with enough characters |\n",
    "CLAUDE.md": "@AGENTS.md\n\n## Claude only\n\n- Never run the full test suite before every commit.\n",
    ".cursor/rules/x.mdc": "---\ndescription: x\n---\n- Keep components outside the app folder please.\n",
    ".claude/rules/imprimatur.md": "- Keep components outside the app folder please.\n",
  });
  const d = ruleDrift(root);
  assert.deepEqual(d.files, ["CLAUDE.md", "AGENTS.md", ".cursor/rules/x.mdc"]);
  assert.deepEqual(d.repeated.map((r) => r.at.map((a) => a.file)), [["AGENTS.md", ".cursor/rules/x.mdc"]]);
  assert.deepEqual(d.conflicts.map((c) => [c.a.file, c.b.file, c.why]), [["CLAUDE.md", "AGENTS.md", "one says not, the other does"]]);
  assert.deepEqual(driftRows(root, d).map((r) => r.label), ["Agent files: 1 rule repeated in several files", "Agent files: 1 rule may contradict"]);
});

test("rule drift: rules under a Don't heading or a Never label are nots, so the same rule there and as a not elsewhere agrees", () => {
  const root = repo({
    "AGENTS.md": "## Don't\n\n- Commit secrets like .env files or tokens.\n",
    "CLAUDE.md": "- **Never**:\n  - Commit secrets like .env files or tokens, ever.\n- Write the tests first for every change made.\n",
    "GEMINI.md": "- Write the tests first for every change made in 2 steps.\n",
  });
  const d = ruleDrift(root);
  assert.deepEqual(d.conflicts.map((c) => c.why), ["the numbers differ"], "the secrets rule agrees; only the numbers differ elsewhere");
});
