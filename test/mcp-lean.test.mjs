// #120: search answers with an index; full:true or task_get reach every body in one more call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../mcp/server.mjs";

const require = createRequire(import.meta.url);
const { openDb } = require("../vscode/db.js");

test("search: lean by default (no bodies, 8 hits, more), full:true gives whole records", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-120-")));
  execFileSync("git", ["init", "-q", root]);
  const db = openDb({ path: path.join(root, "i.db") });
  const call = (name, args) => handle(db, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo: root, ...args } } }, { client: "t" }).result;
  for (let i = 0; i < 14; i++) call("record_add", { task: "#7", kind: "note", title: `refresh note ${i}`, body: `refresh body ${i}\n${"long text ".repeat(200)}`, ...(i === 13 && { pointer: true }) });
  const lean = call("search", { text: "refresh" }).structuredContent;
  assert.equal(lean.records.length, 8);
  assert.equal(lean.more, true);
  assert.ok(lean.records.every((r) => r.body === undefined && r.task_key === "#7" && r.title));
  assert.match(lean.hint, /full:true/);
  assert.ok(JSON.stringify(lean).length < 2048, `lean search ${JSON.stringify(lean).length} bytes`);
  assert.equal(lean.records[0].pointer, true, "the 👉 shows");
  call("record_add", { task: "#8", kind: "note", title: `longtitle ${"x".repeat(280)}` });
  const long = call("search", { text: "longtitle", limit: 1 }).structuredContent.records[0];
  assert.equal(long.title.length, 160, "a long title is cut in the index");
  assert.equal(call("search", { text: "longtitle", limit: 1, full: true }).structuredContent.records[0].title.length, 290);
  const full = call("search", { text: "refresh", full: true, limit: 2 }).structuredContent;
  assert.ok(full.records.every((r) => r.body.includes("long text") && r.uid), "whole records");
  assert.equal(call("search", { text: "refresh", limit: 20 }).structuredContent.more, undefined, "all 14 fit");
});
