// #206: hand-written documents found by the search where they are, and listed for agents in domain.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool } from "../mcp/server.mjs";

const require = createRequire(import.meta.url);
const { chunks, rankedSearch } = require("../vscode/search-index.js");
const { agentFiles } = require("../vscode/pocock-files.js");
const { keepOf } = require("../vscode/doc-rules.js");

function repo(files, settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imp-kept-"));
  execFileSync("git", ["init", "-q", root]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  if (settings) {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude/imprimatur.json"), JSON.stringify(settings));
  }
  const db = require("../vscode/db.js").openDb();
  return { root, db, repo: db.repoOf(root) };
}

test("chunks: cut at # to ###, a heading inside a code fence is not one", () => {
  const got = chunks("intro\n# A\na1\n```\n# not a heading\n```\n#### deep\n## B\nb1\n");
  assert.deepEqual(got.map((c) => [c.heading, c.line]), [["", 1], ["A", 2], ["B", 8]]);
  assert.match(got[1].text, /# not a heading/);
});

test("search (#206): a kept document and one not yet adopted are found at their line; a generated one is not", () => {
  const { root, db, repo: r } = repo({
    "docs/mails/thread.md": "# Thread\n\n## Reply\nThe zanzibar rollout waits on QA.\n",
    "docs/clinic.md": "# Clinic\nzanzibar runs on port 8080.\n",
    "docs/PROJECT.md": `${require("../vscode/docs-export.js").HEADER}\n\n# P\nzanzibar\n`,
  }, { docs: { keep: ["docs/mails/"] } });
  const hits = rankedSearch(db, "zanzibar", { repoId: r.id, type: "file" });
  assert.deepEqual(hits.map((h) => `${h.rel}:${h.line}`).sort(), ["docs/clinic.md:1", "docs/mails/thread.md:3"]);
  const out = callTool(db, "search", { text: "zanzibar rollout", repo: root });
  assert.deepEqual(out.files.map((f) => [f.path, f.line]), [["docs/mails/thread.md", 3]]);
  assert.equal(callTool(db, "search", { text: "zanzibar", repo: root, kind: "note" }).files, undefined, "a kind filter is about records");
  fs.rmSync(root, { recursive: true, force: true });
});

test("domain.md (#206): kept documents listed with when to read them, none without keep", () => {
  const { root } = repo({}, { docs: { keep: ["docs/mails/", { path: "docs/runbooks/", when: "an incident or a deploy" }, { path: "../out" }] } });
  const kept = keepOf(root);
  assert.deepEqual(kept, [{ path: "docs/mails/" }, { path: "docs/runbooks/", when: "an incident or a deploy" }]);
  const text = agentFiles("<!-- h -->", kept)["domain.md"];
  assert.match(text, /## Kept documents: read only when you need them/);
  assert.match(text, /- `docs\/runbooks\/`: an incident or a deploy/);
  assert.doesNotMatch(agentFiles("<!-- h -->")["domain.md"], /Kept documents/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("search (#206): a symlinked document is not read, whatever it points at", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "imp-secret-"));
  fs.writeFileSync(path.join(outside, "key.md"), "topsecretvalue\n");
  const { root, db, repo: r } = repo({ "docs/ok.md": "# Ok\ntopsecretvalue is not here\n" });
  fs.symlinkSync(path.join(outside, "key.md"), path.join(root, "docs/link.md"));
  assert.deepEqual(rankedSearch(db, "topsecretvalue", { repoId: r.id, type: "file" }).map((h) => h.rel), ["docs/ok.md"]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
