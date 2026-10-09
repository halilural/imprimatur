#!/usr/bin/env node
// Process checks (#56): SessionStart, PreToolUse, PostToolUse and Stop, for
// repos that turn them on with .claude/imprimatur.json (vscode/process.js).
// Without that file, or on any failure of its own, it does nothing (exit 0):
// a broken check must not stop the agent.
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
let out = { code: 0 };
try {
  const { check, reply } = require("../vscode/process.js");
  const event = input.hook_event_name;
  out = reply(event, check(event, input));
} catch (e) {
  process.stderr.write(`imprimatur process hook: ${e instanceof Error ? e.message : e}\n`);
  out = { code: 0 };
}
if (out.stdout) process.stdout.write(out.stdout);
if (out.stderr) process.stderr.write(out.stderr + "\n");
process.exit(out.code);
