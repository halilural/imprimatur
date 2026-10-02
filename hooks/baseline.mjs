#!/usr/bin/env node
// Claude Code PreToolUse hook for Edit|Write. Before the agent edits a file of
// a listed type:
// - if there is no copy yet, copy the file to
//   <root>/.claude/agent-review/baseline/<path> (an empty copy for a new file);
// - append {t, session, tool, prompt, before} to .claude/agent-review/history/<path>.jsonl.
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

const { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore } = createRequire(import.meta.url)("../vscode/review-state.js");

/**
 * The user's latest request in a Claude Code transcript: the last
 * {type: "last-prompt", lastPrompt} record in the file's last 512 KB.
 * First line, at most 200 characters; undefined when there is none.
 * @param {string | undefined} transcript
 */
export function lastPrompt(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return undefined;
  const size = fs.statSync(transcript).size;
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(transcript, "r");
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"last-prompt"')) continue;
    try {
      const rec = JSON.parse(lines[i]);
      if (rec.type === "last-prompt" && typeof rec.lastPrompt === "string") {
        const first = rec.lastPrompt.trim().split("\n")[0];
        return first.length > 200 ? `${first.slice(0, 199)}…` : first;
      }
    } catch {
      // first line of the window may be cut in half
    }
  }
  return undefined;
}

/** True when the log was written in the last 2 s: a second copy of this hook on the same edit. */
const sameEditWindow = (log) => Date.now() - fs.statSync(log).mtimeMs < 2000;

/**
 * @param {string} project Claude's project dir; files outside it are skipped
 * @param {string} file @param {string[]} [exts] @param {{session?: string, tool?: string, prompt?: string}} [meta]
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
  // The same hook can be installed twice (project and user settings); one line per edit.
  if (latestBefore(log) === before && sameEditWindow(log)) return kept ? "kept" : "written";
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), session: meta.session, tool: meta.tool, prompt: meta.prompt, before }) + "\n");
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
      if (file) takeBaseline(project, file, exts.length ? exts : undefined, { session: data.session_id, tool: data.tool_name, prompt: lastPrompt(data.transcript_path) });
    } catch (e) {
      process.stderr.write(`agent-review baseline: ${e.message}\n`);
    }
    process.exit(0);
  });
}
