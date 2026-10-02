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
 * Review state of rel from `git status` XY:
 * - "unstaged": work-tree changes (Y set), untracked or ignored, or git cannot tell
 * - "staged": everything staged but not committed (X set, Y blank); unstaging
 *   brings the changes back, so the copy must stay
 * - "clean": committed; the copy is done
 * @param {string} root @param {string} rel @returns {"unstaged" | "staged" | "clean"}
 */
function reviewState(root, rel) {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--", rel]);
  if (out === undefined) return "unstaged";
  if (out === "") return "clean";
  return out[1] !== " " ? "unstaged" : "staged";
}

/** @param {string} root @param {string} rel */
const hasUnstagedChanges = (root, rel) => reviewState(root, rel) === "unstaged";

module.exports = { BASELINE_DIR, git, repoRoot, reviewState, hasUnstagedChanges };
