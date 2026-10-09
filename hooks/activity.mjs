#!/usr/bin/env node
// Every tool call, in a line (#55): PostToolUse and PostToolUseFailure, async
// (Claude Code does not wait). vscode/activity.js writes the row to
// .claude/imprimatur/activity/<session>.jsonl in the call's git root. Any
// failure: exit 0, nothing written.
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
try {
  // A model call started by Imprimatur itself is not the agent's work.
  if (!process.env.IMPRIMATUR_CHILD) {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const { repoOf } = require("../vscode/process.js");
    const root = repoOf(input.cwd ?? process.cwd());
    if (root) require("../vscode/activity.js").record(root, input);
  }
} catch {}
process.exit(0);
