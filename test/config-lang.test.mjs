// The language model-written text uses per repo (#80): .claude/imprimatur.json "lang" first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { repoLang, ownLang, repoRootOf } = require("../vscode/config.js");

/** A repo folder (with .git) and, when given, its settings. @param {any} [settings] */
function repo(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-lang-"));
  fs.mkdirSync(path.join(root, ".git"));
  if (settings) {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify(settings));
  }
  return root;
}

test("repoLang: the repo's lang wins over IMPRIMATUR_LANG and config.json; without one, hookLang's chain", () => {
  const env = { IMPRIMATUR_LANG: "Turkish" };
  assert.equal(repoLang(repo({ lang: " English " }), env, { lang: "German" }), "English");
  assert.equal(repoLang(repo(), env, { lang: "German" }), "Turkish");
  assert.equal(repoLang(repo({ lang: "" }), {}, { lang: "German" }), "German");
  assert.equal(repoLang(undefined, {}, {}), undefined);
});

test("ownLang: only the repo's own; not JSON or no file is none", () => {
  const bad = repo();
  fs.mkdirSync(path.join(bad, ".claude"));
  fs.writeFileSync(path.join(bad, ".claude", "imprimatur.json"), "{nope");
  assert.equal(ownLang(bad), undefined);
  assert.equal(ownLang(repo()), undefined);
  assert.equal(ownLang(repo({ lang: "English" })), "English");
});

test("repoRootOf: the folder with .git above a subfolder; the folder itself when none", () => {
  const root = repo();
  const sub = path.join(root, "a", "b");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(repoRootOf(sub), root);
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-nogit-"));
  assert.equal(repoRootOf(loose), loose);
});
