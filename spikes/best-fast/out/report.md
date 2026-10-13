# Fast best-practice spike — 2026-10-13T10:18

Timings (s): {"map_model":43.9,"map_context7":3.2,"fetch":17.3,"judge":83.7,"total":148}
Map: 16 components (haiku 16 turns, $0.145), Context7 ids for 14
Fetch: 70 requests, 63 excerpts; shared ~21976 tokens, per pillar ~31218/14892/12339 tokens
- deps: 5 proposed, 5 turns, 83.7 s, $0.552, cache read 223004 / created 106940
- security: 1 proposed, 14 turns, 46 s, $0.298, cache read 727640 / created 30868
- testing: 3 proposed, 7 turns, 48.1 s, $0.189, cache read 292522 / created 23879
Gate: 9 kept (7 cite a fetched URL, 2 do not), 0 dropped

## Components
- Node.js >=22.13 (hooks/MCP), 24 (VS Code plugin) — context7 /nodejs/node — other — https://nodejs.org/en/blog/
- SQLite (node:sqlite) Built-in — context7 - — other — https://nodejs.org/api/sqlite.html
- Visual Studio Code ^1.100.0 — context7 /microsoft/vscode-docs — microsoft — https://code.visualstudio.com/updates
- esbuild 0.28.2 — context7 /evanw/esbuild — other — https://github.com/evanw/esbuild/releases
- markdown-it ^15.0.2 — context7 /markdown-it/markdown-it — other — https://github.com/markdown-it/markdown-it/releases
- Mermaid 12.0.0 — context7 /mermaid-js/mermaid — other — https://github.com/mermaid-js/mermaid/releases
- Cloudflare Workers Latest (compatibility_date: 2026-07-15) — context7 /llmstxt/developers_cloudflare_workers_llms-full_txt — cloudflare — https://developers.cloudflare.com/workers/platform/changelog/
- Cloudflare D1 Latest (as of 2026-07-15) — context7 /llmstxt/developers_cloudflare_d1_llms-full_txt — cloudflare — https://developers.cloudflare.com/d1/platform/changelog/
- Cloudflare Durable Objects Latest (SQLite-backed, free plan) — context7 /llmstxt/developers_cloudflare_durable-objects_llms-full_txt — cloudflare — https://developers.cloudflare.com/durable-objects/platform/changelog/
- Claude (AI model) Via CLI (Haiku for background, Sonnet for reviews) — context7 /llmstxt/platform_claude_llms_txt — other — https://claude.ai/releases
- agnix 0.57.0 — context7 /agent-sh/agnix — other — https://github.com/agent-sh/agnix/releases
- VS Code Extension Packaging (@vscode/vsce) 4.0.0 — context7 - — microsoft — https://github.com/microsoft/vscode-vsce/releases
- GitHub Latest API — context7 /websites/github_en — other — https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads
- Jira Latest API — context7 /websites/confluence_atlassian_jira — other — https://developer.atlassian.com/cloud/jira/platform/change-log/
- Context7 Latest — context7 /upstash/context7 — other — https://github.com/context7/context7
- Wrangler Latest (via npx, pinned by @schema) — context7 /cloudflare/wrangler-action — cloudflare — https://github.com/cloudflare/workers-sdk/releases

- [deps/high] **Raise package.json engines.node to match the node:sqlite requirement** — Node.js
  Node's node:sqlite docs state SQLite support became usable without a flag only as of v22.13.0/v23.4.0 (nodejs.org/api/sqlite.html, 'SQLite is no longer experimental'). The architecture decision itself says hooks/MCP need 'Node ≥ 22.13: bayraksız', but the published engines.node constraint is only '>=22', which would let someone install on 22.0–22.12 where node:sqlite needs --experimental-sqlite or isn't guaranteed stable, contradicting db.js's 'fail loud, no fallback' design.
  Evidence: package.json:9, docs/ARCHITECTURE.md#database · Source: https://nodejs.org/api/sqlite.html
  Next: In package.json, change "engines": {"node": ">=22"} to ">=22.13.0" so npm/CI actually enforce the floor the architecture doc and db.js assume.
- [deps/medium] ⚠ uncited **Add the nodejs_compat compatibility flag to the sync Worker** — Cloudflare Workers
  Cloudflare's Workers Best Practices guide explicitly calls out 'Keep your compatibility date current and enable nodejs_compat — Ensure you have access to the latest runtime features and Node.js built-in modules' as key guidance. cloud/wrangler.jsonc sets compatibility_date but has no compatibility_flags block at all, so the Worker can't use any Node built-ins without a later change and migration.
  Evidence: cloud/wrangler.jsonc:6 · Source: https://developers.cloudflare.com/changelog/product/workers/5/
  Next: Add "compatibility_flags": ["nodejs_compat"] to cloud/wrangler.jsonc alongside the existing compatibility_date, even if unused today — it avoids a future migration when the Worker needs a Node built-in.
- [deps/medium] **Pin Wrangler as a devDependency instead of bare npx calls** — Cloudflare Workers
  Cloudflare's own Wrangler install docs recommend 'installing locally rather than globally to control versions per project and allow rollbacks' (npm i -D wrangler@latest), not ad-hoc npx. cloud/wrangler.jsonc's comments only reference bare `npx wrangler d1 create` / `wrangler deploy` / `wrangler secret put` with no pinned version anywhere in the repo, so every invocation can silently pick up a new major Wrangler (v4's breaking removals of legacy_assets/node_compat/usage_model already happened once).
  Evidence: cloud/wrangler.jsonc:12, cloud/wrangler.jsonc:24, cloud/wrangler.jsonc:25 · Source: https://developers.cloudflare.com/workers/wrangler/install-and-update
  Next: Add a cloud/package.json with wrangler pinned as a devDependency (e.g. "wrangler": "^4") and switch the deploy comments/instructions to npm scripts that resolve the local, version-controlled binary.
- [deps/low] **Bump the pinned Claude Code baseline in .agnix.toml** — agnix
  agnix 0.57.0's release notes say it has reviewed 'Claude Code 2.1.294' for its version-specific rules, but .agnix.toml pins tool_versions.claude_code = "2.1.283", an older patch. Since agnix's rules are keyed to this version (per the file's own comment), leaving it stale means the audit may miss checks or behaviors validated for the newer release.
  Evidence: .agnix.toml:4 · Source: https://github.com/agent-sh/agnix/releases
  Next: Update .agnix.toml's [tool_versions] claude_code to "2.1.294" (or whatever Claude Code version is actually installed) to match agnix 0.57.0's reviewed baseline.
- [deps/low] **Mermaid is pinned two minors behind latest** — Mermaid
  package.json pins mermaid at exact "12.0.0" while the Mermaid GitHub releases page shows 12.2.0 as current, with intervening patch fixes (e.g. mindmap/swimlane rendering fixes). Low urgency since the Mermaid diff feature is default-off per decision 334, but the bundled mermaid.min.js used for plain rendering in previews still ships the older code.
  Evidence: package.json:30 · Source: https://github.com/mermaid-js/mermaid/releases
  Next: Bump the mermaid devDependency from the exact "12.0.0" pin to "12.2.0" (keep exact pin, re-run scripts/build.mjs's bundling and the mermaid-diff tests) next time dependencies are refreshed.
- [security/low] ⚠ uncited **Declare required secrets in wrangler.jsonc** — cloud/wrangler.jsonc
  Cloudflare's Wrangler docs (changelog 2026-03-24, 'Declare required secrets in your Wrangler configuration') recommend a `secrets.required` array so `wrangler dev`/`deploy` validate that SYNC_TOKEN and GITHUB_WEBHOOK_SECRET are actually set, instead of silently falling back to the 'no secret set: nobody gets in' behavior noted in cloud/src/server.js:10 and :174. Right now a missing secret just locks everyone out with no deploy-time warning.
  Evidence: cloud/wrangler.jsonc:1-26, cloud/src/server.js:40, cloud/src/server.js:180 · Source: https://developers.cloudflare.com/changelog/26/
  Next: Add `"secrets": {"required": ["SYNC_TOKEN", "GITHUB_WEBHOOK_SECRET"]}` to cloud/wrangler.jsonc so missing secrets are flagged at deploy/dev time.
- [testing/high] **Add a GitHub Actions workflow to run npm test on push/PR** — CI
  The repo has 44 unit test files and an integration suite (test:integration) but no `.github/workflows/` directory at all, so nothing runs them automatically on push or pull request. GitHub's own Node.js CI guide recommends a minimal checkout + setup-node + `npm install` + `npm test` workflow for exactly this situation, and since 0.50.0 ships a Cloudflare sync server plus a VS Code extension, regressions in either currently only surface when a human remembers to run `npm test` locally.
  Evidence: package.json:12-13 - test and test:integration scripts exist, docs/ARCHITECTURE.md#testing · Source: https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs
  Next: Add .github/workflows/test.yml: actions/checkout + actions/setup-node (node-version matching engines >=22) + `npm ci` + `npm test`, triggered on push and pull_request.
- [testing/high] **Add Worker-level tests for cloud/src/worker.js and server.js** — Cloud sync (Cloudflare Worker + D1 + DO)
  cloud/src/worker.js and cloud/src/server.js implement the sync Worker, D1 push/pull and the Live Durable Object (ARCHITECTURE.md#sync), but no test file touches them — test/sync.test.mjs and live.test.mjs only cover the client-side vscode/sync.js and vscode/live.js. Cloudflare's own Workers/Durable Objects testing docs recommend `createTestHarness` (Node test runner) or `@cloudflare/vitest-pool-workers` to exercise the real Worker, D1 binding and DO RPC/alarm/WebSocket behavior in CI before it ever reaches the always-live main-branch deploy.
  Evidence: cloud/src/worker.js, cloud/src/server.js, cloud/wrangler.jsonc:8-23 - D1 + Durable Object bindings, docs/ARCHITECTURE.md#sync · Source: https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/index
  Next: Add cloud/test/ with @cloudflare/vitest-pool-workers (or wrangler's createTestHarness) covering push/pull LWW merge logic in server.js and the Live DO's WebSocket notify/hibernate path in worker.js; wire a `cloud` test script and run it in the new CI workflow.
- [testing/low] **Enable node:test coverage thresholds for risky paths** — Unit tests (node:test)
  Node's built-in test runner supports `coverage`, `lineCoverage`, `branchCoverage` and `functionCoverage` options directly in `run()`/`--experimental-test-coverage`, but test/run-unit.mjs spawns `node --test` with no coverage flags, so there's no signal when a change (e.g. db.js migrations or sync.js LWW merge) silently loses test coverage.
  Evidence: test/run-unit.mjs:11 - spawnSync node --test without coverage flags · Source: https://github.com/nodejs/node/blob/main/doc/api/test.md
  Next: Add `--experimental-test-coverage --line-coverage=<threshold>` (or pass coverage:true to run()) in test/run-unit.mjs for db.js, sync.js, and tracker.js at minimum, failing CI below threshold.
