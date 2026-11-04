// @ts-check
// Fix it in the background (#156): Claude Code's CLI runs the fix prompt with `claude -p` and
// exits; the user sees a progress notification, then the agent's answer. It may only read and
// edit files (and, for a skill update, call `gh api`); its edits are tracked for review like
// any other agent edit. No shell: the prompt goes to the CLI as one argument.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Tools the background run may use. A skill update also reads its source through gh. */
const TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "mcp__imprimatur__setup_audit"];

/**
 * The CLI's arguments for a fix. @param {string} prompt
 * @param {{gh?: boolean, addDirs?: string[]}} [o] gh: allow `gh api` (skill updates); addDirs: folders outside the repo it may edit
 */
function claudeArgs(prompt, { gh = false, addDirs = [] } = {}) {
  return ["-p", prompt, "--permission-mode", "acceptEdits",
    "--allowedTools", [...TOOLS, ...(gh ? ["Bash(gh api:*)"] : [])].join(","),
    // A user's own allow rules could let other commands through: shut them for this run.
    "--disallowedTools", gh ? "WebFetch,WebSearch,Bash(curl:*),Bash(wget:*)" : "Bash,WebFetch,WebSearch",
    ...[...new Set(addDirs)].flatMap((d) => ["--add-dir", d]), "--output-format", "text"];
}

/** Folders of these files that lie outside the repo, for --add-dir. @param {string} root @param {string[]} files */
const outside = (root, files) =>
  [...new Set(files.filter(Boolean).map((f) => path.dirname(path.resolve(f))).filter((d) => d !== path.resolve(root) && !d.startsWith(path.resolve(root) + path.sep)))];

/** The claude CLI: on PATH, else where its installer puts it. @param {NodeJS.ProcessEnv} [env] */
function claudeBin(env = process.env) {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = [...String(env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local")];
  for (const d of dirs) for (const n of names) if (d && fs.existsSync(path.join(d, n))) return path.join(d, n);
  return "";
}

module.exports = { claudeArgs, outside, claudeBin, TOOLS };
