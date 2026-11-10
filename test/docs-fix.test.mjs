// Fix it on documentation findings (#131; docs-fix.js since the one-time backfill went, #203).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { check } = req("../vscode/process.js");
const bf = req("../vscode/docs-fix.js");
const { callTool } = await import("../mcp/server.mjs");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-bf-")));

function setup(n = 3, kind = "adr") {
  const root = tmpDir();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const db = openDb({ path: path.join(tmpDir(), "imprimatur.db") });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#1");
  const recs = [];
  for (let i = 0; i < n; i++) recs.push(db.addRecord(task.id, { kind: i === 0 ? kind : "note", title: `r${i}`, body: `body ${i}` }, agent));
  return { root, db, repo, task, recs };
}

test("fixPrompt (#131): lists the decisions IMP-DOC-002 names, only for the rules found; claudeArgs adds record_update", () => {
  const { root, db, repo, recs } = setup();
  const alt = db.addRecord(db.upsertTask(repo.id, "#2").id, { kind: "adr", title: "B", body: "Alternative: C, rejected because slow" }, agent);
  const f = (rule) => ({ title: `${rule}: x`, links: { audit: { rule } } });
  const both = bf.fixPrompt(db, repo.id, root, [f("IMP-DOC-002"), f("IMP-DOC-005")]);
  assert.match(both, new RegExp(`## IMP-DOC-002[\\s\\S]*\\[${recs[0].id}\\] ADR \\(#1\\) r0`));
  // The decision that names an alternative is not in IMP-DOC-002's list; no section-linking any more (#203).
  assert.ok(!both.includes(`[${alt.id}]`));
  assert.doesNotMatch(both, /IMP-DOC-00[34]/);
  assert.match(both, /do not invent one/);
  const one = bf.fixPrompt(db, repo.id, root, [f("IMP-DOC-005")]);
  assert.ok(!one.includes("## IMP-DOC-002"));
  const args = bf.claudeArgs("/x/server.mjs", ["record_update"]);
  assert.ok(args.includes("mcp__imprimatur__record_update") && args.includes("mcp__imprimatur__doc_section_upsert"));
  assert.ok(!bf.claudeArgs("/x/server.mjs").includes("mcp__imprimatur__record_update"));
});

test("a fix run's record_update (#131): only the listed decisions, only body and links", () => {
  const { root, db, repo, recs } = setup();
  const other = recs[1];
  const ids = bf.fixRecordIds(db, repo.id, [{ links: { audit: { rule: "IMP-DOC-002" } } }]);
  assert.deepEqual(ids, [recs[0].id]);
  const args = bf.claudeArgs("/x/server.mjs", ["record_update"], { IMPRIMATUR_RECORD_UPDATE: ids.join(",") });
  assert.equal(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.imprimatur.env.IMPRIMATUR_RECORD_UPDATE, String(recs[0].id));
  process.env.IMPRIMATUR_RECORD_UPDATE = ids.join(",");
  try {
    assert.throws(() => callTool(db, "record_update", { id: other.id, status: "dropped" }), /not one this run may change/);
    callTool(db, "record_update", { id: recs[0].id, body: "b\nAlternative: x", status: "dropped", title: "T" });
    const r = db.record(recs[0].id);
    assert.equal(r.body, "b\nAlternative: x");
    assert.equal(r.status, "open");
    assert.equal(r.title, "r0");
  } finally {
    delete process.env.IMPRIMATUR_RECORD_UPDATE;
  }
});

test("registeredServer (#131): the user's imprimatur MCP server from ~/.claude.json; claudeArgs runs it as given", () => {
  const home = tmpDir();
  assert.equal(bf.registeredServer(home), undefined);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { imprimatur: { type: "stdio", command: "node", args: ["/repo/mcp/server.mjs"] } } }));
  const s = bf.registeredServer(home);
  assert.deepEqual(s, { command: "node", args: ["/repo/mcp/server.mjs"] });
  const args = bf.claudeArgs(s, [], { A: "1" });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.imprimatur, { type: "stdio", command: "node", args: ["/repo/mcp/server.mjs"], env: { A: "1" } });
});
