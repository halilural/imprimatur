import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { jobsOf, handlers, runAutopilot, reportMarkdown, summaryLine } = require("../vscode/autopilot.js");
const { undoLog, undo } = require("../vscode/fix-engine.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const answer = (edits) => `\`\`\`imprimatur-edits\n${JSON.stringify(edits)}\n\`\`\`\n`;

test("autopilot: checklist rows become jobs; installs and rows without a fix are the user's (#231)", () => {
  const rows = [
    { label: "Rule broken often: designFirst", command: "imprimatur.setup.blockCheck", args: [{ root: "/r", name: "designFirst", count: 44 }] },
    { label: "Update x@m", command: "imprimatur.setup.updatePlugin", args: [{ item: { update: { id: "x@m", scope: "user" } } }] },
    { label: "bad hook", fix: { kind: "health", problem: { file: "/r/.claude/settings.json", message: "bad hook" } } },
    { label: "2 open recommendations", fix: { kind: "findings" } },
    { label: "Documents: 78 possibly stale", command: "imprimatur.staleDocs" },
    { label: "Install superpowers", command: "imprimatur.setup.installBaseline", description: "a third-party plugin" },
  ];
  const kinds = jobsOf(rows, { files: [{ id: 1 }], docs: [{ id: 2 }] }).map((j) => j.kind);
  assert.deepEqual(kinds, ["block", "plugin", "health", "findings", "docs", "stale", "manual"]);
});

test("autopilot: a run fixes what it may, logs each change for undo, and reports the rest (#231)", async () => {
  const root = tmp("autopilot-repo-"), dir = tmp("autopilot-data-");
  fs.mkdirSync(path.join(root, ".claude"));
  const cfg = path.join(root, ".claude", "imprimatur.json");
  fs.writeFileSync(cfg, JSON.stringify({ lang: "English" }));
  const hook = path.join(root, ".claude", "settings.json");
  fs.writeFileSync(hook, '{"hooks": "wrong"}\n');
  const jobs = jobsOf([
    { label: "Rule broken often: docUpdate", command: "imprimatur.setup.blockCheck", args: [{ root, name: "docUpdate" }] },
    { label: "hooks is not an object", fix: { kind: "health", problem: { file: hook, message: "hooks is not an object" } } },
    { label: "Install superpowers", command: "imprimatur.setup.installBaseline", description: "third-party code: one click" },
  ]);
  const prompts = [];
  const ctx = { dir, runId: "run1", at: "2026-11-19T10:00:00Z", root,
    run: async (p, files) => (prompts.push({ p, files }), { code: 0, stdout: answer([{ file: hook, old: '"wrong"', new: "{}" }]), stderr: "" }) };
  const report = await runAutopilot(jobs, handlers(ctx), { runId: "run1", at: ctx.at });
  assert.equal(summaryLine(report), "2 fixed · 0 not fixed · 1 need you");
  assert.equal(JSON.parse(fs.readFileSync(cfg, "utf8")).process.docUpdate, "block");
  assert.equal(fs.readFileSync(hook, "utf8"), '{"hooks": {}}\n');
  assert.deepEqual(prompts[0].files, [hook]);
  assert.match(reportMarkdown(report), /## Needs you\n\n- \*\*Install superpowers\*\*: third-party code/);
  // Both changes can be put back.
  const lines = undoLog(dir);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(undo(dir, l).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(cfg, "utf8")).process, undefined);
  assert.equal(fs.readFileSync(hook, "utf8"), '{"hooks": "wrong"}\n');
});

test("autopilot: a failed agent run or a throwing job is reported and changes nothing (#231)", async () => {
  const root = tmp("autopilot-repo-"), dir = tmp("autopilot-data-");
  const f = path.join(root, "x.json");
  fs.writeFileSync(f, "{}\n");
  const jobs = [{ kind: "health", label: "x", problem: { file: f, message: "m" } }, { kind: "block", label: "y", root, name: "z" }];
  const report = await runAutopilot(jobs, handlers({ dir, runId: "r", at: "t", root, run: async () => ({ code: 1, stdout: "", stderr: "limit reached" }) }), { runId: "r", at: "t" });
  assert.equal(report.fixed.length, 0);
  assert.equal(report.failed.length, 2);
  assert.match(report.failed[0].note, /limit reached/);
  assert.equal(fs.readFileSync(f, "utf8"), "{}\n");
});
