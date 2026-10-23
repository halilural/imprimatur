#!/usr/bin/env node
// Checks a packaged .vsix (CI, #1): exactly the files the extension needs, and at most MAX_BYTES.
// A file that is missing or one that should not ship (sources, tests, a token) fails it.
//
//   node scripts/check-vsix.mjs dist/imprimatur-<version>.vsix
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const MAX_BYTES = 5 * 1024 * 1024;
const EXPECTED = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/LICENSE.txt",
  "extension/changelog.md",
  "extension/dist/extension.js",
  "extension/dist/mermaid.min.js",
  "extension/media/icon.png",
  "extension/media/imprimatur.svg",
  "extension/package.json",
  "extension/preview-markers.js",
  "extension/preview.css",
  "extension/readme.md",
];

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("usage: node scripts/check-vsix.mjs <file.vsix>");
  process.exit(2);
}
const entries = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
const missing = EXPECTED.filter((e) => !entries.includes(e));
const extra = entries.filter((e) => !EXPECTED.includes(e));
const size = fs.statSync(file).size;
const problems = [
  ...missing.map((e) => `missing: ${e}`),
  ...extra.map((e) => `not expected: ${e}`),
  ...(size > MAX_BYTES ? [`${size} bytes, over ${MAX_BYTES}`] : []),
];
if (problems.length) {
  console.error(`${file}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`${file}: ${entries.length} files, ${(size / 1024 / 1024).toFixed(2)} MB`);
