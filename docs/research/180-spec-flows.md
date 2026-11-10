---
type: explanation
---

# How competitors and OSS go from idea to spec to tickets, and who Imprimatur competes with

Research for #180 (epic #179), 2026-11-10, by web search. Most sources are third-party guides, mirrors or vendor pages; versions differ, so check a product's own docs before copying a command or file name. The UI/UX half is in [180-ui-ux.md](180-ui-ux.md).

## Spec flows

| Product | Flow | Artifacts and where they live | Big work | Project-level context |
| --- | --- | --- | --- | --- |
| **Matt Pocock skills** (OSS, MIT) | grill → to-spec → to-tickets → implement; wayfinder for work bigger than a session | Spec, tickets, map in the tracker or `.scratch/`; `GLOSSARY.md`, `docs/adr/` | Wayfinder map of decision tickets, one resolved per session | Glossary and ADRs only |
| **GitHub Spec Kit** (OSS) | constitution → specify → clarify → plan → tasks → analyze → implement ([Microsoft Learn](https://learn.microsoft.com/en-us/training/modules/spec-driven-development-github-spec-kit-enterprise-developers/3-examine-github-spec-kit), [Augment](https://www.augmentcode.com/guides/github-spec-kit-practical-guide-sdd-workflow)) | A folder per feature: spec, plan, tasks; templates in `.specify/` | Tasks with dependencies; implement updates their status | `.specify/memory/constitution.md`: principles, constraints, quality gates, governance |
| **Kiro** (AWS) | requirements → design → tasks, each approved; Analyze Requirements; Quick Plan skips gates ([Kiro](https://kiro.dev/docs/specs/concepts), [Classmethod](https://dev.classmethod.jp/articles/kiro-ide-012-analyzespec/)) | `.kiro/specs/<feature>/requirements.md` (EARS), `design.md`, `tasks.md` | "Run all Tasks" runs independent ones together | Steering files |
| **cc-sdd** (OSS) | Kiro's flow inside Claude Code, Gemini CLI, Cursor: `/kiro:steering`, `/kiro:spec-init`, then requirements, design, tasks ([ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2Fgotalab%2Fcc-sdd), [GIGAZINE](https://gigazine.net/news/20251108-cc-sdd/)) | Kiro-compatible files | As Kiro | Steering first |
| **OpenSpec** (OSS) | explore → propose a change → apply → archive ([OpenSpec](https://openspec.dev/docs/existing-projects)) | `openspec/specs/` = how the system behaves now; `openspec/changes/<id>/` = one proposed change with **delta specs** (ADDED, MODIFIED, REMOVED, RENAMED); `archive/` after merge | One change folder each; bulk-archive with conflict detection | The current-behaviour specs themselves |
| **BMAD Method** (OSS) | analyst brief → PM PRD → architect → epics and stories (v6: after the architecture) → dev ([BMAD docs](https://www.mintlify.com/bmad-code-org/BMAD-METHOD/tutorials/getting-started), [Augment](https://www.augmentcode.com/guides/bmad-method-ai-development)) | `_bmad-output/planning-artifacts/` PRD, `architecture.md`, `epics.md` or per-epic files | Epics and stories with acceptance criteria | PRD and architecture document |
| **Agent OS** (Builder Methods, OSS) | plan-product → shape-spec → write-spec → create-tasks ([Agent OS](https://buildermethods.com/agent-os/concepts), [v3 release](https://newreleases.io/project/github/buildermethods/agent-os/release/v3.0.0)) | `agent-os/product/mission.md`, `roadmap.md`, `tech-stack.md`; `agent-os/specs/<feature>/spec.md`, `tasks.md` | Roadmap items become specs | **Three layers: standards (how), product (what and why), specs (next)** |
| **Task Master** (OSS) | parse-prd → analyze-complexity (1–10) → expand into subtasks → next → set-status ([Task Master docs](https://docs.task-master.dev/command-reference.md)) | `.taskmaster/tasks/tasks.json` | Dependencies; `next` picks the first unblocked task | The PRD |
| **CCPM** (OSS, MIT) | PRD → technical epic → task files → GitHub issues → parallel agents in worktrees ([CCPM](https://docsearch.algolia.com/mcp/docs/repo/automazeio/ccpm), [HN](https://hn.svelte.dev/item/44960594)) | PRD and epic files; GitHub Issues as the source of truth | Several issues at once, each in its own worktree | The PRD |
| **Backlog.md** (OSS, MIT, ~3.7k ★) | Tasks as Markdown files with a Kanban in the terminal or browser; MCP for agents ([GitHub](https://github.com/MrLesk/Backlog.md)) | One `.md` per task in the repo | Milestones, Definition of Done | Docs in the repo |
| **Cursor** | Plan mode (Shift+Tab); a plan can be saved as Markdown in the repo and edited ([Cursor blog](https://cursor.com/blog/plan-mode)) | A plan file | To-dos inside the plan | Rules |
| **Linear** | Agents are workspace members: assigned, @-mentioned, added to projects; admins give them guidance ([Linear docs](https://linear.app/docs/agents-in-linear.md), [devclass](https://www.devclass.com/development/2026/03/27/linear-moves-sideways-to-agentic-ai-as-ceo-declares-issue-tracking-dead/5211661)) | Issues | Projects | Agent guidance |
| **Jira Rovo** | Rovo Dev from a work item to a pull request; Work Item Planner breaks initiatives into epics and stories; Agents in Jira can be assigned work, Copilot's coding agent included ([Atlassian](https://community.atlassian.com/forums/Jira-articles/Introducing-Agents-in-Jira/ba-p/3194583)) | Work items | Epics and stories | Jira itself |
| **Tessl** | Moved from a spec registry (2025) to a skills registry and "agent enablement"; spec-driven work is now an installable tile ([codemyspec](https://codemyspec.com/blog/tessl-review), [Tessl](https://tessl.io/registry/tessl-labs/spec-driven-development)) | Registry packages | — | — |

## Memory and history

| Product | What it does |
| --- | --- |
| **claude-mem** (OSS) | The closest to Imprimatur's core. Claude Code plugin: lifecycle hooks capture sessions and tool calls, a model compresses them into observations, stored in SQLite with FTS5, earlier context injected at session start, `mem-search` skill ([docs](https://www.mintlify.com/thedotmack/claude-mem/introduction), [Augment](https://www.augmentcode.com/learn/claude-mem-persistent-memory-claude-code)) |
| **Basic Memory** (OSS) | Notes as local Markdown with WikiLinks into a knowledge graph; MCP tools; works with Obsidian ([docs](https://www.mintlify.com/basicmachines-co/basic-memory)) |
| **mem0 OpenMemory** | MCP memory layer for coding agents that captures preferences and patterns; local versus cloud handling is disputed ([mem0](https://mem0.ai/openmemory)) |
| **Letta** | Memory blocks always in context, edited by the agent, shareable between agents ([Letta](https://docs.letta.com/guides/agents/memory)) |
| **Byterover / Cipher** | Open-source memory layer over MCP (concepts and reasoning); hosted version shares it with a team ([Product Hunt](https://www.producthunt.com/p/byterover/cipher-by-byterover)) |
| **SpecStory** | Saves chat history from Cursor, Copilot, Claude Code and Codex as Markdown in `.specstory/history/`; cloud with search, sync and MCP ([docs](https://docs.specstory.com/specstory/quickstart)) |
| **git-ai** (OSS, Apache-2.0) | Line-level AI attribution in git notes (`refs/notes/ai`); `git ai blame`, `git ai stats`; only for commits after install ([usegitai](https://usegitai.com/ai-blame), [rywalker](https://rywalker.com/research/git-ai)); alternatives: agentdiff, Mesa Agent Blame |

## Competitor list, refreshed

**Commercial:** Claude Code, Cursor, GitHub Copilot (built-in); Kiro, Devin and DeepWiki, Linear agents, Jira Rovo (planning); Conductor, SpecStory, Nimbalyst (sessions and history); Swimm (code-coupled docs), Mintlify (public docs); Byterover, mem0 (memory); Faros AI, Span, Jellyfish, LinearB, DX (metrics); Tessl (skills registry).

**Open source:** Pocock skills, Spec Kit, OpenSpec, BMAD, Agent OS, cc-sdd, Task Master, CCPM, Backlog.md (spec and task flow); claude-mem, Basic Memory, OpenMemory, Letta, Cipher (memory); git-ai, agentdiff (provenance); Ruler, rulesync, agnix (agent config); ccusage, claude-code-router (cost); claude-diff-review, Claude Squad (review).

Closest to Imprimatur as a whole: **claude-mem** (hooks, SQLite, FTS5, injection at session start) and **SpecStory** (history plus search plus MCP).

## Verdict for epic #179

1. **Confirmed:** everyone keeps a fixed set of files per feature in a known folder (Kiro, Spec Kit, Agent OS, OpenSpec, Pocock's `.scratch/`). #181 and #182 stand.
2. **Gap in Pocock:** almost every other system has a **project-level layer** above specs: Spec Kit's constitution, Kiro's steering, Agent OS's product mission, roadmap and tech stack, BMAD's PRD and architecture. Pocock has only the glossary and ADRs. This is what the Architecture and Product documents were for. Suggest keeping one small, hand-approved project page (mission, constraints, tech stack, roadmap) rather than deleting it outright; decide in #185.
3. **Take from OpenSpec:** current-behaviour specs plus change deltas that merge on archive. It answers "what does the system do now" without a hand-kept living document, and it feeds the wiki (#188).
4. **Take from Spec Kit and Kiro:** an "analyze" gate that finds contradictions, ambiguities and gaps before tickets (#183).
5. **Reuse, do not rebuild:** line provenance (#187 item 2) can sit on git-ai's open format (git notes) instead of a format of our own.
6. **Watch:** claude-mem is the most direct competitor to Imprimatur's memory side; its FTS5 search and session-start injection are what #189 and #136 aim at.
