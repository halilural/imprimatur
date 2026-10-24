# Changelog

All notable changes to the Imprimatur extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are 0.x while the
extension is in early development.

## [0.73.0] - 2026-10-24

### Added
- Spaced recall of exercises (#108): each weak point the closing recall finds comes back the next
  day, and a finished exercise is recalled as a whole. Got it moves a recall to 3, 7, 14, 30, then
  60 days, after which it is learned; partly keeps the interval; missed brings it back tomorrow.
  Home shows "N recalls due today"; the Exercises tab has a **Recall today** card; `/exercise`
  asks the due ones first. MCP tool `exercise_review`.
- Links in an exercise are clickable, and a file path in backticks opens in the editor at its line,
  also a path from the home (`~/…`) or an absolute one, since exercises belong to no repo.

### Changed
- Database schema 11: the `exercise_reviews` table.

## [0.72.0] - 2026-10-24

### Added
- Social media tracking (#109), off by default: **Imprimatur: Turn on social media tracking**
  (`{"social": true}` in `.claude/imprimatur.json`) adds a **Social** page under Analysis, next to
  Architecture, Product and Glossary, kept in `docs/SOCIAL.md`: one section per channel with the
  rules read, the post, its status and link, results and what was learned. The MCP document tools
  take the kind `social` where it is on.
- The `/social-post` skill: reads the target platform's rules and docs at the time of writing,
  keeps a dated rules card per channel, writes the post to fit it and checks the counts and facts.
  Where a platform asks for text written by hand (Show HN), it gives the facts and an outline.

### Changed
- Database schema 10: the documents table takes the new kind.

## [0.71.0] - 2026-10-24

### Added
- Exercise mode (#108): `/exercise <topic>` turns any topic into an exercise. The agent asks
  why, your level and your time, runs a short diagnostic, then writes a "can do" goal and 5 to 9
  steps of 10 to 25 minutes (learn, example, predict, do, vary, explain, recall), each with what
  it is for and when it counts as done. It coaches without giving the answer first and closes
  with a recall without notes that keeps your weak points.
- The panel's **Exercises** tab: progress, the step to do now, ticks, skip, a note per step,
  and **split** to ask the agent for smaller steps. Exercises are yours, of no repo or task,
  and stay on this machine.
- MCP tools `exercise_save` and `exercise_get`.

## [0.70.3] - 2026-10-23

### Fixed
- Design document files: a header in another version's wording still marks the file as
  Imprimatur's, and a file synced before is never adopted as hand-written unless asked
  (`npm run docs -- sync`). Two versions running at once had adopted each other's files
  about once a minute, adding a copy of every section each time.

## [0.70.2] - 2026-10-23

### Changed
- `npm run setup` keeps an extension installed from the Marketplace or Open VSX instead of
  installing the checkout's `.vsix` over it; `--vsix` installs the local build anyway.

## [0.70.1] - 2026-10-23

### Changed
- Home shows unread document changes as one line ("N sections changed in the docs since you
  last read", with Mark as read) instead of a list, so a large rewrite no longer pushes Where
  we left off and Waiting on you off the page. The sections stay marked on the Analysis tab.
- README badges: Marketplace and Open VSX version and downloads, release status, license.

## [0.70.0] - 2026-10-23

First release on the Visual Studio Marketplace and Open VSX.

### Changed
- The README is a store page: what Imprimatur does, one illustration per feature, install
  and quick start. The full reference moved to `docs/REFERENCE.md`.
- New illustrations for Waiting on you, Tasks, the living design documents, task analyses
  with /study, and the Agent setup audit.
- The answer-status check's default section word is now "Where we are" (`status.word` in
  `.claude/imprimatur.json` keeps any other).

## [0.69.0] - 2026-10-23

### Added
- A release pipeline: every push to main runs CI; a new version is packaged once, attested,
  published to the Visual Studio Marketplace and Open VSX, and released on GitHub.
- The Marketplace page: README, changelog, license, repository links and keywords.

### Changed
- The last Turkish labels ("Close" / "Full screen" on diagrams, the analysis document title from
  MCP) are in English.

## [0.68.0] - 2026-10-23

### Changed
- The whole interface, the hooks' and MCP tools' messages, the study skill and the
  design documents are in English.

### Added
- A repo can set its own language for model-written text in `.claude/imprimatur.json`
  (`{"lang": "English"}`); at session start the agent is told to write that repo's
  records, documents, comments and commits in it.

## [0.67.1] - 2026-10-23

### Security
- markdown-it 15.0.3 and DOMPurify 3.4.17 (npm audit advisories).

## [0.67.0] - 2026-10-23

### Added
- Optional plugins: `config.json` next to the database names them in `"plugins"`; a plugin
  hears every change to a repo, task, record or document section and can add actions to
  **Imprimatur: Plugin Actions…**.

### Removed
- Device sync and its server are no longer part of this repository.

## [0.66.9] and earlier

Development before the first public release; see the
[git history](https://github.com/halilural/imprimatur/commits/main).
