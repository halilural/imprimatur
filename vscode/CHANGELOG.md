# Changelog

All notable changes to the Imprimatur extension. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are 0.x while the
extension is in early development.

## [0.183.1] - 2026-11-12

### Security
- `llms.txt` no longer follows symbolic links among the documents, and reads only files whose real path is inside the repo: a link planted in docs/ cannot copy another file's first lines into it. Found by the security review of 0.183.0.

## [0.183.0] - 2026-11-12

### Added
- `llms.txt` at the repo's root (#216): the documents export writes an index of Imprimatur's documents in the llmstxt.org form (project, capabilities, ADRs, glossary, out of scope, docs/agents, wiki), each with a link and a one-line description, so Cursor, Codex and other agents find them. It follows the documents as they come and go; a hand-written `llms.txt` is left alone.

## [0.182.0] - 2026-11-12

### Added
- Where did this line come from? (#215): right click a line in the editor. Imprimatur names the recorded agent edit that wrote it as it reads now (the newest whose lines still read there), with its time, tool, session, prompt and ticket, and opens the ticket. Works for the files the review records (Markdown by default; the `exts` setting adds others); for others it says so.

## [0.181.0] - 2026-11-12

### Added
- Tokens per ticket on the task page (#214): from Claude Code's transcripts of the repo, each assistant message's usage counted once and given to the ticket its git branch names, else the ticket the session last named (an Imprimatur tool call or a `git switch` to a ticket branch). Shown as tokens written, read from cache and output, and the sessions, marked as an estimate. Transcripts are read incrementally (about 1.4 s the first time on a 255 MB folder, milliseconds after). No price: on a subscription tokens have none.

## [0.180.0] - 2026-11-12

### Added
- Agent rule files that repeat or contradict each other (#213): CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules`, Copilot's instructions, `.claude/rules` and `docs/agents` are read together. Agent Setup's checklist shows the rules repeated in several files and the pairs that share most words but differ in a negation or a number, both lines named. Rules under a "Don't" heading or a "Never:" label count as nots; headings, imports, tables and Imprimatur's generated rules are left out. No model call.

## [0.179.0] - 2026-11-12

### Added
- Wasted edits in Agent Setup (#212): over the last 7 days, the edits the agent replaced itself in the same session (their lines are gone) and the rewrite loops (a file changed three or more times in a row in one session, appends not counted), with an estimated token cost (10 per written line) and the files that cost the most. No model call.

## [0.178.0] - 2026-11-12

### Added
- `record_get` MCP tool (#136): one record by its id, whole (body, links, its task's key, and the possibly-stale mark of #211), without loading the rest of its task. `search` and `task_get` point to it when they cut bodies. Measured on this repo: reading one record of RECS (39 records) costs 2.3k characters instead of 71k with `task_get full`, one of ADR (62 records) 1.7k instead of 76k.

## [0.177.0] - 2026-11-12

### Added
- File context for the agent (#137): before the first edit of a file in a session, the agent hears the records that name it (`links.files`), ADRs and decisions first, at most five, each marked "possibly stale" when the file changed since it was written. Once per file per session; no new hook or process (it runs in the existing PreToolUse step). Setting: `fileContext` in `.claude/imprimatur.json`'s process checks.

## [0.176.1] - 2026-11-12

### Fixed
- Find in the side bar list finds a task by its key: rows read "#157 · title" (VS Code's find matches the label only, and the key was in the grey description).
- The search button now does open Home's and Tasks' groups before the find: the rows are kept as the same objects, which VS Code needs to open a group from code.

## [0.176.0] - 2026-11-12

### Changed
- The search button of the Imprimatur side bar now finds in the list itself: it opens Home's and Tasks' groups and VS Code's find box inside the view, so typing filters the to-dos, questions and tasks right there. Search and Ask (records and documents, at the top of the window) moved to the view's "…" menu.

## [0.175.3] - 2026-11-12

### Changed
- **Ask Claude to handle this** (and the stale-documents list's "Ask Claude to check it") types the request into the Claude Code chat you have open, for you to send, instead of opening a new chat tab. A new tab opens only when no chat can be focused.

## [0.175.2] - 2026-11-12

### Changed
- **Add to Claude chat as reference** pastes the short reference ("Imprimatur #157, record 9535: …") into the open Claude Code chat's input, instead of a temporary file's path; no file is written and no preview tab opens. The reference also stays on the clipboard.

## [0.175.1] - 2026-11-12

### Fixed
- Buckets of records (RECS, ADR, PDR and the like) are no longer listed as tasks, in the side bar, the panel's Tasks page or Home's board: their records show in Agent Setup → Recommendations and Docs → ADRs.

## [0.175.0] - 2026-11-12

### Added
- Possibly stale documents (#211): an ADR, a decision or a document section tied to files is flagged when one of those files changed in a commit after it was written. The panel shows a warning over its text; Agent Setup's checklist has a "Documents: N possibly stale" row whose list asks Claude to check one against the code, or marks one (or all) reviewed; and the agent sees the flag when it reads the part over MCP (`task_get`, `doc_get`). Editing the part, or marking it reviewed, clears the flag until its code changes again. Version files, changelogs, lockfiles and tests do not count. No model call.

## [0.174.3] - 2026-11-12

### Changed
- Home in the side bar groups what waits on you by what you do, not by where it came from: **Questions for you**, **Your to-dos**, **Manual tests**. A turn-end ask goes under the first two; the separate "Turn-end asks" row is gone. Tasks' tooltip says they are the project's work items.

## [0.174.2] - 2026-11-12

### Security
- The reference files for Claude chat go into a private folder per run (unpredictable name, owner-only) and are always created new, never written through an existing file or symlink. 0.174.1 wrote them to a fixed shared folder under /tmp.

## [0.174.1] - 2026-11-12

### Fixed
- The right-click entry is now **Add to Claude chat as reference** and does what it says: the row (its reference and the record's text) is added to the open Claude Code chat as an @-mention. It is still copied too.

## [0.174.0] - 2026-11-12

### Added
- Right click a row under Home or Tasks in the Imprimatur side bar: **Ask Claude to handle this** opens a new Claude Code chat with the request typed in; **Copy reference for Claude** copies "Imprimatur #157, record 9535: …" and focuses Claude Code's input, to paste into the chat you are in.

### Fixed
- Turn-end asks keep only what you have to do: a question the agent asked ("…?") now closes when you answer it in the chat; before, every ask was saved as something to check and stayed open.

## [0.173.1] - 2026-11-12

### Fixed
- A bucket of records (RECS, ADR, PDR and the like: a key that is not "#58" or "PROJ-12") no longer shows a spec and its gates: it opens on its records.

## [0.173.0] - 2026-11-12

### Changed
- The agent writes a task's spec by itself when it starts a task that has none, and passes the gates (stories, design, analysis, tickets) itself. The task page shows the gates as status only: the Approve and Confirm buttons and the "agent-recorded" tag are gone. The rules file, the to-spec skill and the MCP instructions say the same.

## [0.172.1] - 2026-11-12

### Fixed
- The panel no longer reloads on every database change (any Claude session's hook writes one): a page that reads the same is left as it is, so a document keeps its scroll and its diagrams are not drawn again.

## [0.172.0] - 2026-11-12

### Added
- The side bar's Tasks row opens into Active, Open and Done, each listing its tasks (as the panel's Tasks page does); a task opens its page in the panel, its summary in the tooltip.

### Fixed
- Mermaid blocks in the panel are drawn as diagrams again (since 0.159.0 they showed as source); one that fails shows the error over its source.
- Generated ADR files and wiki pages pass markdownlint: blank lines around headings and lists, headings under the file's title start at h2, no trailing spaces.

## [0.171.0] - 2026-11-12

### Changed
- The Imprimatur panel no longer has a navigation of its own. The side bar's Imprimatur view now holds it in VS Code's own tree: Home (with what waits on you), Tasks, Docs and its documents (Project, Capabilities, ADRs, Glossary, Out of scope, Wiki), Agent changes, Setup checklist, Exercises, Meetings and Social (where it is on). The panel's top bar, side menu and document pills are gone. Search and Ask is the view's search button, or `/` in the panel. The panel's tab title names where it is, for example "Docs · Glossary · imprimatur". Picking an area in the tree opens it at its top.

## [0.170.0] - 2026-11-12

### Changed
- The Imprimatur panel reads better. Docs and Social show each section in full in one readable column, with "On this page" on the right. There is no second copy of the section list and no "More" fold. Tables have borders and headers, code is in the text color and wraps, and "Edit" sits beside a section's heading on hover. Tasks, Edits and Setup are one bordered list with dividers, and Edits shows its count as a badge. Home's cards have borders and two-line notes. The side menu shows its `g` shortcuts only in tooltips. Body text uses the editor's text color, and an exercise step's number stays on its checkbox line.

## [0.169.1] - 2026-11-11

### Fixed
- The re-ask check counts only lines that start with 👉 as asks: a reply that mentions the sign in a sentence is not sent back (#210).

## [0.169.0] - 2026-11-11

### Added
- An approved list is done, not asked about again (#210): Imprimatur's rules file says that after "do all", "go on", "yes", "hepsini yap" or "devam" the agent does every item it covers, commits, pushes and deletions included, and asks only a new decision of the user's, once. When the user's last message approves and the reply still ends with 👉 asks, the turn-end check sends the agent back once to do the work (`{"process": {"reask": false}}` turns it off).

## [0.168.0] - 2026-11-11

### Added
- Evidence before claims (#209): Imprimatur's rules file says an agent states that something passes, works or is fixed only with a command's output from the same turn, and that another agent's "success" is a claim to check. It carries obra/superpowers' `verification-before-completion` and Matt Pocock's `diagnosing-bugs`. A turn-end reply that claims tests pass, a fix or a verification in a turn that ran no command is pointed out to you (never blocks; `{"process": {"evidence": false}}` turns it off).

## [0.167.0] - 2026-11-11

### Changed
- Imprimatur's rules live in their own file, `.claude/rules/imprimatur.md`, generated and rewritten at each session start in a repo with process settings: a rule change in a release reaches every repo, and the repo's own `AGENTS.md` and rules files are no longer written. Remove the header to take the file over; it is then left alone (#208).
- New repos get `AGENTS.md` and `CLAUDE.md` without Imprimatur's rules in them, and no `.claude/rules/docs.md` (#208).

### Added
- Agent setup finds Imprimatur's rule lines an older release copied into `AGENTS.md`, `CLAUDE.md` or `.claude/rules/docs.md` (IMP-DOC-008), and a skill name that comes from two places, the repo's, the user's, an Imprimatur link or claude.ai's (IMP-SETUP-001). Plugin skills are namespaced and do not clash (#208).
- `npm run setup` removes its links to skills Imprimatur no longer ships (#208).

## [0.166.2] - 2026-11-11

### Fixed
- The design-first check reads Jira-keyed branches (`dev/LATD-14087-…`) as well as `feat/123-…`: code on such a branch before the task has a spec or an ADR gets the warning (#207).
- An agent that starts a task itself (a pasted Jira screenshot, "start this") is told how to write the spec: `/to-spec` is user-invoked, so the warning, the MCP instructions and the docs rule say to follow its gates with `doc_section_upsert` (kind `spec`) and give the skill's path (#207).

## [0.166.1] - 2026-11-10

### Security
- The hand-written documents list (search, Agent setup) skips symlinks and files whose real path leaves the repo: a link named like a document could have put any file of the machine into the search and the model's prompt (#206).

## [0.166.0] - 2026-11-10

### Added
- Search finds inside the repo's hand-written documents, kept or not yet adopted, where they are: Search and Ask shows them with a file icon and opens the file at the line; the MCP `search` tool returns them as `files` (path, line). Nothing is copied into the database (#206).
- `docs.keep` entries take a `when` (`{"path": "docs/runbooks/", "when": "an incident"}`): `docs/agents/domain.md`, which Pocock's skills read before exploring, lists the kept documents with it, to be read only when needed (#206).

## [0.165.0] - 2026-11-10

### Added
- `{"docs": {"keep": ["docs/mails/", "docs/jira.md"]}}` in `.claude/imprimatur.json` keeps folders and files out of the hand-written documents list, new files in them too. `/adopt-docs` handles large repos folder by folder: archives kept in one step, per-task folders linked from their task (#205).

## [0.164.0] - 2026-11-10

### Added
- Agent setup's audit lists the repo's hand-written documents (Markdown at the root and under `docs/` that Imprimatur did not generate; README, CHANGELOG, AGENTS and CLAUDE left out) as IMP-DOC-007 findings; dismiss one to keep the file (#205).
- `/adopt-docs` sorts them with you, one file at a time: a reference kept and linked, a capability written from the code with the file as a source, terms and decisions extracted into the glossary and ADRs, or deleted when the code shows it stale (#205).

## [0.163.2] - 2026-11-10

### Fixed
- `npm run setup` updates an installed Imprimatur plugin that is on another version than the checkout (`claude plugin marketplace update` + `claude plugin update`); before, a machine on the plugin stayed on the version it first installed (#204).

## [0.163.1] - 2026-11-10

### Fixed
- `npm run docs -- sync` no longer calls a document "in sync" when it has no file: one moved to Pocock's model says "no file (nothing current to write)" (#203).

## [0.163.0] - 2026-11-10

### Changed
- Once a repo's Architecture and Product moved to Pocock's model, the generated MADR files under `docs/decisions/` go: the ADRs are in `docs/adr/` (#203). A hand-written file there stays.

## [0.162.0] - 2026-11-10

### Changed
- `/study` keeps its study note in the task's spec (Further Notes, section `study`); a note in an old analysis still reads (#203).
- The setup audit no longer asks to link every ADR to a section (IMP-DOC-003) or to fill Architecture chapters and C4 views (IMP-DOC-004): both fired on every repo after the move to Pocock's model. The sequence-diagram rule (IMP-DOC-005) checks the project page, capabilities, specs and maps.
- Session start no longer says how many ADRs no section links.

### Removed
- Task analyses for good (#203): the "Take Task Analyses from Past Sessions" command, `npm run analysis`, and the code behind them. The MCP tools refuse to write an analysis and point to the spec; an old one still reads.

## [0.161.0] - 2026-11-10

### Changed
- Imprimatur speaks Matt Pocock's names everywhere (#186). Before code on an issue branch, the agent is asked for a spec (`/to-spec`) or an ADR, no longer an ADR or PDR. An ADR stands alone: the agent is told only when a section it feeds falls behind it, never to update an Architecture or Product document. The MCP server's instructions, the docs rule (`.claude/rules/docs.md`, and the one written to new repos), AGENTS.md and the README describe the project page, capabilities, specs, ADRs, glossary and out-of-scope.

### Removed
- The background runs that wrote a repo's design documents and past analyses with `claude -p` at session start, and the hook that took plan and note files into a task's analysis: specs are written with `/to-spec` now.

## [0.160.0] - 2026-11-10

### Changed
- Every repo's old documents moved to Matt Pocock's model (#185): Architecture and Product became the small project page (docs/PROJECT.md), capabilities (docs/capabilities/), ADRs (docs/adr/) and out-of-scope notes (.out-of-scope/); a target state of an open issue went into that task's spec; task analyses were retired. A backup of the database was taken first, and the old sections are marked superseded, not deleted.
- A document whose every section is superseded loses the file Imprimatur generated for it (docs/ARCHITECTURE.md, docs/PRODUCT.md); a hand-written file is never touched.

## [0.159.0] - 2026-11-10

### Removed
- The old panel is gone (#202): the new one is the only Imprimatur panel. Every command that opened the old one (Agent Change Graph, Home, Tasks, Architecture, Product, Glossary, Meetings, Social) opens the new panel at the matching place. Gone with it: answering and ticking records in the panel, the 30-day agent stats, New task, the full call timeline with turn ticks, and the automatic history scan on first open.

### Changed
- The new panel redraws by itself when the database changes (an agent's record, another window), in a few milliseconds.

## [0.158.0] - 2026-11-10

### Changed
- Edits in the new panel reviews one agent edit at a time (#202): open a file's row to see its edits under review, newest first, each with Accept, Diff and Go.

## [0.157.0] - 2026-11-10

### Changed
- Exercises, Meetings and Social open in the new panel, under More (#202): tick, skip and note an exercise's steps and grade today's recalls there; meetings by month with their decisions and to-dos; Social shows only where it is turned on. The old panel is still there for the full change graph.

### Fixed
- The agent no longer goes back on its own to a task that waits on you (its 👉 is your to-do, or a question to you is open).

## [0.156.0] - 2026-11-10

### Changed
- The new panel is the default (#201): the side bar's **Home** opens it, with what is waiting on you still under it. The side bar keeps Home, Agent changes and Setup checklist; Tasks, Architecture, Product, Glossary and Meetings live in the new panel. The command palette shows 21 Imprimatur commands instead of 37; the rest stay in their views' menus or moved into the new panel. The old panel's code goes once Exercises, Meetings, Social and the change graph move over (#202).

## [0.155.0] - 2026-11-10

### Added
- Edits and Setup in the new panel (#199): Edits lists the files with agent edits still waiting for your review, newest first; open one and its changes are marked in the editor, or review them all in the change graph. Setup leads to the agent setup checklist and the open recommendations.

## [0.154.0] - 2026-11-10

### Added
- **Current File** in the side bar (#200): for the file open in the editor, the decisions and records that name it (ADRs first), the agent's edits to it, and the document sections read from it.

### Security
- A gate approval counts only when every change to its record was yours, and it is marked done.

## [0.153.1] - 2026-11-10

### Security
- A spec's gate opens only with your own approval (#197): an approval an agent recorded shows as *agent-recorded* with a **Confirm** button, and does not open the next gate.

## [0.153.0] - 2026-11-10

### Added
- Edit documents in the new panel (#198): the project page, capabilities, glossary and out-of-scope notes get **Edit** under each section and **New section** on top (with its chapter on the project page). The change goes through the same write as the agent's, so the files follow. ADRs are edited as records, and the wiki is generated.

## [0.152.0] - 2026-11-10

### Added
- Tasks in the new panel (#197): the list (active, open, last done), then a task page with its spec in the reading layout, its tickets (status, type, what blocks them), its records and its activity. The spec's four gates (problem and user stories, design, analysis of gaps, tickets) show which are approved; **Approve** on the next one records your approval.

## [0.151.0] - 2026-11-10

### Added
- The new panel's Home (#196): one board of what needs you (tasks with a question or to-do you own), what is active and what finished this week, then where each task in progress stopped, with its spec or map tagged.

## [0.150.0] - 2026-11-10

### Added
- **The new Imprimatur panel** (#195, first part of the rebuild #190): open it from the side bar's first row, **Imprimatur**, or the command *Imprimatur: Open*. Five areas, Home, Tasks, Docs, Edits and Setup, with More for Exercises, Meetings and Social; `g h`, `g t`, `g d`, `g e`, `g s` jump between them and `/` searches. Docs shows the project page, capabilities, ADRs, glossary, out-of-scope notes and the wiki in one reading layout: sections on the left, the page with its summary first, "on this page" on the right. Tasks, Edits and Setup still open the old panel until they move over.

## [0.149.0] - 2026-11-10

### Added
- A generated wiki of the repo (#188): `npm run wiki` writes `docs/wiki/`, one page per code folder (what it does, a diagram, its parts, the ADRs about it, its terms) and an index. It is made from the code's own comments, the ADRs and the glossary, and a page is written again only when those change; edit them, not the page.

## [0.148.0] - 2026-11-10

### Added
- **Search and Ask** (#189, ctrl/cmd+alt+k): one box over every record and document section, ranked as you type, Turkish letters matching their plain forms (ı/i, ş/s, ç/c…), with the matching line under each result. The first row asks your question instead: the answer comes from the best matches and cites them, with the sources listed under it. The agent's `search` tool ranks the same way and also returns matching document sections.

## [0.147.0] - 2026-11-10

### Added
- The agent's tools speak Pocock's language (#184): `doc_get` and `doc_section_upsert` read and write a task's spec or wayfinder map, a capability, the project page and out-of-scope notes, with a spec section's change to a capability; `task_upsert` sets a ticket's type and what blocks it; `where_we_left_off` says which tasks have a spec or a map.

## [0.146.1] - 2026-11-10

### Changed
- The `issues` skill keeps the GitHub side only; splitting and triage are Pocock's `/to-tickets`, `/wayfinder` and `/triage` (#183).

## [0.146.0] - 2026-11-10

### Added
- Matt Pocock's skills come with Imprimatur (#183): `/to-spec`, `/to-tickets`, `/wayfinder`, `/grill-with-docs`, `/grill-me`, `/grilling`, `/domain-modeling`, `/research`, `/triage`, `/prototype`, `/codebase-design`, `/implement`, `/implement-spec`, `/tdd`, `/code-review`, `/improve-codebase-architecture`, `/ask-matt`, `/handoff`, `/to-questionnaire`. Their text is his; they use Imprimatur as the issue tracker. `/to-spec` asks for your approval at each step: stories, design, an analysis of gaps, then tickets.

### Removed
- The `analysis` skill: a task's spec is written with `/to-spec` now.

## [0.145.0] - 2026-11-10

### Added
- The rest of Pocock's layout (#193): `.out-of-scope/<concept>.md` for what the project will not do, `docs/PROJECT.md` (mission, constraints, tech stack, roadmap), `docs/capabilities/<name>.md` for how the system behaves now, and `docs/agents/` pointing his skills at Imprimatur. When a task with a spec is done, its changes land in the capabilities once. Edits in these files reach the database.

### Security
- Generated files are never written or removed through a symlink that leads out of the repo, also when the linked folder is above one still to be made.

## [0.144.0] - 2026-11-10

### Added
- Matt Pocock's local tracker under `.scratch/` (#192): for a task with a spec or a map, `.scratch/<task>/spec.md`, `map.md` and one file per ticket in `issues/` with its Status, Type and Blocked by lines. Edit a file and the task follows. `.scratch/` stays out of git unless `.claude/imprimatur.json` says `{"scratch": {"commit": true}}`.

## [0.143.0] - 2026-11-10

### Added
- **Keep going** (#194): while an epic you started still has work whose blockers are done, the agent goes on to it instead of ending its turn after each issue. It still stops to ask you something (a 👉 line or a question), when nothing is ready, or after 10 continuations in a session. Turn it off with `{"process": {"keepGoing": false}}` in `.claude/imprimatur.json`.

## [0.142.0] - 2026-11-10

### Added
- `GLOSSARY.md` at the repo root in Matt Pocock's format: `## Language`, then each **term** with its definition and the words to avoid (#191). The copy Imprimatur wrote under `docs/` is removed.
- Each ADR as its own file, `docs/adr/NNNN-slug.md`, in Pocock's short form (#191). Edit the file and the ADR's record follows; if the record changed too, the record wins and your text is kept as a note on its task.

### Fixed
- The decision files under `docs/decisions/` are written again on every docs sync (they had stopped updating).

## [0.141.0] - 2026-11-10

### Added
- The database holds Matt Pocock's artifacts (#181): a task's spec and a wayfinder map, capabilities (how the system behaves now) with change deltas, a project page and out-of-scope notes; tickets carry a type and what blocks them. They sync between machines. Nothing shows them yet: the views come with #184 and #190.

## [0.140.2] - 2026-11-10

### Changed
- **Waiting on you** is written in the reply language (#176), since you read it: the turn-end audit, Settle and Scan history. Edit descriptions keep the repo's language.

## [0.140.1] - 2026-11-10

### Fixed
- With a Turkish reply language the turn-end status section is asked as **Neredeyiz** and the session start tells the agent so (#176); before, a Turkish answer ended with an English "Where we are". "Where we are" still counts.

## [0.140.0] - 2026-11-10

### Added
- A reply language for the agent (#176), one per machine: at session start Imprimatur tells the agent in every repo to reply to you in it. Set it with `npm run setup -- --reply-lang Turkish` (config.json `replyLang`), the plugin's **Reply language** option or `IMPRIMATUR_REPLY_LANG`; without one it is English. A repo's `lang` still sets the language of its records, documents and commits.

## [0.139.0] - 2026-11-09

### Added
- Analysis → Task analyses says how intake stands (#175): the files the model could not judge, with the latest error, and the last read of past sessions. A **Retry** reads past sessions again and judges the files left; files already judged keep their answer, so each retry gets further.

### Changed
- The detached verdict process is now `hooks/analysis-verdict.mjs`, named for its job. The "kept task" lookup is one function shared by the hook and the backfill.

## [0.138.0] - 2026-11-09

### Fixed
- Analyses keep up with files the edit hook never saw (#174). At each session start, a file read here that is gone from disk (deleted or renamed) has its sections superseded. A Markdown file changed since the last session by something other than Edit/Write (Bash, another editor) goes through the usual analysis path, at most 50 files at a time.

## [0.137.0] - 2026-11-09

### Fixed
- A plan no task was found for can now be given one (#173): its text is kept while it waits. Before, assigning it failed with "cannot be read again".

### Added
- Each file of a task's analysis has a **Move to task…** picker (Analysis → Task analyses). The file moves with its sections, and its old sections are superseded. It works for a file that is gone from disk, too.

## [0.136.0] - 2026-11-09

### Added
- An **analysis** skill (#172): `/analysis` writes a task's analysis as a short design doc in five chapters (context, goals, design, alternatives, risks). It sums up what is already settled, asks open decisions in numbered rounds with a recommended answer, hands fact-finding to a background agent, and writes new terms and hard-to-reverse choices down. Adapted from mattpocock/skills (skills/analysis/NOTICE.md).

### Changed
- A plan or note file's sections land in the chapter their heading names (Context, Goals, Options, Risks; anything else is Design).
- MCP refuses a task-analysis section key with `--`: those keys are the sections read from files.

## [0.135.0] - 2026-11-09

### Fixed
- One repo, not two, when a checkout moves or is opened from another folder (#169): a folder whose origin matches a repo whose folder is gone takes that repo over, its tasks, meetings and documents with it. Before, it became a second, empty repo of the same name, and its pages showed nothing. A clone or worktree still on disk stays its own repo.

## [0.134.0] - 2026-11-09

### Changed
- Recommendations are no longer in the Tasks list (#170): the RECS task (and the old AUDIT / BEST) and the home folder's "Global (~)" group are gone from it. Recommendations stay in Agent Setup's Recommendations tree, and a link to RECS still opens its page.

## [0.133.0] - 2026-11-09

### Fixed
- Meetings (#169): the page shows only this repo's meetings; the sticky "every repo" scope, which has no switch there, no longer mixes other repos in. The Meetings tab has its icon.

### Changed
- The Meetings page is easier to scan: meetings grouped by month, a date tile, the meeting's real name (a generic "Toplantı" gives way to the note's bold first line) with the summary's first sentence under it, and counts of decisions and your open to-dos. Opened, decisions and to-dos sit side by side, yours first, with the full note at the bottom.

## [0.132.0] - 2026-11-09

### Changed
- Meetings have a place of their own (#169): a **Meetings** tab next to Exercises and a Meetings row in the launcher list every meeting of the repo, newest first, with the task it hangs on, its decisions and to-dos, and the note. The task page no longer has a Meetings tab; a meeting's to-dos stay in the task's To-dos.

## [0.131.0] - 2026-11-09

### Added
- A `meeting` record kind (#167): a meeting's note as one record, its decisions and to-dos as `decision` and `todo` records under it (`parent_id`). The task page has a **Meetings** tab with each meeting's date, decisions and to-dos, and the note folded. The database migrates on its own; records, versions and section links are kept.

## [0.130.0] - 2026-11-05

Everything since 0.113.4.

### Added
- One documentation standard in every repo (#128):
  - Generated documents carry Diátaxis `type:` front matter, and arc42-lite chapters show in the panel.
  - ADR and PDR records are written as numbered MADR 4 files in `docs/decisions/`, linked both ways with their sections.
  - Agent Setup's checklist writes AGENTS.md as the canonical agent file, with CLAUDE.md importing it, or proposes the split with Fix it.
  - `setup_audit` checks the documentation rules (IMP-DOC-001..006): decision numbering, considered options, section links, the arc42 chapters and C4 views, sequence diagrams, agent-file length.
- Fix it on a documentation finding runs Claude in the background with Imprimatur's tools. It links decisions to their sections, adds the alternatives the records show and numbers unnumbered decisions, then audits again.
- Documentation linters: a checklist row writes `.markdownlint-cli2.jsonc`, `cspell.json`, `lychee.toml` and `.vale.ini` plus `lint:docs`, `lint:links` and `lint:prose` scripts, never overwriting. Generated documents pass markdownlint as written.
- Three documentation skills ship with Imprimatur: documentation-writer, docs-sync-audit and writing-clearly-and-concisely, each adapted to Imprimatur's documents, with its license and source commit.
- The board on Home: seven KPI cards with sparklines, a chart, your sessions and a 12-week heatmap. Analytics on Tasks, Agent changes and Analysis.
- Stats from one module: sessions, cost, time and tokens per day. The status line keeps each session's numbers.
- Agent Setup: the baseline every repo gets, as checklist rows with install, turn on and a per-repo opt-out. "Suggested for this repo" comes from rules first, each naming what fired it, with Claude judging them; a prompt naming an uncovered technology gets vetted candidates, installed only on a yes.

### Fixed
- A documentation finding keeps its identity when the counts in its message change, so fixing one no longer opens a new one.
- A background Fix it run may change only the decisions it lists, and only their body and links.
- Fix it writes its outcome to its output channel: Claude's exit code, what it would apply and what you chose.
- Agent-file writes refuse a symbolic link on their way and never overwrite a file.
- A closed task's open asks, and a turn-end ask older than a week, no longer wait on you.

## [0.113.4] - 2026-11-05

### Fixed
- Suggested plugins fit the stack by their purpose (#143). Only a plugin's name and the first
  sentence of its description count, so a passing mention later on no longer counts ("no local
  Node.js required", "sync to Jira"). A plugin for a server or connector the last session already
  had (such as Context7 from claude.ai) is not suggested. On this repo, 8 suggestions became 4:
  github, atlassian, greptile, atlassian-twg-cli.

## [0.113.2] - 2026-11-05

### Added
- A double click on a suggested plugin opens its GitHub page (#143, 0.113.3: a single click only selects it): the plugin's own repo, its folder
  in a bigger repo, or its folder in the marketplace's repo.

## [0.113.1] - 2026-11-05

### Fixed
- Suggested plugins no longer get a warning for having no license, or an unusual one (#143).
  Installing a plugin to use it does not need the right to redistribute it; that rule is for
  what Imprimatur ships itself. The license is still shown on the row. The warning now means
  one thing: the plugin brings its own memory or tasks.

## [0.113.0] - 2026-11-05

### Added
- **Suggested for this repo** in Agent Setup (#143) lists plugins from Claude Code's
  marketplaces that fit the stack the project review mapped. Each row says which parts of the
  stack it fits, its installs and, for a plugin with its own GitHub repo, its stars, last push
  and license. A plugin kept in the marketplace says so. Ranking is installs times fits;
  installed plugins and those under 500 installs are left out. The #128 vetting rules flag no
  license, a license to check, and a plugin that brings its own memory or tasks. Hooks and MCP
  servers are read when the marketplace has the files; otherwise the row says to read them first.
  **Install for This Repo** confirms, then runs `claude plugin install --scope project`. The
  list is refreshed in the background once a day or when the stack changes.

## [0.112.0] - 2026-11-05

### Added
- Context budget acts on what it finds (#29):
  - The skill listing is split by source: your own skills (with the biggest ones named), each
    plugin's skills, and claude.ai's synced skills.
  - A plugin's row (its skills, or an MCP server it brings) has **Turn Off in This Repo**. After a
    confirmation, it writes `enabledPlugins: { "<id>": false }` to this repo's
    `.claude/settings.local.json`; that file is not committed, and other repos keep the plugin.
  - A claude.ai connector or synced skill says to turn it off in claude.ai.

### Changed
- The where-we-left-off context at session start lists only the tasks with work in hand (at
  most 8, shorter), and counts the rest in one line.

## [0.111.0] - 2026-11-05

### Added
- Context budget (#29), a group at the top of Agent Setup. It lists what this repo's last
  Claude Code session loaded into the model's context: instruction files, each hook's added
  text summed over its runs, MCP server instructions, the skill listing and Claude Code's own
  context. Items run biggest first, with estimated tokens (characters ÷ 4) and a session
  total. An item of 5,000 tokens or more is marked; a big or unused item's tooltip says how to
  shrink it and what that saves, for example an MCP server the session never called. Tool
  definitions are listed as not counted, never guessed.
- Agent Setup's session rows show estimated tokens instead of characters.

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
