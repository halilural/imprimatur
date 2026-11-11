// #208: Imprimatur's rules in their own generated file; copies in the repo's files and skill clashes are findings.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { writeOwnRules, TEXT, FILE, copiedLines } = require("../vscode/own-rules.js");
const { check } = require("../vscode/process.js");
const { docDiagnostics } = require("../vscode/doc-rules.js");
const { skillClashes, clashDiagnostics } = require("../vscode/skill-clash.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("own rules: written when missing, rewritten when Imprimatur's and old, a hand-taken file left alone", () => {
  const root = tmp("imp-own-");
  const file = path.join(root, FILE);
  assert.equal(writeOwnRules(root), "written");
  assert.equal(fs.readFileSync(file, "utf8"), TEXT);
  assert.equal(writeOwnRules(root), "same");
  fs.writeFileSync(file, TEXT.replace("Tasks and records", "Old"));
  assert.equal(writeOwnRules(root), "written", "an older generated text is replaced");
  fs.writeFileSync(file, "# mine\n");
  assert.equal(writeOwnRules(root), "hand");
  assert.equal(fs.readFileSync(file, "utf8"), "# mine\n");
  assert.match(TEXT, /the repo's own rules win/);
  assert.match(TEXT, /read the to-spec skill's SKILL\.md/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("own rules: the SessionStart hook writes them in a repo with process settings, not in one without", () => {
  const on = tmp("imp-own-on-");
  execFileSync("git", ["init", "-q", on]);
  fs.mkdirSync(path.join(on, ".claude"));
  fs.writeFileSync(path.join(on, ".claude/imprimatur.json"), JSON.stringify({ process: { whereWeLeftOff: false, docSync: false, branchFinish: false } }));
  check("SessionStart", { cwd: on, session_id: "s" }, { records: { repoId: () => undefined } });
  assert.equal(fs.readFileSync(path.join(on, FILE), "utf8"), TEXT);
  const off = tmp("imp-own-off-");
  execFileSync("git", ["init", "-q", off]);
  check("SessionStart", { cwd: off, session_id: "s" }, { records: { repoId: () => undefined } });
  assert.ok(!fs.existsSync(path.join(off, FILE)), "no process settings, no file");
  for (const r of [on, off]) fs.rmSync(r, { recursive: true, force: true });
});

test("IMP-DOC-008: Imprimatur's rule lines an older release copied into AGENTS.md or docs.md are a finding", () => {
  const root = tmp("imp-copied-");
  fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# A\n- This repo's tasks and records live in Imprimatur (its MCP server): start with x.\n- use pnpm\n");
  fs.writeFileSync(path.join(root, ".claude/rules/docs.md"), "- Imprimatur's database is the source of these files (Matt Pocock's model)\n- A task's spec is written with `/to-spec` (Matt Pocock's skill)\n");
  const got = docDiagnostics(require("../vscode/db.js").openDb(), root).filter((d) => d.rule === "IMP-DOC-008").map((d) => d.message);
  assert.deepEqual(got, ["AGENTS.md carries 1 of Imprimatur's rule line an older release copied in", `${path.join(".claude", "rules", "docs.md")} carries 2 of Imprimatur's rule lines an older release copied in`]);
  assert.deepEqual(copiedLines("- use pnpm\n"), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("IMP-SETUP-001: a bare skill name from two places is a clash; front matter names count; claude.ai's synced ones too", () => {
  const root = tmp("imp-clash-");
  const home = tmp("imp-home-");
  const checkout = tmp("imp-checkout-");
  const skill = (dir, name, fmName) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${fmName ?? name}\ndescription: x\n---\n`);
  };
  skill(path.join(root, ".claude/skills"), "to-spec");
  skill(path.join(root, ".claude/skills"), "mine", "deploy");
  skill(path.join(root, ".claude/skills"), "only-here");
  fs.mkdirSync(path.join(checkout, "vscode"));
  fs.writeFileSync(path.join(checkout, "vscode/process.js"), "");
  skill(path.join(checkout, "skills"), "to-spec");
  fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
  fs.symlinkSync(path.join(checkout, "skills/to-spec"), path.join(home, ".claude/skills/to-spec"));
  skill(path.join(home, ".claude/skills/synced/abc"), "deploy");
  const got = skillClashes(root, home).map((c) => `${c.name}:${c.from.map((f) => f.source).join("+")}`).sort();
  assert.deepEqual(got, ["deploy:project+claude.ai", "to-spec:project+Imprimatur"]);
  const d = clashDiagnostics(root, home).find((x) => x.message.includes("to-spec"));
  assert.equal(d.rule, "IMP-SETUP-001");
  assert.equal(d.file, path.join(root, ".claude/skills/to-spec/SKILL.md"), "on the repo's own copy");
  assert.match(d.suggestion, /namespaced \(imprimatur:…\)/);
  for (const r of [root, home, checkout]) fs.rmSync(r, { recursive: true, force: true });
});
