#!/usr/bin/env node
// Packages the extension (npm run package): the bundle (build.mjs), then a .vsix in dist/.
// The Marketplace page is the extension folder's README.md and CHANGELOG.md, and its LICENSE:
// the repo's README.md and LICENSE are copied in for the packaging and removed after. Relative
// links and images in the README point at the repo on GitHub (--baseContentUrl/--baseImagesUrl).
//
//   node scripts/package.mjs [--pre-release] [--out <dir>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildExtension } from "./build.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT = path.join(ROOT, "vscode");
const REPO = "https://github.com/halilural/imprimatur";

const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const out = path.resolve(outAt >= 0 ? argv[outAt + 1] : path.join(ROOT, "dist"));

await buildExtension();
fs.mkdirSync(out, { recursive: true });
const copies = ["README.md", "LICENSE"].map((f) => path.join(EXT, f));
try {
  for (const f of copies) fs.copyFileSync(path.join(ROOT, path.basename(f)), f);
  const vsce = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
  execFileSync(vsce, [
    "package",
    "--out", out,
    "--baseContentUrl", `${REPO}/blob/main/`,
    "--baseImagesUrl", `${REPO}/raw/main/`,
    ...(argv.includes("--pre-release") ? ["--pre-release"] : []),
  ], { cwd: EXT, stdio: "inherit" });
} finally {
  for (const f of copies) fs.rmSync(f, { force: true });
}
