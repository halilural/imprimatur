# Security policy

## Supported versions

Imprimatur is released from `main`; only the latest release gets fixes. Update
to it (`git pull` in your clone, then `npm run setup`) before reporting.

## Reporting a vulnerability

Please report privately, not in a public issue: open
[Report a vulnerability](https://github.com/halilural/imprimatur/security/advisories/new)
(GitHub's private vulnerability reporting). Include what is affected, how to
reproduce it, and the version (`vscode/package.json`).

You can expect an acknowledgement within a week. A confirmed issue is fixed in
a release as soon as practical, and credited in the advisory unless you ask
otherwise.

## What is in scope

Imprimatur runs with your permissions on your machine, so these matter most:

- **Hooks** (`hooks/`): they run on every tool call of a coding agent and read
  its session transcripts.
- **The MCP server** (`mcp/server.mjs`) and **the database** (one SQLite file
  per device): records and decisions of every repo you use it with.
- **The VS Code extension** (`vscode/`): workspace trust gates what runs in an
  untrusted folder; webviews render agent and model output.
- **Child processes**: the extension and hooks start `claude`, `git`, `gh` and
  `npx agnix`; the project review sends repository content to Claude.
- **The sync Worker** (`cloud/`): tokens, webhook signatures, the data it stores.

Text that an agent or a model wrote (records, recommendations, synced data) is
untrusted input; a way to make it run code, read secrets or reach the network
through Imprimatur is a vulnerability.
