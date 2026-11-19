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
    { label: "Review the upstream change of tdd", fix: { kind: "skill", item: {} } },
  ];
  const kinds = jobsOf(rows, { files: [{ id: 1 }], docs: [{ id: 2 }] }).map((j) => j.kind);
  assert.deepEqual(kinds, ["block", "plugin", "health", "findings", "docs", "stale", "manual", "skill"]);
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

test("autopilot: drift writes only this repo's copy, never a hook; a repo's duplicate skill goes only when the whole folder matches (#232)", async () => {
  const a = tmp("autopilot-a-"), b = tmp("autopilot-b-"), home = tmp("autopilot-home-"), dir = tmp("autopilot-data-");
  const fa = path.join(a, ".claude", "rules", "x.md"), fb = path.join(b, ".claude", "rules", "x.md");
  for (const f of [fa, fb]) fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(fa, "use a\n");
  fs.writeFileSync(fb, "use b\n");
  const skill = (root, name, text, extra) => {
    const d = path.join(root, ".claude", "skills", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), text);
    if (extra) fs.writeFileSync(path.join(d, "ref.md"), extra);
    return d;
  };
  const mine = skill(a, "tdd", "same\n"), user = skill(home, "tdd", "same\n");
  const partly = skill(a, "grill", "same\n", "mine\n"), userGrill = skill(home, "grill", "same\n", "theirs\n");
  const jobs = jobsOf([], {}, {
    drift: [{ rel: ".claude/rules/x.md", files: [fa, fb] }, { rel: ".claude/hooks/x.sh", files: [path.join(a, ".claude/hooks/x.sh"), path.join(b, ".claude/hooks/x.sh")] }],
    clashes: [{ name: "tdd", from: [{ source: "project", dir: mine }, { source: "user", dir: user }] }, { name: "grill", from: [{ source: "project", dir: partly }, { source: "user", dir: userGrill }] }],
  });
  assert.deepEqual(jobs.map((j) => j.kind), ["drift", "drift", "clash", "clash"]);
  const seen = [];
  const run = async (p, files) => (seen.push(files), { code: 0, stdout: answer([{ file: fa, old: "", new: "use merged\n" }, { file: fb, old: "", new: "use merged\n" }]), stderr: "" });
  const report = await runAutopilot(jobs, handlers({ dir, runId: "d1", at: "t", root: a, run }), { runId: "d1", at: "t" });
  assert.equal(fs.readFileSync(fa, "utf8"), "use merged\n");
  assert.equal(fs.readFileSync(fb, "utf8"), "use b\n", "another repo's copy is not written");
  assert.equal(seen.length, 1, "the hook's drift never reaches the agent");
  // Only plain rules prose is merged alone: a command or skill can hold shell lines and tool grants.
  const cmd = jobsOf([], {}, { drift: [{ rel: ".claude/commands/deploy.md", files: [fa, fb] }, { rel: ".claude/RULES/Y.MD", files: [fa, fb] }, { rel: "AGENTS.md", files: [fa, fb] }] });
  const r2 = await runAutopilot(cmd, handlers({ dir, runId: "d2", at: "t", root: a, run }), { runId: "d2", at: "t" });
  assert.deepEqual([r2.manual.length, r2.fixed.length + r2.failed.length], [2, 1], "a repo's AGENTS.md is its own");
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(partly), true, "a skill whose other files differ stays");
  assert.equal(summaryLine(report), "2 fixed · 0 not fixed · 2 need you");
  const removed = undoLog(dir).find((l) => l.removed);
  assert.equal(undo(dir, removed).ok, true);
  assert.equal(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8"), "same\n");
});

test("autopilot: a personal rule in several repos moves to ~/.claude/rules; a tracked one is the user's (#233)", async () => {
  const a = tmp("autopilot-a-"), b = tmp("autopilot-b-"), home = tmp("autopilot-home-"), dir = tmp("autopilot-data-");
  const put = (root, rel, text) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  const fa = put(a, ".claude/rules/pnpm.md", "Use pnpm.\n"), fb = put(b, ".claude/rules/pnpm.md", "Use pnpm.\n");
  const ta = put(a, ".claude/rules/team.md", "Team rule.\n"), tb = put(b, ".claude/rules/team.md", "Team rule.\n");
  const jobs = jobsOf([], {}, { shared: [{ rel: ".claude/rules/pnpm.md", files: [fa, fb] }, { rel: ".claude/rules/team.md", files: [ta, tb] }, { rel: ".claude/commands/x.md", files: [fa, fb] }] });
  assert.deepEqual(jobs.map((j) => j.kind), ["promote", "promote"], "only rules files are shared");
  const tracked = (f) => f.endsWith("team.md");
  const report = await runAutopilot(jobs, handlers({ dir, runId: "p1", at: "t", root: a, home, tracked }), { runId: "p1", at: "t" });
  const global = path.join(home, ".claude", "rules", "pnpm.md");
  assert.equal(fs.readFileSync(global, "utf8"), "Use pnpm.\n");
  assert.equal(fs.existsSync(fa) || fs.existsSync(fb), false);
  assert.equal(fs.existsSync(ta) && fs.existsSync(tb), true, "a tracked rule stays for the team");
  assert.equal(summaryLine(report), "1 fixed · 0 not fixed · 1 need you");
  // Undo, newest first: the copies come back and the global file goes.
  for (const l of undoLog(dir).reverse()) assert.equal(undo(dir, l).ok, true);
  assert.equal(fs.existsSync(global), false);
  assert.equal(fs.readFileSync(fa, "utf8"), "Use pnpm.\n");
});

test("autopilot: the report keeps more than an answer's first line (#231)", () => {
  const { gist } = require("../vscode/autopilot.js");
  assert.equal(gist("All ten parts checked. Summary:\n\n- 1: still holds\n- 2: corrected the table\n"), "All ten parts checked. Summary: 1: still holds 2: corrected the table");
});

test("autopilot: an upstream skill change waits for the user unless they chose auto; then it is reviewed, backed up and undoable", async () => {
  const home = tmp("autopilot-home-"), dir = tmp("autopilot-data-");
  const skill = path.join(home, ".claude", "skills", "sizer");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "old\n");
  fs.writeFileSync(path.join(skill, "SOURCE.txt"), "source: https://github.com/o/r (skills/sizer)\ncommit: a1d65fd\n");
  const item = { label: "sizer", abs: path.join(skill, "SKILL.md"), origin: { repo: "o/r", path: "skills/sizer", commit: "a1d65fd" }, compare: "https://github.com/o/r/compare/a1d65fd...d60da88" };
  const jobs = jobsOf([{ label: "Review the upstream change of sizer", fix: { kind: "skill", item } }]);
  const fetchSkill = async (_o, _ref, dest) => (fs.writeFileSync(path.join(dest, "SKILL.md"), "new\n"), ["SKILL.md"]);
  const run = async () => ({ code: 0, stdout: "SUMMARY: a sizing fix\nVERDICT: SAFE\n", stderr: "" });
  const asked = await runAutopilot(jobs, handlers({ dir, runId: "s1", at: "2026-11-19T12:00:00Z", root: home, run, fetchSkill }), { runId: "s1", at: "t" });
  assert.equal(asked.manual.length, 1);
  assert.equal(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"), "old\n");
  const auto = await runAutopilot(jobs, handlers({ dir, runId: "s2", at: "2026-11-19T12:00:00Z", root: home, run, fetchSkill, autoSkills: true }), { runId: "s2", at: "t" });
  assert.equal(auto.fixed.length, 1);
  assert.equal(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"), "new\n");
  assert.match(fs.readFileSync(path.join(skill, "SOURCE.txt"), "utf8"), /commit: d60da88/);
  for (const l of undoLog(dir).reverse()) assert.equal(undo(dir, l).ok, true);
  assert.equal(fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"), "old\n");
});

test("autopilot: the progress says what it is doing, and how far (#231)", async () => {
  const { progressOf } = require("../vscode/autopilot.js");
  assert.equal(progressOf({ kind: "stale", label: "Documents: 71 possibly stale" }), "Checking 10 of 71 possibly stale documents against the code");
  assert.equal(progressOf({ kind: "block", name: "designFirst" }), "Making the designFirst check block");
  const said = [];
  await runAutopilot([{ kind: "manual", label: "a" }, { kind: "manual", label: "b" }], handlers({}), { runId: "r", at: "t", onJob: (_j, p) => said.push(p) });
  assert.deepEqual(said, ["Noting for you: a (1/2)", "Noting for you: b (2/2)"]);
});

test("autopilot: Claude's instruction review finds, records and fixes in one job; agnix leaves its records alone (#235)", async () => {
  const { openDb } = require("../vscode/db.js");
  const ir = require("../vscode/instruction-review.js");
  const { reconcile } = require("../vscode/setup-audit.js");
  const root = fs.realpathSync(tmp("autopilot-review-")), dir = tmp("autopilot-data-");
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const rules = path.join(root, "AGENTS.md"), cursor = path.join(root, ".cursorrules");
  fs.writeFileSync(rules, "Use npm.\nRun scripts/old.sh before a commit.\n");
  fs.writeFileSync(cursor, "Use pnpm.\n");
  const found = [
    { file: rules, line: 1, kind: "cross-agent", title: "Claude is told npm, Cursor pnpm", detail: "AGENTS.md:1 vs .cursorrules:1" },
    { file: rules, line: 2, kind: "stale", title: "scripts/old.sh does not exist", detail: "no such file" },
    { file: "/etc/passwd", line: 1, kind: "stale", title: "outside", detail: "" },
    { file: rules, line: 1, kind: "style", title: "not a kind", detail: "" },
  ];
  const answers = [
    `ok\n\`\`\`imprimatur-findings\n${JSON.stringify(found)}\n\`\`\`\n`,
    answer([{ file: rules, old: "Use npm.\nRun scripts/old.sh before a commit.\n", new: "Use pnpm.\n" }]),
  ];
  const run = async () => ({ code: 0, stdout: answers.shift(), stderr: "" });
  const jobs = jobsOf([], {}, { review: [rules, cursor] });
  assert.equal(jobs[0].kind, "review");
  const report = await runAutopilot(jobs, handlers({ dir, runId: "v1", at: "2026-11-19T12:00:00Z", root, db, repo, run, dismiss: () => false }), { runId: "v1", at: "t" });
  assert.match(report.fixed[0].note, /^2 found: 2 fixed/);
  assert.equal(fs.readFileSync(rules, "utf8"), "Use pnpm.\n");
  const recs = db.recordsOf(require("../vscode/recs.js").recsTask(db, repo.id).id).filter((r) => r.links?.audit?.ai);
  assert.deepEqual(recs.map((r) => [r.links.audit.rule, r.status]), [["IMP-AI-cross-agent", "done"], ["IMP-AI-stale", "done"]]);
  // The agnix audit never resolves them: they are not its findings.
  db.updateRecord(recs[0].id, { status: "open" }, { kind: "user" });
  assert.deepEqual(reconcile([], db.recordsOf(recs[0].task_id)).resolve, []);
  // The next review that no longer reports it closes it; a finding found again is not a copy.
  // A broken answer closes nothing.
  assert.equal(ir.recordFindings(db, repo.id, ir.parseFindings("no block", [rules]), "2026-11-20", { complete: ir.reviewComplete("no block"), files: [rules] }).closed, 0);
  assert.equal(db.record(recs[0].id).status, "open");
  const block = `\`\`\`imprimatur-findings\n${JSON.stringify([found[1]])}\n\`\`\``;
  const again = ir.recordFindings(db, repo.id, ir.parseFindings(block, [rules]), "2026-11-20", { complete: ir.reviewComplete(block), files: [rules] });
  assert.equal(again.added, 0);
  assert.equal(again.closed, 1);
  assert.equal(db.record(recs[0].id).status, "done");
});

test("autopilot: the instruction review fixes only the repo's own files; a finding on the global instructions waits (#235 security review)", async () => {
  const { openDb } = require("../vscode/db.js");
  const root = fs.realpathSync(tmp("autopilot-review-")), home = fs.realpathSync(tmp("autopilot-home-")), dir = tmp("autopilot-data-");
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const global = path.join(home, "CLAUDE.md");
  fs.writeFileSync(global, "Ask before pushing.\n");
  const runs = [];
  const run = async (p, files) => (runs.push(files), { code: 0, stdout: `\`\`\`imprimatur-findings\n${JSON.stringify([{ file: global, line: 1, kind: "unclear", title: "remove this rule", detail: "x" }])}\n\`\`\``, stderr: "" });
  const report = await runAutopilot(jobsOf([], {}, { review: [global] }), handlers({ dir, runId: "g1", at: "2026-11-19T12:00:00Z", root, db, repo, run, dismiss: () => false }), { runId: "g1", at: "t" });
  assert.equal(runs.length, 1, "no fix run for a file outside the repo");
  assert.equal(fs.readFileSync(global, "utf8"), "Ask before pushing.\n");
  assert.match(report.fixed[0].note, /1 found: 0 fixed, 1 left for you/);
});

test("autopilot: one strict containment check; an open review finding on a global file is never fixed by the recommendations job (#235)", async () => {
  const { inside } = require("../vscode/autopilot.js");
  const root = fs.realpathSync(tmp("autopilot-in-")), sib = `${root}-sibling`;
  fs.mkdirSync(sib);
  fs.writeFileSync(path.join(root, "a.md"), "");
  assert.equal(inside(root, path.join(root, "a.md")), true);
  assert.equal(inside(root, path.join(sib, "a.md")), false);
  assert.equal(inside(root, root), false);
  assert.equal(inside(root, "/etc/passwd"), false);
  const runs = [];
  const rec = { id: 1, title: "remove the push rule", links: { audit: { ai: true, file: "/home/x/.claude/CLAUDE.md", line: 1 } } };
  const r = await runAutopilot(jobsOf([{ label: "1 open recommendation", fix: { kind: "findings" } }], { files: [rec] }), handlers({ dir: tmp("autopilot-data-"), runId: "h1", at: "t", root, run: async (...a) => (runs.push(a), { code: 0, stdout: "", stderr: "" }) }), { runId: "h1", at: "t" });
  assert.equal(runs.length, 0);
  assert.equal(r.manual.length, 1);
});

test("autopilot: stale documents are checked longest-unchecked first, so every run moves through the backlog (#231)", async () => {
  const stale = require("../vscode/stale-docs.js");
  const parts = Array.from({ length: 12 }, (_, i) => ({ key: `u${i}`, kind: "section", id: i, title: `s${i}`, doc: "project", files: ["a.js"], commits: [{ hash: "h", at: 1, subject: "x", files: ["a.js"] }] }));
  const orig = stale.staleParts;
  stale.staleParts = () => parts;
  const meta = new Map();
  const db = { meta: (k) => meta.get(k), setMeta: (k, v) => meta.set(k, v) };
  const sent = [];
  const ctx = { db, repo: { id: 1 }, root: "/r", at: "2026-11-19T12:00:00Z", docsRun: async (p) => (sent.push([...p.matchAll(/section "(s\d+)"/g)].map((m) => m[1])), { ok: true, answer: "done" }) };
  try {
    await handlers(ctx).stale({ kind: "stale", label: "Documents: 12 possibly stale" });
    await handlers({ ...ctx, at: "2026-11-20T12:00:00Z" }).stale({ kind: "stale", label: "Documents: 12 possibly stale" });
  } finally {
    stale.staleParts = orig;
  }
  assert.deepEqual(sent[0], ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
  assert.deepEqual(sent[1].slice(0, 2), ["s10", "s11"], "the next run starts with the ones never checked");
});
