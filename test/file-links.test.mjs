// `file:line` in the panel's Markdown opens the file (#96).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { fileRef, renderMarkdown } = req("../vscode/docsView.js");
const { repoFileOf } = req("../vscode/review-state.js");

test("which inline code is a file reference", () => {
  const env = {};
  assert.deepEqual(fileRef("vscode/db.js:1404", env), { file: "vscode/db.js", line: 1404 });
  assert.deepEqual(fileRef(":338", env), { file: "vscode/db.js", line: 338 }, "the file named last");
  assert.deepEqual(fileRef("db.js:12-20", {}), { file: "db.js", line: 12 });
  assert.deepEqual(fileRef("hooks/statusline.mjs", {}), { file: "hooks/statusline.mjs" });
  for (const no of ["imprimatur.db", "0.65.1", "v.id > 0", "actor_kind IN ('agent')", "../etc/passwd:1", ":12"]) assert.equal(fileRef(no, {}), undefined, no);
});

test("rendered Markdown links them, the shorthand to the file before it, escaped", () => {
  const html = renderMarkdown("1. `vscode/tasksView.js:180` unreadOf. Liste `:338`, sayfa `:283`.\n2. `section_reads` tablosu");
  assert.match(html, /<a href="#" class="fref" data-act="openFile" data-file="vscode\/tasksView.js" data-line="180" title="Open in the editor"><code>vscode\/tasksView.js:180<\/code><\/a>/);
  assert.match(html, /data-file="vscode\/tasksView.js" data-line="338"/);
  assert.match(html, /data-file="vscode\/tasksView.js" data-line="283"/);
  assert.match(html, /<code>section_reads<\/code>/);
  assert.doesNotMatch(html, /data-file="section_reads"/);
});

test("a reference opens only a file of the repo; a bare name is the one tracked file of that name", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-96-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, "vscode"));
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, "b"));
  for (const f of ["vscode/db.js", "a/x.js", "b/x.js"]) fs.writeFileSync(path.join(root, f), "1\n");
  execFileSync("git", ["add", "."], { cwd: root });
  assert.equal(repoFileOf(root, "vscode/db.js"), path.join(root, "vscode/db.js"));
  assert.equal(repoFileOf(root, "db.js"), path.join(root, "vscode/db.js"));
  assert.equal(repoFileOf(root, "x.js"), undefined, "two of that name");
  assert.equal(repoFileOf(root, "../x.js"), undefined);
  assert.equal(repoFileOf(root, "/etc/passwd"), undefined);
  assert.equal(repoFileOf(root, "vscode"), undefined, "a folder");
  assert.equal(repoFileOf(root, "nope.js"), undefined);
});
