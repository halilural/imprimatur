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

/** Characters a path in a permission rule may have: none with a meaning in rule syntax (, ( ) * ? [ ] { } spaces). */
const PLAIN = /^[\w./~@+-]+$/;

/** A permission rule's path for an absolute file: "//abs" (Claude Code's settings syntax). Throws on a path that is not plain. @param {string} abs */
function rulePath(abs) {
  const p = path.resolve(abs);
  if (!PLAIN.test(p)) throw new Error(`not a plain path for a permission rule: ${p.slice(0, 120)}`);
  return `/${p}`;
}

/**
 * The CLI's arguments for a fix. Without --permission-mode, -p denies what is not allowed.
 * Throws when a target path is not plain enough to be a rule (the caller copies the prompt instead).
 * @param {string} prompt @param {{edit?: string[], editDirs?: string[], addDirs?: string[]}} [o]
 * edit: the files it may change; editDirs: folders it may change and add to; addDirs: folders outside the repo it may read
 */
function claudeArgs(prompt, { edit = [], editDirs = [], addDirs = [] } = {}) {
  const allow = ["Read", "Glob", "Grep",
    ...[...new Set(edit)].map((f) => `Edit(${rulePath(f)})`),
    ...[...new Set(editDirs)].flatMap((d) => [`Edit(${rulePath(d)}/**)`, `Write(${rulePath(d)}/**)`])];
  // No hooks: the run edits nothing, and the user's hooks (Imprimatur's own among them) would add their context to its answer.
  return ["-p", prompt, "--setting-sources", "user", "--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true }),
    // One argument per rule: a rule is never split or joined on a comma.
    "--allowedTools", ...allow, "--disallowedTools", "Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit",
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

module.exports = { claudeArgs, outside, claudeBin, rulePath, PLAIN };
