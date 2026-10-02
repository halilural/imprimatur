# agent-review

See what an AI coding agent changed, right in the editor, like tracked changes
in a word processor, until you stage it.

- Added lines get a green background.
- In a changed line only the changed words are marked: new words highlighted,
  old words struck through in red next to them.
- A deleted block shows a red marker on the line before it; hover to read it.
- Marks in the overview ruler, a change count in the status bar.
- **Agent Review: Accept Agent Change at Cursor** and **Accept All Agent
  Changes in File** clear the marks without touching git.
- Stage the file (`git add`) and the marks disappear: staging is the review.
  Unstage it and they come back. Edits the agent makes after you staged show
  on their own, against the staged text.

Colors show in the text editor only, not in the Markdown preview.

## How it works

1. A Claude Code `PreToolUse` hook ([hooks/baseline.mjs](hooks/baseline.mjs))
   copies a file to `.claude/review-baseline/<path>` before the agent first
   edits it (an empty copy for a new file). While the file has unstaged
   changes the copy is kept; once it is fully staged or committed, the next
   edit takes a fresh copy, so new edits are compared with the staged text.
2. The VS Code extension ([vscode/](vscode/)) diffs each open file against its
   copy: line LCS, then word LCS inside changed lines.
3. The extension watches `.git/index` and sorts each copy by `git status`:
   unstaged changes → marks shown; fully staged → copy kept, marks hidden
   (unstaging brings them back); committed → copy deleted.

The agent should not stage its own changes: if it stages or commits, the marks
disappear before you have looked.

## Install

Requires Node 22+, git and VS Code 1.100+.

1. Hook, in your project's `.claude/settings.json` (extensions after the
   script name; default `md mdx`):

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Edit|Write",
           "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/path/to/agent-review/hooks/baseline.mjs md mdx" }]
         }
       ]
     }
   }
   ```

2. Ignore the copies: add `.claude/review-baseline/` to `.gitignore`.
3. Extension: `npm run package`, then install `dist/agent-review-<version>.vsix`
   (`code --install-extension …`, or Extensions view → Install from VSIX).

## Limits

- Partial staging: staged parts stay marked until the whole file is staged.
- The copy is taken on the agent's first edit, so your own unstaged edits made
  before that count as the baseline, not as agent changes.
- Plain O(n·m) LCS on the part between the common head and tail; fine for
  documents, slow for files with thousands of changed lines.

## Develop

```sh
npm test         # hook and diff tests (node:test)
npm run package  # builds dist/agent-review-<version>.vsix
```

## License

MIT
