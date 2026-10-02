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
- Changes you have not staged yet are bright; staged ones turn dim, so after
  several rounds you still see everything the agent changed since the last
  commit and which part is new. Commit and the marks go away.

Colors show in the text editor only, not in the Markdown preview.

## How it works

1. A Claude Code `PreToolUse` hook ([hooks/baseline.mjs](hooks/baseline.mjs))
   copies a file to `.claude/review-baseline/<path>` before the agent first
   edits it (an empty copy for a new file). The copy is kept until the file is
   committed; the first edit after a commit takes a fresh copy.
2. The VS Code extension ([vscode/](vscode/)) diffs each open file against its
   copy (line LCS, then word LCS inside changed lines), and against the staged
   text (`git show :<path>`) to tell new changes (bright) from staged ones (dim).
3. The extension watches `.git/index`; when a file is committed its copy is
   deleted and the marks go away.

The agent should not commit its own changes: a commit clears the marks before
you have looked. If it stages, the changes only turn dim.

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

- New vs staged is decided per line: a line with both staged and new words shows bright.
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
