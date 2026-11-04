// @ts-check
// Fix it in the background (#156): Claude Code's CLI runs the fix prompt with `claude -p` and
// exits; the user confirms first, sees a progress notification, then the agent's answer. The
// run loads only the user's settings (no repo hooks or permissions) and no MCP servers. It may
// read anything, edit only the target files (a skill update: the skill's folder), and run no
// commands; its edits are tracked for review like any other agent edit. No shell: the prompt
// goes to the CLI as one argument.
// shortcut: permission rules use POSIX absolute paths ("//home/..."); Windows paths are not
// written in that form yet, so there Fix it only edits files inside the repo.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** A permission rule's path for an absolute file: "//abs" (Claude Code's settings syntax). @param {string} abs */
const rulePath = (abs) => `/${path.resolve(abs)}`;

/**
 * The CLI's arguments for a fix. Without --permission-mode, -p denies what is not allowed.
 * @param {string} prompt @param {{edit?: string[], editDirs?: string[], addDirs?: string[]}} [o]
 * edit: the files it may change; editDirs: folders it may change and add to; addDirs: folders outside the repo it may read
 */
function claudeArgs(prompt, { edit = [], editDirs = [], addDirs = [] } = {}) {
  const allow = ["Read", "Glob", "Grep",
    ...[...new Set(edit)].map((f) => `Edit(${rulePath(f)})`),
    ...[...new Set(editDirs)].flatMap((d) => [`Edit(${rulePath(d)}/**)`, `Write(${rulePath(d)}/**)`])];
  return ["-p", prompt, "--setting-sources", "user", "--strict-mcp-config",
    "--allowedTools", allow.join(","), "--disallowedTools", "Bash,WebFetch,WebSearch,Task,NotebookEdit",
    ...[...new Set(addDirs)].flatMap((d) => ["--add-dir", d]), "--output-format", "text"];
}

/** Folders of these paths that lie outside the repo, for --add-dir. @param {string} root @param {string[]} files */
const outside = (root, files) =>
  [...new Set(files.filter(Boolean).map((f) => path.dirname(path.resolve(f))).filter((d) => d !== path.resolve(root) && !d.startsWith(path.resolve(root) + path.sep)))];

/** The claude CLI: on PATH, else where its installer puts it. @param {NodeJS.ProcessEnv} [env] */
function claudeBin(env = process.env) {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = [...String(env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local")];
  for (const d of dirs) for (const n of names) if (d && fs.existsSync(path.join(d, n))) return path.join(d, n);
  return "";
}

module.exports = { claudeArgs, outside, claudeBin, rulePath };
