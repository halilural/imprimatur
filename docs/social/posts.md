# Social media posts

Where Imprimatur was announced, what was posted and how it went. Times are Turkey time
(UTC+3).

## Tracker

| Channel | Planned | Posted | Link | Result |
|---|---|---|---|---|
| Reddit r/ClaudeCode | 2026-10-24 16:00–18:00 | | | |
| Reddit r/ClaudeAI (Built with Claude) | 2026-10-24, 1–2 h after r/ClaudeCode | | | |
| X thread | 2026-10-24 16:00–18:00 | | | |
| Claude Developers Discord #showcase | 2026-10-24 | | | |
| Show HN | Tue/Wed 15:00–17:00 | | | |
| LinkedIn | Tue 09:00–10:00 | | | |
| Product Hunt | weekday, 10:01 (00:01 PT) | | | |

Result: upvotes or likes, comments, installs the day after, bugs reported.

## Reddit r/ClaudeCode

**Title:** I built a VS Code extension that keeps Claude Code's doc edits marked as tracked
changes until you accept them

Image: `assets/tracked-changes.png`. GitHub link in the first comment:
https://github.com/halilural/imprimatur

```text
Claude Code edits my design docs faster than I can read them. git diff helps
until I commit, and then the marks are gone even though I never read half of it.

So I built Imprimatur (Latin for "let it be printed"). It's a Claude Code plugin
(hooks + an MCP server) and a VS Code extension.

What it does:

- Before each agent edit of a Markdown file, a hook saves a copy. The extension
  diffs against that copy, so the changes stay marked in the editor and the
  preview until you click Accept. Committing doesn't clear them.
- Waiting on you: questions, permission requests and "test this" steps from
  every session in one list. After each turn, Haiku ticks off what you already
  answered.
- Tasks with a 👉 pointer to where work stopped. The agent reads it through MCP
  when a session starts.
- Architecture, Product and Glossary docs in sections, which the agent updates
  when it records a decision.

Everything stays on your machine (SQLite plus copies in .claude/imprimatur/).
Model calls go through your own claude CLI, mostly Haiku.

Install:
  claude plugin marketplace add halilural/imprimatur
  claude plugin install imprimatur@imprimatur
then the extension "halilural.imprimatur" from the VS Code Marketplace or Open VSX.

Works on Linux, macOS and WSL. Native Windows isn't tested yet.

It's MIT and still early (0.70). I'd like to hear what breaks, and whether
Markdown-only tracking is enough or you'd want it for code too.
```

## Reddit r/ClaudeAI

Same body as r/ClaudeCode, with this opening paragraph:

```text
Built with Claude Code (most of the 388 commits are co-authored by it), for
people who use Claude Code: it keeps the agent's doc edits marked as tracked
changes in VS Code until you accept them.
```

## X thread

1/ Image: `assets/tracked-changes.png`

```text
Claude Code edits my docs faster than I can read them.

So I built Imprimatur: the agent's edits stay marked as tracked changes in
VS Code until I accept them. Committing doesn't clear them.
```

2/ Image: `assets/waiting-on-you.png`

```text
Every question, permission request and "test this" step from all my sessions
lands in one "Waiting on you" list. After each turn, Haiku ticks off what I
already answered.
```

3/ Image: `assets/tasks.png`

```text
Each task keeps a 👉 pointer to where work stopped. The agent reads it through
MCP when a session starts, so I don't explain the context again.
```

4/

```text
Runs locally (SQLite), MIT. A Claude Code plugin plus a VS Code extension.
Linux, macOS, WSL.

github.com/halilural/imprimatur
```
