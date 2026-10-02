#!/usr/bin/env node
// Claude Code PreToolUse hook for Edit|Write. Before the agent edits a file of
// a listed type:
// - if there is no copy yet, copy the file to
//   <root>/.claude/agent-review/baseline/<path> (an empty copy for a new file);
// - append {t, session, tool, before} to .claude/agent-review/history/<path>.jsonl.
// The editor extension diffs the file against the copy until the user accepts.
// Git state is not consulted: staging or committing does not end a review.
//
//   node baseline.mjs [ext ...]   default extensions: md mdx
//
// Never blocks the tool: every path ends in exit 0.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { BASELINE_DIR, HISTORY_DIR, repoRoot } = createRequire(import.meta.url)("../vscode/review-state.js");

/**
 * @param {string} project Claude's project dir; files outside it are skipped
 * @param {string} file @param {string[]} [exts] @param {{session?: string, tool?: string}} [meta]
 */
export function takeBaseline(project, file, exts = ["md", "mdx"], meta = {}) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!exts.includes(ext)) return "skipped";
  const abs = path.resolve(project, file);
  const inProject = path.relative(project, abs);
  if (inProject.startsWith("..") || path.isAbsolute(inProject)) return "skipped";
  // Copies live at the git root (where the extension looks), else the project root.
  const root = repoRoot(path.dirname(abs)) ?? path.resolve(project);
  const rel = path.relative(root, abs);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const copy = path.join(root, BASELINE_DIR, rel);
  const kept = fs.existsSync(copy);
  if (!kept) {
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, before);
  }
  const log = path.join(root, HISTORY_DIR, `${rel}.jsonl`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), session: meta.session, tool: meta.tool, before }) + "\n");
  return kept ? "kept" : "written";
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
      if (file) takeBaseline(project, file, exts.length ? exts : undefined, { session: data.session_id, tool: data.tool_name });
    } catch (e) {
      process.stderr.write(`agent-review baseline: ${e.message}\n`);
    }
    process.exit(0);
  });
}
