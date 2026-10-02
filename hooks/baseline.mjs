#!/usr/bin/env node
// Claude Code PreToolUse hook for Edit|Write. Before the agent touches a
// tracked file type for the first time, copy the file to
// .claude/review-baseline/<path> (an empty copy for a new file). The editor
// extension diffs the file against that copy until the user stages it.
//
//   node baseline.mjs [ext ...]   default extensions: md mdx
//
// Keeps an existing copy while the file still has unstaged changes; once the
// file is staged or committed the copy is stale and is overwritten. Never
// blocks the tool: every path ends in exit 0.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const BASELINE_DIR = path.join(".claude", "review-baseline");

// True when git sees work-tree changes for rel (second status column set, or
// untracked). Outside a git repo there is nothing to compare, so a copy is kept.
export function hasUnstagedChanges(root, rel) {
  try {
    const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--", rel], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.length > 0 && out[1] !== " ";
  } catch {
    return true;
  }
}

export function takeBaseline(root, file, exts = ["md", "mdx"]) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!exts.includes(ext)) return "skipped";
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "skipped";
  const copy = path.join(root, BASELINE_DIR, rel);
  if (fs.existsSync(copy) && hasUnstagedChanges(root, rel)) return "kept";
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, fs.existsSync(abs) ? fs.readFileSync(abs) : "");
  return "written";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input || "{}");
      const file = data.tool_input?.file_path;
      const root = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
      const exts = process.argv.slice(2).map((e) => e.toLowerCase());
      if (file) takeBaseline(root, file, exts.length ? exts : undefined);
    } catch (e) {
      process.stderr.write(`agent-review baseline: ${e.message}\n`);
    }
    process.exit(0);
  });
}
