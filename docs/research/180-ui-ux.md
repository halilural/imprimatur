---
type: explanation
---

# UI/UX: how competitors make agent-written knowledge understandable, ordered and findable

Research for #180 (epic #179), 2026-11-10. Sources were found by web search; most are third-party guides, so details marked *secondhand* should be checked on the product before we copy them. Lines marked *unverified* come from prior knowledge, not from a source read today.

## Question

The user cannot follow the documents the agent writes ("too complex, scattered, disordered"), finds search poor, and dislikes Imprimatur's UI/UX. What have competitors done about each of these?

## Where Imprimatur stands today

Counted in the code on 2026-11-10:

- One Activity Bar container with two views (the launcher and Agent setup), and a webview panel with eight tabs: home, edits (Agent Change Graph), tasks, docs (architecture, product, glossary, analysis), exercises, meetings, social, recommendations.
- 70 commands and 12 settings.
- About 5,000 lines of hand-built webview UI (tasksView.js 1,305, graphView.js 1,925, docsView.js 453, setupView.js 1,346).
- A task's analysis is built from the `##` headings of whatever Markdown the agent wrote, so its order and depth vary per task.
- Search is a substring match over record titles and bodies; an FTS5 + bm25 + snippet proposal waits for a decision (task `arama-fts5`).

## Findings

### 1. Understanding: a generated wiki you can ask (DeepWiki)

- Devin indexes the repo and produces a wiki with architecture diagrams, links to the sources and summaries; you can ask questions and get answers grounded in the code. A `.devin/wiki.json` in the repo chooses what gets documented. An MCP server exposes `ask_question` and `read_wiki_contents` to agents. ([Devin docs](https://docs.devin.ai/work-with-devin/deepwiki))
- Layout, *secondhand*: a left sidebar of the repo's modules and sections with expandable sections, the page in the middle, an "On this page" list on the right, and an Ask box; diagrams are Mermaid; Ask has a fast mode and a Deep Research mode. ([codersera](https://codersera.com/blog/deepwiki-complete-guide-2026), [DEV](https://dev.to/rishabh-hub/harnessing-deepwiki-a-developers-guide-to-smarter-code-exploration-30dd))

### 2. Order: the same files every time, approved in turn (Kiro)

- Each feature is a folder under `.kiro/specs/` with three files: `requirements.md` (user stories, acceptance criteria in EARS: "WHEN … THE SYSTEM SHALL …"), `design.md` (architecture, sequence diagrams), `tasks.md` (the steps). ([Kiro docs](https://kiro.dev/docs/specs/concepts))
- The panel walks them in order: write requirements, review and approve, then design and tasks are generated; approve the design, then the tasks run. Task status updates live; "Run all Tasks" runs independent ones at once. *Secondhand* for the gates. ([Kiro blog](https://kiro.dev/blog/introducing-kiro/), [verdent](https://www.verdent.ai/guides/agents/kiro-spec-driven-development))
- 0.12 added "Analyze Requirements" (finds contradictions, ambiguities and gaps in requirements) and "Quick Plan" (all three files without the gates). ([Classmethod](https://dev.classmethod.jp/articles/kiro-ide-012-analyzespec/))

### 3. Findability: ask, and every claim points at its source (Glean)

- Answers come with links to their sources so they can be checked without reading the whole file. Glean's developer guide deep-links a citation to the exact supporting snippet, and falls back to the whole document when the snippet match is uncertain, "to avoid misleading users". ([Glean deep-linked citations](https://glean-developer-site-1ekzqhnpk-glean-developers.vercel.app/guides/chat/deep-linked-citations), [fritz.ai review](https://fritz.ai/glean-review/))
- One search box over every source; a chat over what search retrieved. A reviewer found answers slow and inconsistent, and only as good as the sources are current. ([fritz.ai review](https://fritz.ai/glean-review/))

### 4. Speed and calm: keyboard-first, one command menu (Linear)

- The command menu (Cmd+K) is the main place to act; its groups are ordered by what you are looking at. Shortcuts are mnemonic and shown next to each action, so the menu teaches them. "Keyboard-first, mouse-friendly." ([Interface Lineage](https://interfacelineage.com/linear-keyboard-first-multiplayer), [Blake Crosley](https://blakecrosley.com/guides/design/linear))
- The redesign aimed to reduce visual noise, keep alignment, and raise the hierarchy and density of navigation. *Secondhand.* ([925studios](https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026))
- It feels instant because data is local and the UI is optimistic: the command menu searches client-side data. ([performance.dev](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown))

### 5. One source, many views (NotebookLM)

- From the same sources: a mind map whose nodes open a sub-summary and point at their sources, a briefing doc, FAQ, timeline, a study guide with a glossary, and an audio overview. ([TechRadar](https://www.techradar.com/computing/artificial-intelligence/googles-notebooklm-adds-mind-maps-to-its-string-of-research-tools-to-help-you-learn-faster-than-ever), [eWeek](https://www.eweek.com/news/google-notebooklm-cheat-sheet-2026/))

### 6. Progressive disclosure, with its limits

- Show the essential first, reveal the rest on demand; keep to one level of disclosure, since three or more suggests the feature is too complex. ([GitLab Pajamas](https://design.gitlab.com/patterns/progressive-disclosure/))
- For agent output specifically: readers miss what they never expand, and too many clicks frustrate; avoid deep nesting and unclear labels. ([Agentic Design](https://agentic-design.ai/patterns/ui-ux-patterns/progressive-disclosure-patterns))

### 7. Fitting into VS Code

- Webviews are for what native views cannot do, and a poorly designed one "feels out of place" in VS Code; users can drag views between the side bar and the panel. ([VS Code webviews UX](https://code.visualstudio.com/api/ux-guidelines/webviews), [webview guide](https://code.visualstudio.com/api/extension-guides/webview), [sidebars](https://code.visualstudio.com/api/ux-guidelines/sidebars))
- *Unverified* (VS Code UX guidelines as remembered): use theme colors, keep the number of views and view containers small, no promotions or wizards in webviews.

### 8. Ordering documents by what the reader wants (Diátaxis)

- *Unverified*, but the repo already carries a Diátaxis skill (`documentation-writer`): tutorials, how-to guides, reference and explanation are kept apart because a reader comes with one of four needs. Mixing them is a common cause of "I can't follow this".

## What this means for Imprimatur

| User's problem | What competitors do | Candidate for Imprimatur |
| --- | --- | --- |
| Can't understand the documents | Generated wiki with diagrams and summaries (DeepWiki); many views of one source (NotebookLM) | A repo wiki generated from specs, ADRs, the glossary and the code: one summary per page first, a Mermaid diagram per module, sources linked |
| Scattered, disordered | The same files every time, approved in order (Kiro; Pocock's fixed spec) | Fixed files per feature with approval gates; no more sections taken from whatever headings the agent wrote |
| Search is poor | Ask with citations (DeepWiki, Glean); local, instant command menu (Linear) | One Cmd+K box: jump to anything (FTS5 + bm25 for the instant part), and "ask" for an answer that cites records, ADRs and code lines, falling back to the whole document when unsure |
| UI/UX disliked | Calm, dense, keyboard-first (Linear); native-first in VS Code | Far fewer tabs and commands; one reading layout (sections left, page, "on this page" right); theme colors; native views where they suffice |

Biggest single lever: the analysis is assembled from the agent's own headings. Fixed files (Kiro, Pocock) would remove most of the disorder before any UI work.

## Open questions

1. Kiro's fixed files (requirements, design, tasks) or Pocock's (spec, tickets)? They overlap: Pocock's spec holds Kiro's requirements and design; his tickets are Kiro's tasks.
2. A generated wiki goes against Pocock's "no living docs". Keep it as a view generated from specs, ADRs and code (never edited by hand), or not at all?
3. Which screens does the user find hardest? Screenshots would point the UI work at the right places.
4. Not yet looked at: Cursor's and Claude Code's own review and plan panels, Notion, Raycast, Swimm's IDE view.
