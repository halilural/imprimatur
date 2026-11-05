// The documentation linters (#132): generated Markdown tidied for markdownlint (md-tidy.js), and
// the configs and npm scripts Agent Setup writes into a repo (doc-lint.js), never overwriting.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { tidy, nest } = req("../vscode/md-tidy.js");
const dl = req("../vscode/doc-lint.js");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-dl-")));

test("tidy: blank lines around headings, fences and a list's start; bare fence gets text; code left alone; idempotent", () => {
  const md = ["Intro:", "- a", "- b", "#### Head", "text", "```", "#139 inside code", "- not a list", "```", "after"].join("\n");
  const out = tidy(md);
  assert.equal(out, ["Intro:", "", "- a", "- b", "", "#### Head", "", "text", "", "```text", "#139 inside code", "- not a list", "```", "", "after"].join("\n"));
  assert.equal(tidy(out), out);
  // Front matter's closing line is not a paragraph a list follows.
  assert.equal(tidy("---\ntype: x\n---"), "---\ntype: x\n---");
});

test("tidy: a line starting #139 is escaped; bare URLs go in <>, links, code and attributes do not", () => {
  assert.equal(tidy("#139 covers it"), "\\#139 covers it");
  assert.equal(tidy("see https://a.b/c."), "see <https://a.b/c>.");
  for (const kept of ["[x](https://a.b)", "<https://a.b>", "`https://a.b`", 'href="https://a"']) assert.equal(tidy(kept), kept);
  assert.equal(tidy("| https://a.b/x | y |"), "| <https://a.b/x> | y |");
});

test("nest: a body's highest heading lands at top, the rest keep their distance; fenced # lines untouched", () => {
  assert.equal(nest("### Data\n#### Sub\n```\n# code\n```"), "#### Data\n##### Sub\n```\n# code\n```");
  assert.equal(nest("#### Data", 3), "### Data");
  assert.equal(nest("no headings"), "no headings");
  assert.equal(nest("## A\n###### Deep"), "#### A\n###### Deep");
});

test("writeMissing: the four configs and free npm scripts, indentation kept; a second run and local edits are left alone", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "package.json"), '{\n    "name": "x",\n    "scripts": {\n        "lint:docs": "mine"\n    }\n}\n');
  fs.writeFileSync(path.join(root, "lychee.toml"), "# mine\n");
  const s = dl.docLint(root);
  assert.deepEqual(s.missing.map((f) => path.basename(f)).sort(), [".markdownlint-cli2.jsonc", ".vale.ini", "cspell.json"]);
  assert.deepEqual(s.scripts, ["lint:links", "lint:prose"]);
  assert.match(dl.lintRows(s)[0].label, /Doc lint: write .*lint:links, lint:prose in package\.json/);
  const written = dl.writeMissing(root, { words: ["agnix"] }).map((f) => path.basename(f)).sort();
  assert.deepEqual(written, [".markdownlint-cli2.jsonc", ".vale.ini", "cspell.json", "package.json"]);
  assert.equal(fs.readFileSync(path.join(root, "lychee.toml"), "utf8"), "# mine\n");
  const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
  assert.match(pkg, /^\{\n {4}"name"/);
  assert.equal(JSON.parse(pkg).scripts["lint:docs"], "mine");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "cspell.json"), "utf8")).words, ["agnix"]);
  assert.deepEqual(dl.writeMissing(root), []);
  assert.deepEqual(dl.lintRows(dl.docLint(root)), []);
});

test("scripts: cspell warns only and runs only for English prose; no package.json, only configs", () => {
  assert.match(dl.scriptsFor(true)["lint:docs"], /cspell@[\d.]+ lint --no-progress --no-exit-code/);
  assert.doesNotMatch(dl.scriptsFor(false)["lint:docs"], /cspell/);
  const root = tmp();
  const s = dl.docLint(root, { english: false });
  assert.equal(s.pkg, false);
  assert.deepEqual(s.scripts, []);
  assert.match(dl.lintRows(s)[0].tooltip, /no package\.json/);
});
