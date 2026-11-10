// #195: the new panel's shell: five areas, the reading layout for any document, theme colors only.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { appModel, AREAS } = req("../vscode/app/model.js");
const { appHtml, readingHtml, CSS } = req("../vscode/app/html.js");
const agent = { kind: "agent", id: "s" };
const render = (md) => `<p>${md.replace(/</g, "&lt;")}</p>`;
const o = { nonce: "n0", cspSource: "vscode-resource:", render };

test("app shell: five areas and More; Home lists the tasks in progress; a document reads in the layout", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-195-")));
  const db = openDb({ path: path.join(root, "x.db") });
  const repo = db.repoOf(root);
  const t = db.upsertTask(repo.id, "#1", { title: "Search", status: "active" });
  db.addRecord(t.id, { kind: "todo", title: "Rank the results", pointer: true }, agent);
  assert.deepEqual(AREAS.map((a) => a.id), ["home", "tasks", "docs", "edits", "setup"]);
  const home = appHtml(appModel(db, repo, root, {}), o);
  assert.match(home, /data-go="docs"/);
  assert.match(home, /More<\/div>.*Exercises.*Meetings.*Social/s);
  assert.match(home, /data-task="#1"[\s\S]*👉 Rank the results/);
  // A document: its sections left, the page with the summary first, "On this page" right.
  const g = db.docOf(repo.id, "glossary");
  db.upsertSection(g.id, "wal", { title: "WAL", body: "Write-ahead log.\n\nOne file.\n\nMore detail here." }, agent);
  const m = appModel(db, repo, root, { area: "docs", doc: "glossary" });
  assert.equal(m.reading.sections[0].title, "WAL");
  const html = appHtml(m, o);
  assert.match(html, /class="toc"><div class="label">Sections<\/div><a href="#wal">WAL<\/a>/);
  assert.match(html, /<section id="wal"><h2>WAL<\/h2><div class="lead"><p>Write-ahead log\.[\s\S]*<details><summary>More<\/summary><p>More detail here\./);
  assert.match(html, /class="onpage"/);
  assert.match(readingHtml({ title: "Empty", sections: [] }, render), /Nothing written here yet/);
  // Theme colors only: every color is a VS Code variable.
  assert.doesNotMatch(CSS.replace(/var\(--vscode-[^)]*\)/g, ""), /#[0-9a-f]{3,6}\b|rgb\(/i);
  // The CSP lets in only the nonce's script.
  assert.match(html, /script-src 'nonce-n0'/);
});
