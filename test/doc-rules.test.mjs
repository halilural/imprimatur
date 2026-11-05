import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { docDiagnostics, sequenceProblems } = require("../vscode/doc-rules.js");

const user = { kind: "user" };
const GOOD_SEQ = "```mermaid\nsequenceDiagram\n  autonumber\n  A->>B: ask\n  B-->>A: answer\n```\n\n1. A asks.\n2. B answers.";

/** A repo that follows the standard: every chapter written, C4 views, decisions with an alternative and a section. */
function goodRepo() {
  const db = require("../vscode/db.js").openDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-docrules-"));
  fs.mkdirSync(path.join(root, ".git"));
  const repo = db.repoOf(root);
  const t = db.upsertTask(repo.id, "#1", { title: "Build it" });
  const adr = db.addRecord(t.id, { kind: "adr", title: "Use SQLite", body: "One file per device.\nAlternative: JSON files, rejected for concurrent writes.", links: { madr: 1 } }, user);
  const doc = db.docOf(repo.id, "architecture");
  const chapters = Object.keys(require("../vscode/db.js").CHAPTERS.architecture);
  for (const ch of chapters) {
    const body = ch === "context" ? "```mermaid\nflowchart LR\n  u[\"Dev [Person]\"] --> s[\"App [Software system]\"]\n```"
      : ch === "building-blocks" ? `\`\`\`mermaid\nflowchart TB\n  e["Ext [Container: Node.js]"]\n\`\`\`\n\n${GOOD_SEQ}` : "Text.";
    db.upsertSection(doc.id, ch, { title: ch, body, chapter: ch, ...(ch === "decisions" ? { addRecords: [adr.id] } : {}) }, user);
  }
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Rules\n");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
  return { db, root, repo, t, doc };
}

test("doc rules (#131): a repo that follows the standard gets no findings", () => {
  const { db, root } = goodRepo();
  assert.deepEqual(docDiagnostics(db, root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("doc rules (#131): a broken sample triggers each rule with a clear finding", () => {
  const { db, root, repo, t, doc } = goodRepo();
  // 001: a number used twice; a decision with none.
  db.addRecord(t.id, { kind: "adr", title: "Second", body: "Alternative: none.", links: { madr: 1 } }, user);
  db.addRecord(t.id, { kind: "pdr", title: "Third", body: "Rejected: other." }, user);
  // 002 and 003: a decision with no alternative, linked to no section.
  db.addRecord(t.id, { kind: "adr", title: "Fourth", body: "Just do it.", links: { madr: 4 } }, user);
  // 004: the risks chapter emptied, the C4 views gone.
  for (const s of db.docSections(doc.id)) {
    if (s.chapter === "risks") db.upsertSection(doc.id, s.key, { status: "superseded" }, user);
    if (s.chapter === "context" || s.chapter === "building-blocks") db.upsertSection(doc.id, s.key, { body: s.chapter === "building-blocks" ? "```mermaid\nsequenceDiagram\n  A->>B: ask\n  B-->>A: answer\n```\n\n1. A asks." : "No diagram." }, user);
  }
  // 006: a CLAUDE.md over 200 lines.
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "x\n".repeat(230));
  const got = docDiagnostics(db, root);
  const msg = (/** @type {string} */ rule) => got.filter((d) => d.rule === rule).map((d) => d.message);
  assert.match(msg("IMP-DOC-001")[0], /number used twice: 0001, 0001; 1 decision without a number/);
  assert.match(msg("IMP-DOC-002")[0], /1 of 4 decisions name no alternative to the option chosen: 0004/);
  assert.match(msg("IMP-DOC-003")[0], /3 of 4 decisions are linked to no section/);
  assert.deepEqual(msg("IMP-DOC-004"), ["chapters with no section: Risks and technical debt", "no C4 context view (level 1)", "no C4 container view (level 2)"]);
  assert.deepEqual(msg("IMP-DOC-005"), ['sequenceDiagram in section "building-blocks": no autonumber, 1 numbered item for 2 arrows']);
  assert.deepEqual(msg("IMP-DOC-006"), ["CLAUDE.md has 230 lines, over 200"]);
  for (const d of got) assert.ok(d.suggestion && d.file && d.level, `${d.rule} says what to do`);
  assert.ok(repo);
  fs.rmSync(root, { recursive: true, force: true });
});

test("doc rules (#131): sequence diagrams: autonumber and one numbered item per arrow, a lead-in line allowed", () => {
  assert.deepEqual(sequenceProblems(GOOD_SEQ), []);
  assert.deepEqual(sequenceProblems("```mermaid\nsequenceDiagram\n  autonumber\n  A->>B: x\n```\n\nThe steps:\n\n1. A sends x."), []);
  assert.deepEqual(sequenceProblems("```mermaid\nflowchart LR\n  A --> B\n```"), [], "only sequence diagrams");
  assert.deepEqual(sequenceProblems("intro\n```mermaid\nsequenceDiagram\n  A->>B: x\n```"), [{ line: 2, why: "no autonumber, 0 numbered items for 1 arrow" }]);
});
