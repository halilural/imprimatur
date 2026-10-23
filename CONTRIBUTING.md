# Contributing

Thanks for helping with Imprimatur. Issues and pull requests are welcome; for a larger change,
open an issue first so we can agree on the approach.

## Develop

```bash
npm ci
npm test                    # unit tests (Node 22.13 or later)
npm run test:integration    # VS Code integration tests (xvfb on Linux)
npm run package             # dist/imprimatur-<version>.vsix
```

Code, comments, commit messages, issues and documents are in English. A branch per change;
commit messages follow Conventional Commits (`feat(scope): …`, `fix: …`).

## Release

Every push to `main` runs CI. When `vscode/package.json` has a version that has no `v<version>`
tag yet, the release workflow publishes it. To release:

1. Bump `version` in `vscode/package.json`.
2. Add a `## [x.y.z] - YYYY-MM-DD` section to `vscode/CHANGELOG.md` (the release fails without one).
3. `npm run plugin`: the Claude Code plugin manifest carries the same version.
4. `npm test`, then merge to `main` and push.

The workflow packages the `.vsix` once, attests its build provenance, publishes it to the Visual
Studio Marketplace and Open VSX, and creates the GitHub Release `v<version>` with the `.vsix`.

## Security

Please report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.
