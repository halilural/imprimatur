#!/usr/bin/env node
// Claude Code hook: PreToolUse for Edit|Write|Bash, PostToolUse for Bash.
// Bash edits (python, sed) are caught by the paths named in the command: text
// before, compared after. Before the agent edits a file of a listed type:
// - if there is no copy yet, copy the file to
//   <root>/.claude/imprimatur/baseline/<path> (an empty copy for a new file);
// - append {t, session, tool, prompt, intent, title, transcript, toolUseId, branch, before} to
//   .claude/imprimatur/history/<path>.jsonl (prompt: the user's request; intent:
//   the Bash description; title: the session's title; transcript + toolUseId:
//   where the extension later finds the agent's words for this call; branch:
//   the git branch at the edit, which names its task in <type>/<n>-name).
// The editor extension diffs the file against the copy until the user accepts.
// Git state is not consulted: staging or committing does not end a review.
//
//   node baseline.mjs [ext ...]   default extensions: md mdx
//
// Never blocks the tool: every path ends in exit 0.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { BASELINE_DIR, HISTORY_DIR, repoRoot, latestBefore } = createRequire(import.meta.url)("../vscode/review-state.js");

/** First line, at most `max` characters. @param {string} s @param {number} max */
const firstLine = (s, max) => {
  const first = s.trim().split("\n")[0];
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
};

/**
 * Records in a Claude Code transcript's last 512 KB, oldest first; the
 * window's cut first line is skipped. @param {string | undefined} transcript
 */
function tailRecords(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return [];
  const size = fs.statSync(transcript).size;
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(transcript, "r");
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  return buf
    .toString("utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return []; // first line of the window may be cut in half
      }
    });
}

/**
 * The user's latest request in a Claude Code transcript: the last
 * {type: "last-prompt", lastPrompt} record in the file's last 512 KB.
 * First line, at most 200 characters; undefined when there is none.
 * @param {string | undefined} transcript
 */
export function lastPrompt(transcript) {
  return transcriptInfo(transcript).prompt;
}

/**
 * What a transcript says now: the user's latest request and the session title
 * Claude gave the conversation. (The agent's words for an edit are written to
 * the transcript only after the tool call starts; the extension reads them
 * later by `toolUseId`, see vscode/narration.js.)
 * @param {string | undefined} transcript
 * @returns {{prompt?: string, title?: string}}
 */
export function transcriptInfo(transcript) {
  const recs = tailRecords(transcript);
  /** @type {{prompt?: string, title?: string}} */
  const out = {};
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (!out.prompt && r.type === "last-prompt" && typeof r.lastPrompt === "string") out.prompt = firstLine(r.lastPrompt, 200);
    if (!out.title && r.type === "ai-title" && typeof r.aiTitle === "string") out.title = firstLine(r.aiTitle, 80);
  }
  return out;
}

/** The checked-out branch at the repo root; undefined when detached or not git. @param {string} root */
function branchAt(root) {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** True when the log was written in the last 2 s: a second copy of this hook on the same edit. */
const sameEditWindow = (log) => Date.now() - fs.statSync(log).mtimeMs < 2000;

/**
 * @param {string} project Claude's project dir; files outside it are skipped
 * @param {string} file @param {string[]} [exts] @param {{session?: string, tool?: string, prompt?: string, intent?: string, title?: string, transcript?: string, toolUseId?: string}} [meta]
 * @param {string} [knownBefore] text before the edit when the caller already has it (Bash edits)
 */
export function takeBaseline(project, file, exts = ["md", "mdx"], meta = {}, knownBefore) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!exts.includes(ext)) return "skipped";
  const abs = path.resolve(project, file);
  const inProject = path.relative(project, abs);
  if (inProject.startsWith("..") || path.isAbsolute(inProject)) return "skipped";
  // Copies live at the git root (where the extension looks), else the project root.
  const root = repoRoot(path.dirname(abs)) ?? path.resolve(project);
  const rel = path.relative(root, abs);
  const before = knownBefore ?? (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "");
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
  const { session, tool, prompt, intent, title, transcript, toolUseId } = meta;
  const row = { t: new Date().toISOString(), session, tool, prompt, intent, title, transcript, toolUseId, branch: branchAt(root), before };
  fs.appendFileSync(log, JSON.stringify(row) + "\n");
  if (toolUseId) describeLater(root, rel, toolUseId);
  return kept ? "kept" : "written";
}

/**
 * Start hooks/describe.mjs in the background for this edit (a small model
 * writes the graph's description); the tool never waits for it.
 * IMPRIMATUR_DESCRIBE=off turns it off (tests); IMPRIMATUR_LANG picks the language.
 * @param {string} root @param {string} rel @param {string} toolUseId
 */
function describeLater(root, rel, toolUseId) {
  if (process.env.IMPRIMATUR_DESCRIBE === "off") return;
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "describe.mjs");
  const child = spawn(process.execPath, [script, root, rel, toolUseId, process.env.IMPRIMATUR_LANG || "English"], { detached: true, stdio: "ignore" });
  child.unref();
}

/**
 * Paths of listed file types named in a shell command (python/sed edits).
 * ponytail: files reached only through a glob (`sed -i *.md`) are not seen.
 * @param {string} command @param {string[]} exts
 */
export function pathsInCommand(command, exts) {
  const re = new RegExp(String.raw`[\w./~@+-]+\.(?:${exts.join("|")})\b`, "gi");
  return [...new Set(command.match(re) ?? [])];
}

const PENDING_DIR = path.join(".claude", "imprimatur", "pending");

/**
 * Bash, before: remember the text of the named files. After: record the ones
 * whose text changed, like an Edit; read-only commands (cat, grep) leave no trace.
 * @param {"PreToolUse" | "PostToolUse"} event @param {any} data @param {string} project @param {string[]} exts
 */
export function bashEdit(event, data, project, exts) {
  const id = String(data.tool_use_id ?? "").replace(/[^\w-]/g, "");
  if (!id) return;
  const pending = path.join(path.resolve(project), PENDING_DIR, `${id}.json`);
  if (event === "PreToolUse") {
    const command = String(data.tool_input?.command ?? "");
    // Relative paths: the command's own `cd <dir>` first, then the tool's cwd, then the project.
    const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1]?.replace(/^["']|["']$/g, "");
    const bases = [cd && path.resolve(data.cwd || project, cd.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")), data.cwd, project].filter(Boolean);
    /** @type {Record<string, string>} */
    const before = {};
    for (const p of pathsInCommand(command, exts)) {
      const candidates = bases.map((b) => path.resolve(b, p));
      const abs = candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
      const inProject = path.relative(project, abs);
      if (inProject.startsWith("..") || path.isAbsolute(inProject)) continue;
      if (inProject.split(path.sep).slice(0, 2).join("/") === ".claude/imprimatur") continue;
      before[abs] = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    }
    if (!Object.keys(before).length) return;
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.writeFileSync(pending, JSON.stringify(before));
    return;
  }
  if (!fs.existsSync(pending)) return;
  /** @type {Record<string, string>} */
  const before = JSON.parse(fs.readFileSync(pending, "utf8"));
  fs.rmSync(pending, { force: true });
  // A Bash call says what it does in its own description.
  const description = data.tool_input?.description;
  const meta = { session: data.session_id, tool: "Bash", ...transcriptInfo(data.transcript_path), intent: description ? firstLine(String(description), 120) : undefined,
    transcript: data.transcript_path, toolUseId: data.tool_use_id };
  for (const [abs, text] of Object.entries(before)) {
    const now = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    if (now !== text) takeBaseline(project, abs, exts, meta, text);
  }
}

// IMPRIMATUR_CHILD: a model call started by describe.mjs; nothing to record.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && !process.env.IMPRIMATUR_CHILD) {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input || "{}");
      const file = data.tool_input?.file_path;
      const project = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
      const args = process.argv.slice(2).map((e) => e.toLowerCase());
      const exts = args.length ? args : ["md", "mdx"];
      if (data.tool_name === "Bash") bashEdit(data.hook_event_name, data, project, exts);
      else if (file && data.hook_event_name !== "PostToolUse")
        takeBaseline(project, file, exts, { session: data.session_id, tool: data.tool_name, ...transcriptInfo(data.transcript_path),
          transcript: data.transcript_path, toolUseId: data.tool_use_id });
    } catch (e) {
      process.stderr.write(`imprimatur baseline: ${e.message}\n`);
    }
    process.exit(0);
  });
}
