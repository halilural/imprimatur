# Changelog

All notable changes to the Imprimatur extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are 0.x while the
extension is in early development.

## [0.89.3] - 2026-11-03

### Security
- The first time a repo's data folder is used, any link in it is removed (once; a `.no-links`
  note marks it done). 0.89.0 and 0.89.1 moved old folders whole, so a link could have come
  along, and a hook could have written through it.

## [0.89.2] - 2026-11-03

### Security
- The move of an old `.claude/imprimatur/` folder walks it file by file: a link is never moved or
  followed at any depth, and a target that is a link is never read or written (0.89.1 checked the
  top level only, and moved folders whole). A planted link could otherwise have made a later hook
  write through it.

## [0.89.1] - 2026-11-03

### Security
- The move of an old `.claude/imprimatur/` folder (#126) follows no link: when `.claude` or
  `.claude/imprimatur` is a link, or its real path is outside the repo, nothing is moved; links
  inside it are left alone; `MOVED.md` and `.gitignore` are written as new plain files. A repo
  could otherwise point the folder at any of the user's folders (`~/.ssh`) and the move would
  carry its files away.

## [0.89.0] - 2026-11-03

### Changed
- Imprimatur's per-repo data lives outside the repo, next to the database:
  `~/.local/share/imprimatur/repos/<repo>-<id>/` (#126). Nothing changes in the repo on a tool
  call any more, nothing can be committed, and VS Code sees no file events from Imprimatur in the
  workspace. The first run moves an old `.claude/imprimatur/` folder there (a `MOVED.md` is left
  in its place; the folder can be deleted); what an older release still writes there is taken
  in once a day. On copies of three real repos the panel showed the same edits and asks before
  and after the move.
- Test runs keep their temporary files in a folder of their own and remove it at the end; they
  used to leave about 500 folders in `/tmp` per run.

## [0.88.0] - 2026-11-03

### Added
- One Imprimatur version per machine (#123). With the Claude Code plugin installed, the status
  line runs the plugin's own copy (the code the hooks and the MCP server run), and it shows
  `⚠ 0.73.0 ≠ extension 0.75.0` when its version differs from the extension's. At start the
  extension warns when the plugin is another version, with an "Update the plugin" button.

## [0.87.0] - 2026-11-03

### Added
- `.claude/imprimatur/` no longer grows without end (#122). Archive days older than
  `imprimatur.archive.keepDays` (90) go, then the oldest past `imprimatur.archive.maxMB` (25 MB;
  the newest day always stays). Document backups keep each file's newest copy and at most 5. A
  waiting log quiet for 30 days that still has open asks is archived whole and kept with only
  what those asks need; it is cut only when the cut log gives the very same open asks. The
  leftover `unread.json` is removed.

## [0.86.0] - 2026-11-03

### Changed
- The version history takes less room with nothing lost (#121). Once a day the extension drops
  only what another stored value already says (an unchanged create, a repeated "before", a
  section's latest body that is its body now) and reads it back when a history is shown. Before
  the first run it writes a full copy of the database next to it
  (`imprimatur-backup-<date>.db`). On a copy of a real database the version tables went from
  26.2 MB to 16.2 MB, and every history read back exactly the same.

## [0.85.0] - 2026-11-03

### Changed
- MCP answers are smaller for the agent (#120). `search` answers with an index: id, task, kind,
  status, owner and title (cut to 160 chars), 8 hits, `more: true` when there are more;
  `full: true` gives whole records with bodies. `task_get` gives each body's first line and only
  the fields an agent acts on; `full: true` gives everything. A typical search went from 17–35 KB
  to under 2 KB.

## [0.84.0] - 2026-11-03

### Added
- MCP tool profiles (#119): `core` (7 tools, ~1.7k tokens for the model), `standard` (10, ~2.7k)
  and `all` (15, ~4.6k, the default). Set `IMPRIMATUR_TOOLS`, or `"mcp": {"tools": …}` in the
  repo's `.claude/imprimatur.json` or in `config.json`; profiles, groups and tool names combine
  (`core,exercise`). `core` and `standard` also leave out the output schemas: core's tool list
  is 7.1 KB instead of 13.7 KB.

## [0.83.0] - 2026-11-03

### Security
- Keys and tokens leave `config.json` for `secrets.json` (mode 0600, the same folder) (#124).
  The move happens when the extension starts and in `npm run setup`, only for the keys whose
  reader reads the new file: the Jira token, and the keys a plugin names (the private sync,
  cards and GitLab plugins from their release of today). An older plugin keeps its key where it
  was and keeps working.
- `npm run setup` tells Claude Code not to read or edit `secrets.json` (`permissions.deny`), so an
  agent looking at the settings does not pull a key into its context.

## [0.82.0] - 2026-11-03

### Changed
- One Imprimatur hook process per event instead of one per job (#118). A Bash or Edit call now
  starts two node processes (before and after the tool) instead of five, and costs about half
  the CPU (140 ms instead of 294 ms for a Bash call). The tool-call rows on Agent changes stay.
  `npm run setup` swaps the old hook entries for the new ones; sessions already open keep the old
  ones until they restart, and those still work.

## [0.81.0] - 2026-11-03

### Fixed
- The database no longer grows without bound (#117). The WAL is cut back to 4 MB at each
  checkpoint, and once a day the extension checkpoints it to zero, refreshes SQLite's statistics
  and, when more than 5% of the file is free pages, runs a VACUUM in a worker thread (VS Code
  does not freeze). On a copy of a real database: 88.6 MB → 65.1 MB and the WAL 27.8 MB → 0,
  in under half a second.

## [0.80.0] - 2026-11-03

### Changed
- Panel updates go as the lines that changed, not the whole page (#115, step 2). The page keeps
  its copy of the last page and applies the changed lines to it; if it ever misses a version, it
  asks for the whole page again. A new tool call on Agent changes was about 118 KB of the 587 KB
  page and is now a few KB: rows keep their ids when a new one comes, and the hover previews are
  one line per row.

## [0.79.0] - 2026-11-03

### Changed
- The Agent changes (Edits) tab draws the newest 200 rows, with "Show 500 more" and "Show all"
  under them (#115, step 3). 1,853 rows were 5.4 MB in one page; the page now stays near 600 KB
  however many rows there are. Search and the kind filters cover the rows drawn.

## [0.78.0] - 2026-11-03

### Changed
- The panel is built only when something it shows may have changed (#115, step 1). Before each
  refresh a cheap stamp is taken: the view, the database's change counter, the files under
  `.claude/imprimatur/` and the files under review (size and time, nothing read), open documents'
  versions and the minute (for "3 min ago"). An equal stamp skips the build, 30-180 ms before,
  about 1.5 ms now. The Social and Task analyses tabs read other files and are built as before.

## [0.77.1] - 2026-11-03

### Fixed
- Imprimatur's data folder (`.claude/imprimatur/`: edit copies, history, logs) hides itself from
  git with a `.gitignore` of `*` inside it. It used to be committed and to show as changed on
  every tool call unless your own ignore rules covered it. The repo's `.gitignore` is not touched.
  Files already committed stay tracked: run `git rm -r --cached .claude/imprimatur` once in that
  repo and commit.

## [0.77.0] - 2026-11-03

### Fixed
- Hook writes no longer redraw everything three times each. A burst of 20 tool calls built the
  panel 146 times and now builds it once or twice (#114):
  - only edit copies and history redraw the editors, lenses, preview and panel, once 300 ms after
    the last write (at least every 2 s while writes keep coming);
  - activity, calls and descriptions take the same light path as the waiting log;
  - the hooks' own bookkeeping (`pending/`, `process.json`, `open-edits.json`, `archive/`,
    `docs-backup/`) and the extension's own state files redraw nothing.
- While the side bar's launcher is hidden, it counts only its badge; the item list and the edit
  count catch up when it shows (at least once a minute, so the status line's count stays fresh).

## [0.76.0] - 2026-11-03

### Added
- `npm run setup` allows Imprimatur's MCP server in `~/.claude/settings.json`
  (`mcp__imprimatur`, or `mcp__plugin_imprimatur_imprimatur` with the plugin) and prints the line
  it adds; `--no-allow` skips it. In auto mode a call without the rule waited 5.5 s on average
  for the permission check, against 5 to 108 ms for the call (#113).
- The setup audit warns when the repo's effective settings have no allow rule for the server
  (`IMP-MCP-001`). A deny or ask rule set on purpose is left alone.

## [0.75.0] - 2026-11-02

### Added
- Home in the side bar lists what waits on you, item by item: Questions, To-dos, Manual tests,
  Turn-end asks, and On done tasks (asks a finished task left open), each with its count; a
  record opens its page.
- The running version next to the side bar's Imprimatur title.

### Fixed
- The launcher badge, the status bar's Agent Graph count and the panel's Home tab count this
  repo's asks only, even with every repo shown; they used to add up every repo's.

## [0.74.0] - 2026-11-02

### Removed
- Unread tracking of the design documents (#111): the Home "Unread" strip, the unread count on
  task rows and pages, the per-section Unread marks and every "Mark as read" button, and the
  unread part of the status line. It made the panes sluggish: with no read marks, every render
  parsed the repo's whole document history. The `section_reads` table stays so older databases
  open unchanged; nothing reads or writes it.

### Changed
- Task rows and the status line count agent edits waiting to be accepted ("N to accept",
  "N edits to accept") instead of unread sections.

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
