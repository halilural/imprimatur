#!/usr/bin/env node
// Claude Code PreToolUse hook for Edit|Write. Before the agent touches a
// tracked file type for the first time, copy the file to
// <git root>/.claude/review-baseline/<path> (an empty copy for a new file).
// The editor extension diffs the file against that copy until it is staged.
//
//   node baseline.mjs [ext ...]   default extensions: md mdx
//
// Keeps an existing copy until the file is committed (staged changes still
// count as under review); once git shows the file clean the copy is stale and
// is overwritten. Never blocks the tool: every path ends in exit 0.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { BASELINE_DIR, repoRoot, reviewState } = createRequire(import.meta.url)("../vscode/review-state.js");

/** @param {string} project Claude's project dir; files outside it are skipped */
export function takeBaseline(project, file, exts = ["md", "mdx"]) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!exts.includes(ext)) return "skipped";
  const abs = path.resolve(project, file);
  const inProject = path.relative(project, abs);
  if (inProject.startsWith("..") || path.isAbsolute(inProject)) return "skipped";
  // The copy lives at the git root, where the extension looks for it.
  const root = repoRoot(path.dirname(abs)) ?? path.resolve(project);
  const rel = path.relative(root, abs);
  const copy = path.join(root, BASELINE_DIR, rel);
  if (fs.existsSync(copy) && reviewState(root, rel) !== "clean") return "kept";
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, fs.existsSync(abs) ? fs.readFileSync(abs) : "");
  return "written";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input || "{}");
      const file = data.tool_input?.file_path;
      const project = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
      const exts = process.argv.slice(2).map((e) => e.toLowerCase());
      if (file) takeBaseline(project, file, exts.length ? exts : undefined);
    } catch (e) {
      process.stderr.write(`agent-review baseline: ${e.message}\n`);
    }
    process.exit(0);
  });
}
