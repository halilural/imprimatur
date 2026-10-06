# #1 · Publish Imprimatur as a VS Code extension (Marketplace + Open VSX)

[#1](https://github.com/halilural/imprimatur/issues/1) · Part of [#2](../2/TODO.md) · moved from groundwork#34 (2026-10-03)

## Status

In progress, plan revised after research (awaiting approval) — 2026-10-06

## To do

- DONE: (C) Separate repo: this one, public, 43 commits of history kept through the `agent-review` → `imprimatur` rename (git-filter-repo 2.47.0), author email is the GitHub noreply address, `#N` in messages became `groundwork#N` — 2026-10-03
- DONE: (C) Own issues and board: this issue, project [Imprimatur](https://github.com/users/halilural/projects/21) — 2026-10-03
- DONE: (C) Research 2026-10-06: 10 active high-star extension repos (GitLens, pretty-ts-errors, drawio, prettier-vscode, vscode-pets, vscode-eslint, spell-checker, Peacock, markdown-mermaid, Error Lens) + official docs; findings in Notes, plan steps R1–R7 below
- 👉 TODO: (K) Approve the revised plan (R1–R7), and CI on GitHub Actions (public repo: free minutes)
- TODO: (C) R1. Manifest: `extensionKind: ["workspace"]` (reads repo files, spawns node; runs in WSL next to the files), `capabilities.untrustedWorkspaces: limited` (no model calls in an untrusted folder) + `virtualWorkspaces: false`, `repository`, `bugs`, `homepage`, `keywords`, `qna`; README: Graph lanes are per task now (#39)
- TODO: (C) R2. Bundle with esbuild into `vscode/dist/extension.js` (one file loads faster than 17), `.vscodeignore` / `files` ship only `dist/` and media
- TODO: (C) R3. `CHANGELOG.md` (Keep a Changelog, dated versions, from git history; the Marketplace shows it as a tab), `SECURITY.md`, `CONTRIBUTING.md`, `.github/dependabot.yml` (npm + github-actions)
- TODO: (C) R4. `.github/workflows/ci.yml`: on PR and push to main: `npm ci`, `npm test`, package the .vsix as an artifact
- TODO: (C) R5. `.github/workflows/release.yml` on tag `v*`: tag must equal `vscode/package.json` version, package once, `vsce publish --oidc` (Marketplace trusted publishing, no PAT: global PATs retire 2026-12-01), `ovsx publish` with the `OVSX_TOKEN` secret, GitHub Release with the .vsix attached
- TODO: (K) R6. Marketplace: create publisher `halilural`, add the trusted publishing policy (repo + release workflow); Open VSX: Eclipse account, Publisher Agreement, token into the repo secret `OVSX_TOKEN`
- TODO: (C) R7. Later: real VS Code host tests (`@vscode/test-cli` + `xvfb-run`), pre-release channel (`--pre-release`)
- TODO: (C) 1. groundwork no longer holds a copy: `modules/imprimatur/` removed there, hooks point to this repo (`~/projects/imprimatur/hooks/baseline.mjs`) until the plugin (step 2)
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

- NOTE: (2026-10-06) Practices seen in the 10 repos: all bundle (esbuild/webpack); 8 run CI on PR; 6 test in a real VS Code host; 3 publish to both Marketplace and Open VSX from a tag-triggered job (prettier-vscode `main.yaml`, GitLens `cd-stable.yml` with a tag = version guard); 3 attach the .vsix to a GitHub Release (vscode-pets); 9 keep a CHANGELOG; 6 set `extensionKind`; 5 declare `capabilities`; 6 activate on `onStartupFinished`; few send telemetry (none planned here)
- NOTE: (2026-10-06) Official docs: global PATs retire 2026-12-01, `vsce publish --oidc` from GitHub Actions (`id-token: write`, Node 22+); versions only major.minor.patch, pre-release via `--pre-release`; icon PNG ≥ 128 px (256 recommended), README images over https, no SVG except badges; verified publisher needs a 6-month-old own domain

- NOTE: Name "Imprimatur" was free on the Marketplace and Open VSX (2026-10-03); close competitors: Claude Code Redline, Redline Mark
