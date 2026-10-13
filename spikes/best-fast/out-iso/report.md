# ISO 25010 + SSDF best-practice spike — 2026-10-13T10:37

Timings (s): {"map_model":52.9,"map_context7":3.8,"fetch":11.1,"judge":52.7,"total":120.5} · cost (API-equivalent) $3.32
Map: 10 components, Context7 for 9; fetch 110 requests → 40 excerpts

## Categories
- ✓ Functional suitability: Core functionality requires correctly tracking AI agent edits, managing tasks/records, maintaining database integrity across processes, and syncing data between machines—all critical to the tool's purpose.
- ✓ Performance efficiency: Extension must respond to editor changes within 50ms, database queries complete in <1ms for 10k records, and sync across devices targets 0.3–1.5s—meeting these targets affects usability.
- ✓ Compatibility: System must work across Linux/WSL/macOS/Windows, integrate with Claude Code/Cursor/Codex, support GitHub/Jira, and maintain backward compatibility with multiple MCP protocol versions.
- ✓ Interaction capability: Complex UI with webview panels, tree views, markdown preview markers, keyboard shortcuts, and agent setup flow requires clear interaction design and learnability.
- ✓ Reliability: Data persistence via SQLite must survive concurrent access from hooks, extension, and MCP server; sync failures or data corruption would lose task/record history permanently.
- ✓ Security: System handles authentication tokens (GitHub, Jira, sync), enforces workspace trust to prevent untrusted folders from running model calls, and syncs development metadata to cloud.
- ✓ Maintainability: Large codebase spans hooks, MCP server, extension, cloud worker, with shared modules between processes; must be analyzable and modifiable without introducing regressions.
- ✓ Flexibility: Must adapt to arbitrary repository structures, support multiple issue trackers and languages, allow per-repo configuration, and work with different Claude Code setups.
- ✓ Safety: Tool operates on developer workflows and code; process checks prevent merging without documentation, guard main branch edits, and validate design decisions before implementation.
- ✓ Development process (SSDF): Implements secure practices: HMAC signature verification for webhooks, constant-time token comparison, workspace trust model, token storage in restricted files (mode 0600), and audit trail of all changes.

## Runs
- Functional suitability: 1 proposed, 4 turns, 28.4 s, $0.30
- Performance efficiency: 1 proposed, 6 turns, 29.1 s, $0.31
- Compatibility: 2 proposed, 3 turns, 30.3 s, $0.34
- Interaction capability: 0 proposed, 6 turns, 27.6 s, $0.31
- Reliability: 2 proposed, 7 turns, 42.9 s, $0.35
- Security: 1 proposed, 6 turns, 45 s, $0.33
- Maintainability: 2 proposed, 5 turns, 37.5 s, $0.32
- Flexibility: 2 proposed, 4 turns, 35.9 s, $0.29
- Safety: 0 proposed, 3 turns, 28.4 s, $0.27
- Development process (SSDF): 3 proposed, 4 turns, 48.6 s, $0.36
- Gate: 10 kept, 4 dropped for citing an unfetched URL, 0 dropped by the gate

## ISO 25010 · Functional suitability
### functional completeness
- **[medium] Add a way to verify and recover the single source-of-truth database** — vscode/db.js
  SQLite docs recommend PRAGMA integrity_check/quick_check for corruption detection and a backup/vacuum path for recovery. Imprimatur's db.js now holds every repo's ADRs, decisions, tasks and records as the sole source of truth (decision 527, 531 — Markdown fully removed) across every device (decision 622/623), and on node:sqlite load failure or corruption it throws with no JSON fallback (decision 622: 'sessiz geri dönüş, JSON yedeği yok'). There is currently no exposed integrity_check, backup, or export command in db.js or scripts/, so a corrupted single file could silently lose every repo's architecture/product decisions with no recovery path.
  Evidence: vscode/db.js:1641-1651, docs/ARCHITECTURE.md#key-database · Source: https://context7.com/context7/www_sqlite_org-docs.html/llms.txt
  Next: In vscode/db.js, add an integrity_check (or quick_check) run on open (or an exposed `npm run db:check` script) and a simple file-copy/backup command before migrations run, so a corrupted cross-repo DB can be detected and recovered instead of hard-failing with no fallback.

## ISO 25010 · Performance efficiency
### time behaviour
- **[medium] Enable Node's module compile cache for hook processes** — hooks/*.mjs
  Node.js docs recommend module.enableCompileCache() (or NODE_COMPILE_CACHE) to cache V8 code generation across process invocations, cutting repeated startup cost. The architecture doc measures each hook at ~65ms with 43ms being pure Node startup, and hooks run on every Edit/Write/Bash/MCP tool call across every session — this startup tax is paid constantly and is the single biggest fixed cost in the hot path.
  Evidence: docs/ARCHITECTURE.md#key-hooks:176, docs/ARCHITECTURE.md:429 · Source: https://github.com/nodejs/node/blob/main/doc/api/module.md
  Next: In hooks/baseline.mjs, hooks/waiting.mjs, hooks/process.mjs, hooks/mcp-session.mjs, hooks/activity.mjs, and mcp/server.mjs, call require('node:module').enableCompileCache() (or set NODE_COMPILE_CACHE in the hook command env in hooks/hooks.json) at the top of each entry point, writing the cache to a stable dir under $XDG_CACHE_HOME so it persists across invocations.

## ISO 25010 · Compatibility
### co-existence
- **[medium] Align package.json engines.node with the actual node:sqlite / Node 22.13 requirement** — package.json
  npm's package.json docs say the engines field declares the Node.js versions a package supports so other tools and users can check compatibility before running it. The repo's own architecture doc and decisions state hooks/MCP/the extension require Node >=22.13 for node:sqlite to work without the 'experimental' warning, but package.json only declares '>=22', so npm/npx won't warn a user on Node 22.0-22.12 before db.js throws.
  Evidence: package.json:9, docs/ARCHITECTURE.md#key-database · Source: https://github.com/nodejs/node/blob/main/deps/npm/docs/content/configuring-npm/package-json.md
  Next: Change package.json:9 'engines.node' from '>=22' to '>=22.13.0' to match the documented node:sqlite requirement.

## ISO 25010 · Reliability
### fault tolerance
- **[medium] Retry transient D1 write failures in the sync push handler** — cloud/src/server.js (sync push)
  Cloudflare's D1 docs recommend retrying write queries with exponential backoff to handle transient D1 errors (e.g. lock contention, network blips) rather than failing the request outright. The push handler in server.js inserts changes and reads back the new max seq in a single db.batch() call with no retry wrapper around transient failures, so a momentary D1 hiccup surfaces as a hard sync failure to the device instead of being absorbed.
  Evidence: cloud/src/server.js:129-134 · Source: https://developers.cloudflare.com/d1/best-practices/retry-queries/
  Next: In cloud/src/server.js, wrap the env.DB.batch(...) call in the push handler with a small retry-with-backoff helper that retries on transient D1 errors before returning failure to the client.
### recoverability
- **[high] Back up imprimatur.db before applying schema migrations** — vscode/db.js (schema migrations)
  Node's node:sqlite module exposes a backup() API specifically for safely snapshotting a database before risky operations. Imprimatur keeps a single device-wide database file for every repo (docs/ARCHITECTURE.md#key-database), and openDb() applies MIGRATIONS in place with no prior snapshot; a buggy migration would corrupt the one and only copy of every repo's tasks and records on that machine, with no way back.
  Evidence: vscode/db.js:1649-1651, docs/ARCHITECTURE.md#key-database · Source: https://github.com/nodejs/node/blob/main/doc/api/sqlite.md
  Next: In vscode/db.js, before the migration loop at line 1650 (when v < VERSION on open), copy the db file (or use node:sqlite's backup() API) to a timestamped sibling file so a failed migration can be rolled back manually.

## ISO 25010 · Security
### confidentiality
- **[medium] Restrict permissions on the shared imprimatur.db file and its directory** — vscode/db.js
  The single per-device SQLite database aggregates tasks, records, decisions and ADR/PDR text across every repo on the machine, yet openDb() creates the directory and database file with the process umask instead of an explicit restrictive mode. Elsewhere in the same codebase (vscode/sync.js, vscode/setup-audit.js) the project already treats sensitive local files as needing an explicit 0o600, since Node's fs module lets code verify and set permissions rather than trust the umask.
  Evidence: vscode/db.js:1634, vscode/db.js:1637, vscode/sync.js:40, vscode/setup-audit.js:60 · Source: https://github.com/nodejs/node/blob/main/doc/api/fs.md
  Next: In openDb() (vscode/db.js), after mkdirSync and after creating/opening the DatabaseSync file, call fs.chmodSync on both the directory and the .db/-wal/-shm files to 0o600/0o700, mirroring the pattern already used in sync.js and setup-audit.js.

## ISO 25010 · Flexibility
### installability
- **[medium] Tighten engines.node to match the documented node:sqlite requirement** — package.json
  The Node.js docs note that engines ranges are the contract installers check before setup. Imprimatur's own architecture doc requires Node >=22.13 for hooks and the MCP server (node:sqlite stability), but package.json:9 only declares >=22, so `npm install` on Node 22.0–22.12 succeeds and then fails later with the hard node:sqlite error the architecture doc describes (no JSON fallback).
  Evidence: package.json:9, docs/ARCHITECTURE.md#key-database · Source: https://github.com/nodejs/node/blob/main/deps/npm/docs/content/configuring-npm/package-json.md
  Next: Change package.json:9 engines.node to ">=22.13.0" so it matches the ≥22.13 requirement stated in docs/ARCHITECTURE.md's database section.

## NIST SSDF · Development process (SSDF)
### PO prepare the organization
- **[low] Refresh the pinned Claude Code version agnix validates against** — agnix setup audit
  `.agnix.toml` fixes `claude_code = "2.1.283"` as the baseline agnix's version-specific rules assume, but agnix 0.57.0's own changelog says its reviewed baseline has already moved to Claude Code 2.1.294 (and 2.1.292 before that). SSDF PO.3 asks for maintaining the toolchain/configuration the organization relies on in a known-good, current state; a stale pin means agnix's version-specific checks (CC-PL-017, CC-SK-021, etc.) run against assumptions two releases behind what Imprimatur's users likely have installed.
  Evidence: .agnix.toml:4 · Source: https://github.com/agent-sh/agnix/releases
  Next: Bump `.agnix.toml`'s `tool_versions.claude_code` to match the Claude Code version this repo and `npm run audit` are actually exercised against, and note the update in the file's existing comment.
### PW produce well-secured software
- **[medium] Run npm audit on devDependencies (markdown-it, mermaid, esbuild, @vscode/vsce)** — package.json devDependencies
  Node.js's own tooling documents `npm audit` / `npm audit fix` as the baseline way to scan and remediate known-vulnerable dependencies (SSDF PW.4 — reuse existing, well-secured software; track and update components). The project has a package-lock.json (good) but no audit script or CI step, so a new CVE in markdown-it, mermaid or esbuild would go unnoticed until someone runs it manually.
  Evidence: package.json:25-31 · Source: https://github.com/nodejs/node/blob/main/deps/npm/docs/output/commands/npm-audit.html
  Next: Add an `"audit": "npm audit --audit-level=high"` script to package.json and call it from the CI workflow (ssdf-no-ci-pipeline-for-main).
### RV respond to vulnerabilities
- **[high] Add a CI pipeline that runs tests (and audit) before merging to main** — package.json / repo CI
  NIST SSDF PW.7/PW.8 call for verifying code via testing before release, and RV.1 calls for identifying vulnerabilities continuously. This repo has no .github/workflows at all (only issue templates) and npm test/test:integration are run manually. Because merging to main immediately deploys hooks/MCP and migrates the live DB (per project memory 'Main checkout is live'), an unverified merge has an outsized blast radius with no automated gate catching a broken test or a newly disclosed vulnerable dependency first.
  Evidence: package.json:12-13, .github/ISSUE_TEMPLATE/config.yml · Source: https://github.com/nodejs/node/blob/main/deps/npm/docs/output/commands/npm-audit.html
  Next: Add .github/workflows/ci.yml running `npm test`, `npm run test:integration`, and `npm audit --audit-level=high` on push/PR, so main never receives an unverified commit.

## Dropped
- compatibility compatibility-cloud-wrangler-compatibility-date-stale: cites https://developers.cloudflare.com/workers/best-practices/workers-best-practices/ (not fetched)
- maintainability maintainability-cloud-worker-stale-compatibility-date: cites https://developers.cloudflare.com/workers/best-practices/workers-best-practices/ (not fetched)
- maintainability maintainability-sync-worker-fake-d1-vs-real-runtime: cites https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ (not fetched)
- flexibility flexibility-scalability-worker-smart-placement: cites https://developers.cloudflare.com/workers/ (not fetched)
