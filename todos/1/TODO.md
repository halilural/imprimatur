# #1 · Publish Imprimatur as a VS Code extension (Marketplace + Open VSX)

[#1](https://github.com/halilural/imprimatur/issues/1) · Part of [#2](../2/TODO.md) · moved from groundwork#34 (2026-10-03)

## Status

In progress — 2026-10-03

## To do

- DONE: (C) Separate repo: this one, public, 43 commits of history kept through the `agent-review` → `imprimatur` rename (git-filter-repo 2.47.0), author email is the GitHub noreply address, `#N` in messages became `groundwork#N` — 2026-10-03
- DONE: (C) Own issues and board: this issue, project [Imprimatur](https://github.com/users/halilural/projects/21) — 2026-10-03
- 👉 TODO: (C) 1. groundwork no longer holds a copy: `modules/imprimatur/` removed there, hooks point to this repo (`~/projects/imprimatur/hooks/baseline.mjs`) until the plugin (step 2)
- TODO: (C) 2. Claude Code plugin: `.claude-plugin/plugin.json` + `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}/hooks/baseline.mjs md mdx`) + `.claude-plugin/marketplace.json`; install with `/plugin marketplace add halilural/imprimatur` → `/plugin install`; replace the hand-written hook lines on this machine
- TODO: (C) 3. Marketplace page: `package.json` `repository`, `bugs`, `homepage`, `keywords`, `icon` (PNG 128×128, no SVG), `galleryBanner`; README with https screenshots/GIF, "Install: 1) plugin 2) extension"; `CHANGELOG.md`; version 0.x
- TODO: (C) 4. Clean-machine test: empty VS Code profile (`--profile`) + a new repo; install plugin + .vsix, let Claude change a Markdown file, marks + Accept; native Windows paths (outside WSL) as a known limit in the README
- TODO: (K) 5. Marketplace publisher: `marketplace.visualstudio.com/manage` → sign in with a Microsoft account → Create publisher (ID `halilural`)
- TODO: (K) 6. First release: same page → New extension → Visual Studio Code → upload `imprimatur-<version>.vsix` (no PAT needed)
- TODO: (K) 7. Open VSX: Eclipse account (with the GitHub username) → sign in to open-vsx.org with GitHub → Publisher Agreement → Access Token
- TODO: (C) 8. Open VSX: `npx ovsx create-namespace halilural -p <token>` + `npx ovsx publish imprimatur-<version>.vsix -p <token>` (token never stored in the repo)
- TODO: (C) 9. After release: install from both stores, run the manual tests; switch groundwork, dirtywork, interview to the store version

## Questions

## Decisions

- DECISION: (2026-10-03) Separate public repo with its own issues and board (owner: "projesi, issue'ları da ayrı olsun"); public because the .vsix code is readable anyway, and the hook reads Claude session transcripts, so open source builds trust. MIT
- DECISION: (2026-10-03) This repo is written in English (open source)

## Notes

- NOTE: Name "Imprimatur" was free on the Marketplace and Open VSX (2026-10-03); close competitors: Claude Code Redline, Redline Mark
