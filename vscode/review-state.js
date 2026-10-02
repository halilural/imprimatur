// @ts-check
// Git state shared by the hook and the extension, so both decide "is this copy
// still needed" the same way.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASELINE_DIR = path.join(".claude", "review-baseline");

/** @param {string} cwd @param {string[]} args @returns {string | undefined} raw stdout, undefined on error */
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** Git top level for a path (walks up to an existing directory), resolved like fsPath. @param {string} p */
function repoRoot(p) {
  let dir = p;
  while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  const out = git(dir, ["rev-parse", "--show-toplevel"]);
  return out ? path.resolve(out.trim()) : undefined;
}

/**
 * True when the copy of rel is still needed: git sees work-tree changes (second
 * porcelain column set), the file is untracked or ignored, or git cannot tell.
 * @param {string} root @param {string} rel
 */
function hasUnstagedChanges(root, rel) {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--", rel]);
  if (out === undefined) return true;
  if (out === "") return false; // tracked and clean: staged or committed
  return out[1] !== " "; // " M", "MM", "??", "!!" keep; "M " / "A " are fully staged
}

module.exports = { BASELINE_DIR, git, repoRoot, hasUnstagedChanges };
