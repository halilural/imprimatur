# AGENTS.md

The rules every coding agent follows in this repo. Claude Code reads them through CLAUDE.md, which imports this file; what only Claude Code needs stays there, and where the two conflict, CLAUDE.md takes precedence for Claude Code.

## Work

- Read the task and the code it touches before changing anything; change what the task needs and no more.
- Run the tests before calling a change done, and say so when they could not run.
- Ask before anything hard to undo: deleting, rewriting history, pushing, publishing.

## Imprimatur

- Imprimatur keeps its own rules (tasks, records, documents) in `.claude/rules/imprimatur.md` and updates them itself; this file holds the repo's own. This repo's own document rule is in `.claude/rules/docs.md`.
