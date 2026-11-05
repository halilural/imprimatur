# Changelog

All notable changes to the Imprimatur extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are 0.x while the
extension is in early development.

## [0.110.1] - 2026-11-05

### Security
- Naming a "command hook" no longer compiles hook matchers as regular expressions: a repo's
  settings could hold a pattern that hangs the extension host. Matchers are read as exact
  names split on "|" or as a prefix ending in ".*"; anything else may fit (#145).

## [0.110.0] - 2026-11-05

### Added
- What each hook costs (#145). Agent Setup's "Hooks: what they added and how long they took"
  rows now start with each hook's total time in the session, slowest first, then its runs,
  time per run and the text it adds. Two copies of one plugin's hook (installed at two scopes)
  show as two rows, each saying how many copies run and from where. A hook that Claude Code
  logged only as "command hook" is named from the hooks your settings and enabled plugins
  define for that event and tool.

## [0.109.0] - 2026-11-05

### Added
- First run (#81): a Get Started walkthrough that opens once. It checks the install, shows
  the agent's first edit, Agent Setup with the audit, and tasks and records.
- Imprimatur: Check Setup looks for the Claude Code CLI, the hooks, the MCP server (from the
  plugin or `npm run setup`) and the database, then says what is missing and how to fix it.
  When nothing is missing, it says so. A missing part also comes first in Agent Setup's
  Checklist, with its fix.
- The empty states guide you: no database (run Check Setup or reload), no folder open (open
  the repo you work on), and no agent edits yet (ask Claude Code to edit a Markdown file).

## [0.108.0] - 2026-11-05

### Added
- Fix it also dismisses (#156). Next to its edits, Claude lists the findings that are wrong for
  their file, intended here, or caused by a third-party plugin's file, each with one line of
  why. The confirmation shows them, and Apply dismisses them with that reason (kept in the
  record). A finding no edit can fix (such as becoming a verified Marketplace publisher)
  shows as "needs you" and stays open.

## [0.107.1] - 2026-11-05

### Fixed
- Fix it's background run starts with hooks off, so the user's hooks (Imprimatur's own among
  them) no longer add their context and closing sections to the answer. The SOURCE.txt line
  of a taken-in skill uses the review's SUMMARY line, not the answer's first line (#156).

## [0.107.0] - 2026-11-05

### Changed
- Fix it's background Claude only reads (#156). For a finding it proposes the edits, and
  Imprimatur opens a diff for each file and applies them only when you say Apply (an edit is
  left out when its file is not one of the fix's files, its old text is not found exactly
  once, or the file changed meanwhile). For a skill changed upstream it reviews the new
  version and ends with a verdict; on SAFE, Imprimatur copies the files in and records the
  commit in SOURCE.txt, so the row leaves the checklist. This is needed because Claude Code
  does not let an unattended agent edit anything under ~/.claude.
- A click on a checklist row of a skill opens the skill instead of the browser; the compare
  page is on the row's menu. Only one Fix it runs at a time.

## [0.106.2] - 2026-11-04

### Security
- Fix it passes each permission rule as its own argument, and does not run when a file it would
  edit has characters with a meaning in rule syntax (`, ( ) * ? [ ] { }` or spaces) in its path;
  it copies the prompt instead (#156).

## [0.106.1] - 2026-11-04

### Security
- Fix it asks before it runs, listing the only files Claude may edit (#156). The background run
  loads only your user settings (a repo's hooks and permissions do not apply) and no MCP
  servers, runs no commands, and can edit only the finding's files, or a skill's own folder for
  a skill update. Imprimatur downloads a skill's new version itself (GET requests, paths checked,
  size capped), so the agent needs no shell. In an untrusted folder, Fix it copies the prompt
  instead of running an agent. After a fix, Imprimatur runs the audit again itself.

## [0.106.0] - 2026-11-04

### Changed
- Fix it runs Claude Code's CLI in the background (`claude -p`) instead of opening a chat with
  the prompt (#156). A notification shows while it works and can cancel it; at the end it shows
  the agent's first line, with Show answer (the full answer in the "Imprimatur Fix it" output)
  and Review changes. The run may only read and edit files, and for a skill update also call
  `gh api`; Bash, WebFetch and WebSearch are shut for it. Its edits are tracked for review.
  Without the CLI, Fix it opens the Claude Code panel as before, else copies the prompt.

## [0.105.1] - 2026-11-04

### Security
- Fix it's prompts keep everything that comes from a record, an audit or a file in a quoted
  data block, each field on one line, with a line telling the agent not to follow instructions
  inside it. A skill update prompt is only made when the SOURCE.txt repo, folder and commits
  have a plain shape; otherwise the row has no Fix it (#156).

## [0.105.0] - 2026-11-04

### Added
- Fix it (#156): a button on Agent Setup's checklist rows and on open recommendations. It opens
  a new Claude Code session with the fix written as its prompt, for you to read and send:
  what to fix, where, and the audit's details. For a skill changed upstream, the prompt says to
  review the change for prompt injection before copying it in and updating SOURCE.txt. The
  recommendations row fixes all of them in one session. A secret in a file gets no Fix it.
  Without the Claude Code extension, the prompt goes to the clipboard.

## [0.104.0] - 2026-11-04

### Fixed
- The setup audit reports only what you can fix (#155). Findings in an installed plugin's files
  or a marketplace catalog, and in skills synced from claude.ai, are no longer recorded: an
  update or claude.ai overwrites those files. Their open recommendations are dropped as "not
  yours to fix", not counted as applied. An outdated plugin still shows in the checklist.

## [0.103.0] - 2026-11-04

### Added
- A Checklist at the top of Agent Setup (#142): what needs doing, each item with what to do and
  an action. It lists plugins behind their marketplace (Update), skills changed upstream (review
  the change), health problems (open the file at the line) and open recommendations. The
  launcher has a Setup checklist row with the count. The baseline, AGENTS.md shape, doc standard
  and lint items join when #141, #133 and #129–#132 land.

## [0.102.1] - 2026-11-04

### Fixed
- An Agent Setup row that is not a file in the repo (an installed plugin, a session row, auto
  memory) no longer says "Not committed yet." in its tooltip.

## [0.102.0] - 2026-11-04

### Added
- Version history for plugins and hand-installed skills (#140). Each row in Agent Setup lists
  the versions it had, with the day each was first seen (e.g. "versions: 4.10.0 (2026-09-30) →
  5.3.3 (2026-11-04)"). There is no revert: Claude Code has no command that installs an older
  version, and Imprimatur does not rewrite Claude Code's own files.

## [0.101.0] - 2026-11-04

### Added
- Hand-installed skills are checked against their source (#140). Once a day, the newest commit
  that touches each skill's folder in its GitHub repo is read through `gh`. A newer one than the
  installed commit shows "upstream changed <date>" and a Show Upstream Changes button, which
  opens the GitHub compare page. Updating stays a deliberate copy, because a skill's text goes
  straight into the agent's context.
- A plugin fetched from its own repo is behind when the marketplace pins another commit, and one
  kept in the marketplace under a commit "version" is behind when its files differ from the
  install. Both get "update available" and the Update Plugin button.

## [0.100.0] - 2026-11-04

### Added
- "#140" in Quick Open (Ctrl+P) or Go to Symbol in Workspace (Ctrl+T) lists that GitHub issue
  from Imprimatur's tasks (#154), and words find issues by title. Picking one opens the issue
  page of the GitHub Pull Requests extension, or the browser without it, as the tab in front;
  no file opens and the cursor stays put (0.100.3).

## [0.99.1] - 2026-11-04

### Changed
- The `issues` skill ends every closing comment, and every shipped slice's comment, with
  **How to try it**: numbered steps (setup, do, see, an edge case, undo) that someone who did not
  build the change can follow. The same steps go on the task as a `test` record for the user.

## [0.99.0] - 2026-11-04

### Added
- A plugin behind the version its marketplace offers says "update available" in Agent Setup
  (#140), and its row gets an Update Plugin button. The button refreshes the marketplace and runs
  Claude Code's own `claude plugin update` at the scope the plugin was installed, in its repo
  for project scope. Each plugin row also says when its marketplace was last refreshed.

## [0.98.0] - 2026-11-04

### Added
- Agent Setup shows which version of each MCP server runs (#139): a pinned package version or
  image tag, "unpinned, newest at each start" for a runner without one, a remote server's host,
  or a local file. The summary counts the unpinned ones.
- Data sources (#139): memory systems connected in the last session (Nook, Notion and the like)
  and other memory systems' folders on this machine (mem0, claude-mem, context-mode). They are
  listed with their last change, never read, because what they return reaches the agent unvetted.

## [0.97.0] - 2026-11-04

### Added
- Agent Setup shows what each installed plugin brings (#139): its hooks, MCP and LSP servers,
  skills, agents and commands, read from its manifest or, for a plugin without one, its
  marketplace entry.
- A hand-installed skill shows where it came from: the source and commit in its SOURCE.txt, or
  the folder a symlinked skill points to.
- A Claude settings file's summary adds the permission mode, effort, output style, sandbox,
  env (names only, never values) and the auto-mode rule count.

## [0.96.0] - 2026-11-04

### Added
- An `issues` skill (#153): the agent opens, splits, triages, keeps in step and closes issues
  the same way every time. Each issue gets a category and priority label, a board Status and
  sprint, sub-issue and blocked-by links, and a brief with acceptance criteria. Its Imprimatur
  task holds the detail. Built on mattpocock/skills, github/awesome-copilot and CCPM (MIT;
  notices in `skills/issues/NOTICE.md`).

## [0.95.0] - 2026-11-04

### Changed
- The panel takes the board look on dark and light themes (#148): a near-black board palette
  (light variant on light themes), cards with a soft gradient and inner highlight, rounder
  corners, and a translucent app bar. High-contrast themes keep VS Code's colours.

## [0.94.0] - 2026-11-04

### Added
- `/imprimatur-stats` shows the repo's scoreboard as ASCII bars: the last 7 days next to the
  7 before them (#146). It covers tasks finished and opened, decisions, records, agent edits
  marked, turn-end asks, what is waiting on you, the median time to answer, and the last
  session's hooks. `--days N` changes the period.

## [0.93.0] - 2026-11-04

### Added
- Agent setup shows what the repo's last Claude Code session was given, read from its
  transcript (#139):
  - the instruction files it loaded;
  - each hook, with how often it ran, how long it took and how much text it added;
  - each MCP server's instructions;
  - tools by server, including servers that failed to connect or need sign-in;
  - the skills and agents it was told about;
  - the model and the mode.

## [0.92.0] - 2026-11-04

### Added
- Agent setup lists installed Claude Code plugins with their version, scope (every repo,
  or this project) and where they came from. A plugin installed both for every repo and
  for this one says so, because its hooks may run twice (#139).
- Agent setup lists the skills synced from claude.ai, with their source and last update.

## [0.91.1] - 2026-11-04

### Fixed
- A section's chapter is now one of the fields synced between machines. Before this,
  the other machine dropped it and listed every section under "Unsorted".

## [0.91.0] - 2026-11-04

### Changed
- ARCHITECTURE.md and PRODUCT.md have fixed chapters, the same in every repo (#129).
  Architecture: Goals, Context and scope, Solution strategy, Building blocks, Deployment,
  Crosscutting concepts, Decisions, Risks and technical debt. Product: Problem, Users,
  Goals, Non-goals, Features, Metrics. Every chapter is shown, and an empty one says so.
  Sections are numbered under their chapter, and sections not yet placed are listed
  under "Unsorted". `doc_section_upsert` takes a `chapter`.

## [0.90.0] - 2026-11-03

### Changed
- The panel parses each "waiting on you" log once per version of the file and reuses it
  on later draws: a refresh in a repo with many turn-end asks no longer re-reads every
  log (41 ms → 5 ms per call on a 1,245-step repo; a draw makes two or three calls).

## [0.89.4] - 2026-11-03

### Security
- The one-time link sweep of a data folder (0.89.3) is marked next to the folder
  (`<folder>.swept`), not inside it, and a `.no-links` file in a repo's old folder is never
  moved in: a repo could otherwise bring the marker along and skip the sweep.

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
