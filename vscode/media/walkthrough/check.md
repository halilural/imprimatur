# Check the install

Imprimatur has two parts:

- **The Claude Code plugin** (hooks and an MCP server). The hooks record what the agent edits and what it asks you. The MCP server keeps tasks and records.
- **This VS Code extension.** It shows all of that.

**Check Setup** looks for the Claude Code CLI, the hooks, the MCP server and the database. It tells you what is missing and how to fix it. If nothing is missing, it says so.

If the plugin is missing, run this in a terminal:

```sh
claude plugin marketplace add halilural/imprimatur
claude plugin install imprimatur@imprimatur
```
