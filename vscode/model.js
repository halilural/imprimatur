// @ts-check
// One small-model call (Haiku) through the Claude Code CLI, for the hooks and
// the extension: no tools, no MCP, no settings files (so no hooks run in it;
// IMPRIMATUR_CHILD also keeps ours quiet), from a temp dir, nothing saved.
"use strict";
const { execFile } = require("node:child_process");
const os = require("node:os");

const TIMEOUT_MS = 60_000;

/** @param {string} prompt @param {string} [model] @param {number} [timeoutMs] a longer wait for a long answer @returns {Promise<string>} the model's reply */
function askModel(prompt, model = "haiku", timeoutMs = TIMEOUT_MS) {
  const args = ["-p", "--model", model, "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--no-session-persistence", "--disable-slash-commands", prompt];
  return new Promise((resolve, reject) =>
    execFile("claude", args, { cwd: os.tmpdir(), timeout: timeoutMs, env: { ...process.env, IMPRIMATUR_CHILD: "1" } }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );
}

module.exports = { askModel };
