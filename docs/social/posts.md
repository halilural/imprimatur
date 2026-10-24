# Social media posts

Where Imprimatur was announced, what was posted and how it went. Times are Turkey time
(UTC+3). Written with the `social-post` skill: each channel's rules were read on the date on
its card, and the post was checked against them.

## Tracker

| Channel | Planned | Posted | Link | Result |
|---|---|---|---|---|
| Reddit r/ClaudeCode | 2026-10-24 16:00–18:00 | | | |
| Reddit r/ClaudeAI | 2026-10-24, 1–2 h after r/ClaudeCode | | | |
| X thread | 2026-10-24 16:00–18:00 | | | |
| Claude Developers Discord #showcase | 2026-10-24 | | | |
| Show HN | Tue/Wed 15:00–17:00 | | | |
| LinkedIn | Tue 09:00–10:00 | | | |
| Product Hunt | weekday, 10:01 (00:01 PT) | | | |

Result: upvotes or likes, comments, installs the day after, bugs reported.

## Facts used (checked 2026-10-24)

| Fact | Source |
|---|---|
| Version 0.71 on the VS Code Marketplace; Open VSX re-run pending | release run 40097232629 |
| 395 commits since 2026-10-02, 290 of them co-authored by Claude | `git rev-list --count main`, `git log --format=%B \| grep -c 'Co-Authored-By: Claude'` |
| Model calls go through the user's own `claude` CLI, Haiku by default | `vscode/model.js:12` |
| Linux, macOS, WSL; native Windows not tested yet | task #84 (open) |
| MIT, everything local (SQLite + copies in `.claude/imprimatur/`) | `LICENSE`, README |
| Install commands | README, `docs/REFERENCE.md` |

## Reddit r/ClaudeCode

```
Rules read 2026-10-24: r/ClaudeCode — NOT READABLE: reddit.com blocks curl, WebFetch and the
browser tool here. Rules not checked.
- Paste the sidebar rules and the flair list, and the post is checked against them.
- Hint (memory, unverified): self-promotion is often limited to a flair or a weekly thread;
  links in the first comment; no link-only posts.
- Reddit-wide (third-party summaries, unverified): ~9:1 contribute-to-promote; say you made it.
```

**Status: rules not checked.**

**Title** (99 characters):

```text
I built a VS Code extension that keeps Claude Code's doc edits marked until I've actually read them
```

**Image:** `assets/tracked-changes.png`. Alt text: "Claude Code's edits in a Markdown file: added lines in green,
a changed word next to the old one in a red box, a marker for a deleted block, and Accept above the block."

**Body:**

```text
Claude Code edits my design docs faster than I can read them. git diff helps until I
commit, and then the marks are gone, even though I never read half of it.

So I built Imprimatur (Latin for "let it be printed"). It's a Claude Code plugin (hooks
and an MCP server) plus a VS Code extension.

- Before each agent edit of a Markdown file, a hook saves a copy. The extension diffs
  against that copy, so the changes stay marked in the editor and the preview until you
  click Accept. Committing doesn't clear them.
- Waiting on you: questions, permission requests and "test this" steps from every session
  in one list. After each turn, Haiku ticks off what you already answered.
- Tasks with a 👉 pointer to where work stopped. The agent reads it through MCP when a
  session starts.
- Architecture, Product and Glossary docs kept in sections, which the agent updates when it
  records a decision.

Everything stays on your machine (SQLite plus copies in .claude/imprimatur/). Model calls
go through your own claude CLI.

I made it and I use it every day. It's MIT and early (0.71). Works on Linux, macOS and
WSL; native Windows isn't tested yet. I'd like to hear what breaks, and whether
Markdown-only tracking is enough or you'd want it for code too.
```

**First comment:**

```text
Repo and install: https://github.com/halilural/imprimatur

claude plugin marketplace add halilural/imprimatur
claude plugin install imprimatur@imprimatur

Then the "halilural.imprimatur" extension from the VS Code Marketplace or Open VSX.
```

## Reddit r/ClaudeAI

```
Rules read 2026-10-24: r/ClaudeAI — NOT READABLE (as above). Rules not checked.
- The "Built with Claude" flair's posting requirements could not be read. The only official
  page found is the 2025 contest rules (support.anthropic.com/en/articles/12003471), which
  asked for what was built, how, screenshots or a demo, and a prompt used. That contest has
  ended. Treat it as a hint.
- Do not post the same text on the same day as r/ClaudeCode (third-party advice, unverified):
  this post leads with how it was built.
```

**Status: rules not checked.**

**Title** (103 characters):

```text
Built with Claude Code: 290 of its 395 commits are co-authored by Claude, and it reviews Claude's edits
```

**Body:**

```text
I built Imprimatur with Claude Code, for people who use Claude Code. 290 of the 395
commits carry "Co-Authored-By: Claude".

The problem it solves for me: Claude edits my design docs faster than I can read them, and
once I commit, git diff no longer shows what I never looked at.

What it does:
- A hook saves a copy before each Markdown edit; the VS Code extension keeps the changes
  marked until I accept them.
- One "Waiting on you" list for every question and permission request across sessions.
- Tasks with a 👉 to where work stopped, read by the agent through MCP.

How it was built: Claude Code wrote most of the code under my review. Imprimatur's own task
records (decisions, ADRs, questions) live in Imprimatur, so each session starts from
where the last one stopped. The design documents are written by the agent and checked by me.

A prompt I use: "Call where_we_left_off first, then continue the task's 👉."

Screenshots: tracked changes, Waiting on you, Tasks (images attached).
MIT, local (SQLite). Linux, macOS, WSL. Feedback welcome, especially what breaks.
```

**Images:** `assets/tracked-changes.png`, `assets/waiting-on-you.png`, `assets/tasks.png` (alt text as in the
README captions). Link in the first comment, as for r/ClaudeCode.

## X thread

```
Rules read 2026-10-24: X — docs.x.com/fundamentals/counting-characters (help.x.com returned 403)
- Length: 280 weighted characters per post; any URL counts 23; emoji and CJK count 2;
  media attached counts 0; measured after NFC normalization.
- Threads: help.x.com page not readable; a thread is replies to your own post (memory).
- Links: allowed; put last.
```

**Status: checked** (counts by the rules above).

1/ (232) Image: `assets/tracked-changes.png`

```text
Claude Code edits my design docs faster than I can read them, and once I commit, the diff is gone.

So I built Imprimatur: the agent's edits stay marked as tracked changes in VS Code until I accept them. A commit doesn't clear them.
```

2/ (197) Image: `assets/waiting-on-you.png`

```text
Every question, permission request and "test this" step from all my sessions lands in one Waiting on you list.

After each turn, Haiku (through my own claude CLI) ticks off what I already answered.
```

3/ (143) Image: `assets/tasks.png`

```text
Each task keeps a 👉 pointer to where work stopped. The agent reads it through MCP when a session starts, so I don't explain the context again.
```

4/ (166)

```text
It runs locally (SQLite), MIT licensed. A Claude Code plugin plus a VS Code extension, on the Marketplace and Open VSX. Linux, macOS and WSL.

https://github.com/halilural/imprimatur
```

## Claude Developers Discord #showcase

```
Rules read 2026-10-24: Claude Developers Discord #showcase — NOT READABLE: the server's rules
channel and the channel's pinned messages have to be pasted. Rules not checked.
- Hint (memory, unverified): one post per project, a few lines, one image, the link; no
  cross-posting to other channels.
```

**Status: rules not checked.**

```text
Imprimatur: Claude Code's doc edits stay marked as tracked changes in VS Code until you accept them, even after you commit.
Also one "Waiting on you" list for every session's questions, and tasks with a 👉 to where work stopped, read through MCP.
Local, MIT. Claude Code plugin + VS Code extension. I made it; feedback welcome.
https://github.com/halilural/imprimatur
```

Image: `assets/tracked-changes.png`.

## Show HN

```
Rules read 2026-10-24: news.ycombinator.com/showhn.html, /newsguidelines.html, item?id=22336638
- Title: begins "Show HN: "; plain, no attention-grabbing, no gratuitous numbers or adjectives.
- Must be something people can try, made by you, and you're around to discuss it. Easy to try,
  ideally without signup. Early-stage work is fine.
- Text: what it is, the backstory, what's different; factual, direct; marketing language is
  "an instant turnoff".
- "Write your text by hand": don't use an LLM to generate or edit it.
- Don't solicit upvotes or comments; no booster comments from friends; a project name as the
  username is discouraged.
- If the text doesn't show at the top, post it as the first comment.
```

**Status: write it yourself.** The guidelines ask for text written by hand, so it isn't
drafted here. Material for you to write from:

- **Title idea** (yours to word): `Show HN: Imprimatur – Claude Code's doc edits as tracked changes until you accept them`
- **URL:** https://github.com/halilural/imprimatur (people can try it without signing up).
- **Points to cover, in your words:** the moment it started (edits faster than you could read, the diff
  gone after a commit); how it works (a PreToolUse hook saves a copy, the extension diffs against it, one
  SQLite database per machine, an MCP server); what's different from git diff (marks survive a commit,
  per agent edit, with Accept); what's rough (Markdown only, native Windows untested, 0.71); a question
  you want answered (code too, or docs only?).
- **Facts:** see "Facts used" above.
- Post from your own account and stay for the first two hours to answer.

## LinkedIn

```
Rules read 2026-10-24: LinkedIn — linkedin.com/help/linkedin/answer/a528176
- Length: up to 3,000 characters; longer goes to an article.
- Documents can be attached (no limits stated).
- Links and hashtags: not covered by the page.
- "See more" cut: not official; third-party guides say ~140 (mobile) to ~210 (desktop)
  characters. Hint: the first two lines carry the post.
```

**Status: checked** (1,064 characters).

```text
My AI agent writes design docs faster than I can read them.

That became a real problem: once I committed, git diff no longer showed the parts I had never reviewed. So for the last three weeks I built a tool for it.

Imprimatur is a VS Code extension and a Claude Code plugin. Before each edit the agent makes to a Markdown file, it saves a copy, and the editor keeps the changes marked as tracked changes until I accept them. A commit doesn't clear them.

Two more things came out of using it every day:
→ One list of everything the agent is waiting on from me, across all sessions.
→ Tasks that remember where work stopped, so a new session starts from there.

What I learned building it with an agent: the bottleneck moved from writing to reviewing. 290 of the 395 commits are co-authored by Claude, and most of my time went into checking what had changed.

It's open source (MIT), runs locally, and is on the VS Code Marketplace. If you work with coding agents, I'd like to know how you keep track of what they changed.

https://github.com/halilural/imprimatur
```

Image: `assets/hero.png` (alt: "Imprimatur: your agent writes, you approve. A rubber stamp stamps a green check on a
page"). No hashtags.

## Product Hunt

```
Rules read 2026-10-24: help.producthunt.com/en/articles/479557-how-to-post-a-product
- Name: the product's name only, no description or emojis.
- Description: 260 characters at most.
- Tagline: "very short"; no limit stated (third-party guides say 60, a hint).
- Gallery: at least 2 images, 1270×760 recommended. Thumbnail: square, 240×240 recommended,
  GIF under 3 MB. Video: a public YouTube link.
- Topics: only a few that fit best. Personal account only; finish onboarding first.
- Launch day: 24 hours in PST, posts go live 12:01 AM PST. "Kick off the conversation with a
  comment about the product."
- Asking for upvotes: not covered by this page (third-party guides say it's against the
  rules: don't).
```

**Status: checked.** Images to resize: the README images are 1600×900; export the gallery at
1270×760 and the thumbnail from `vscode/media/icon.png` (256×256) at 240×240.

- **Name:** `Imprimatur`
- **Tagline** (50): `Review your AI agent's doc edits before they stick`
- **Description** (227):

```text
Claude Code's edits to your Markdown docs stay marked as tracked changes in VS Code until you accept them, even after a commit. Plus one list of what the agent is waiting on from you, and tasks that remember where work stopped.
```

- **Topics:** Developer Tools, Artificial Intelligence, Open Source.
- **Gallery:** tracked-changes, waiting-on-you, tasks, living-docs.
- **Maker's first comment:**

```text
Hi, I'm Halil and I made Imprimatur.

I use Claude Code all day, and it writes design docs faster than I can read them. After a commit, git diff no longer showed what I had skipped, so I built a hook that saves a copy before each edit and a VS Code extension that keeps the changes marked until I accept them.

It grew two more parts from daily use: a "Waiting on you" list of every question the agent asked across sessions, and tasks with a pointer to where work stopped, which the agent reads when a session starts.

It's MIT, local (SQLite), and runs through your own claude CLI. It's early: Markdown only, and native Windows isn't tested yet. What would make it useful for you?
```
