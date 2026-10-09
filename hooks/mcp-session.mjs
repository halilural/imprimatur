#!/usr/bin/env node
// PreToolUse for mcp__imprimatur__* (#58): Claude Code does not tell MCP
// servers which session calls them, so this hook adds `_session` to the tool's
// input; every record version then names the session. updatedInput replaces
// the whole input, hence the copy. The tools only touch Imprimatur's own
// database, so the call is allowed without a prompt. Any failure: exit 0, no
// output (the call goes on unchanged).
import fs from "node:fs";

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.session_id && String(input.tool_name ?? "").startsWith("mcp__imprimatur__")) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Imprimatur records",
        updatedInput: { ...(input.tool_input ?? {}), _session: input.session_id },
      },
    }));
  }
} catch {}
process.exit(0);
