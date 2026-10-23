#!/usr/bin/env node
// The CHANGELOG section of one version (release.yml, #1): printed for the GitHub Release.
// A version with no section fails: every release says what changed.
//
//   node scripts/release-notes.mjs <version>
import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/release-notes.mjs <x.y.z>");
  process.exit(2);
}
const text = fs.readFileSync(path.join(import.meta.dirname, "..", "vscode", "CHANGELOG.md"), "utf8");
const lines = text.split("\n");
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`vscode/CHANGELOG.md has no "## [${version}]" section`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join("\n").trim();
if (!body) {
  console.error(`vscode/CHANGELOG.md: the ${version} section is empty`);
  process.exit(1);
}
console.log(body);
