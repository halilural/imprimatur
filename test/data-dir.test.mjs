// #126: the data folder outside the repo, and the move of an old in-repo one.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { dataDir, dataPath, mergeLegacy } = require("../vscode/data-dir.js");
const repo = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-126-")));
const put = (f, t) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};

test("data dir: outside the repo; the old folder moves in, .jsonl joined, MOVED.md left", () => {
  const root = repo();
  const old = path.join(root, ".claude", "imprimatur");
  put(path.join(old, "history", "a.md.jsonl"), "1\n");
  put(path.join(old, "baseline", "a.md"), "copy\n");
  const dir = dataDir(root);
  assert.ok(!dir.startsWith(root), "outside the repo");
  assert.equal(fs.readFileSync(path.join(dir, "baseline", "a.md"), "utf8"), "copy\n");
  assert.deepEqual(fs.readdirSync(old).sort(), [".gitignore", "MOVED.md"]);
  assert.match(fs.readFileSync(path.join(old, "MOVED.md"), "utf8"), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // An older release writes again in the old place: the next merge joins it.
  put(path.join(old, "history", "a.md.jsonl"), "2\n");
  put(path.join(old, "baseline", "a.md"), "older copy\n");
  assert.equal(mergeLegacy(root), 2);
  assert.equal(fs.readFileSync(dataPath(root, ".claude/imprimatur/history/a.md.jsonl"), "utf8"), "1\n2\n");
  assert.equal(fs.readFileSync(path.join(dir, "baseline", "a.md"), "utf8"), "copy\n", "the data folder's copy stays");
});

test("data dir: a linked old folder, or links inside it, are never followed or moved", () => {
  const root = repo();
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-126-secret-"));
  put(path.join(secret, "id_rsa"), "KEY");
  fs.mkdirSync(path.join(root, ".claude"));
  fs.symlinkSync(secret, path.join(root, ".claude", "imprimatur"));
  dataDir(root);
  assert.equal(fs.readFileSync(path.join(secret, "id_rsa"), "utf8"), "KEY", "the linked folder's files stay where they are");
  assert.ok(!fs.existsSync(path.join(secret, "MOVED.md")), "nothing written through the link");
  // .claude itself a link.
  const root2 = repo();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-126-else-"));
  put(path.join(elsewhere, "imprimatur", "history", "x.jsonl"), "x\n");
  fs.symlinkSync(elsewhere, path.join(root2, ".claude"));
  assert.equal(mergeLegacy(root2), 0);
  assert.ok(fs.existsSync(path.join(elsewhere, "imprimatur", "history", "x.jsonl")));
  // A link inside a real old folder: left alone; a MOVED.md that is a link is replaced, not written through.
  const root3 = repo();
  const old = path.join(root3, ".claude", "imprimatur");
  put(path.join(old, "waiting", "s.jsonl"), "w\n");
  fs.symlinkSync(path.join(secret, "id_rsa"), path.join(old, "evil.jsonl"));
  fs.symlinkSync(path.join(secret, "id_rsa"), path.join(old, "MOVED.md"));
  const dir3 = dataDir(root3);
  assert.equal(fs.readFileSync(path.join(secret, "id_rsa"), "utf8"), "KEY");
  assert.ok(!fs.existsSync(path.join(dir3, "evil.jsonl")), "the link is not moved");
  assert.ok(!fs.lstatSync(path.join(old, "MOVED.md")).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dir3, "waiting", "s.jsonl"), "utf8"), "w\n");
});
