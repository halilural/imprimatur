# agent-review

See what an AI coding agent changed in your docs, right in the editor, like
tracked changes in a word processor, until you accept it. Git is not involved:
staging or committing does not clear the marks.

- Added lines get a green background.
- A changed line where only one word changed marks that word: the new word
  highlighted, the old one struck through in red next to it. When more than one
  word changed, the old sentence is struck through and the new one follows.
- A deleted block shows a red marker on the line before it; hover to read it.
- The agent's latest edit is bright, its earlier edits dim.
- Marks in the overview ruler, a change count in the status bar.
- **Agent Review: Accept Agent Change at Cursor** and **Accept All Agent
  Changes in File** clear the marks.

The Markdown preview shows the same changes per block: changed blocks are
colored, their old text struck through right above them, deleted lines struck
through where they were.

## How it works

1. A Claude Code `PreToolUse` hook ([hooks/baseline.mjs](hooks/baseline.mjs)),
   before each agent edit of a listed file type:
   - copies the file to `.claude/agent-review/baseline/<path>` if there is no
     copy yet (an empty copy for a new file);
   - appends `{t, session, tool, before}` to
     `.claude/agent-review/history/<path>.jsonl`, a history of the agent's edits.
2. The VS Code extension ([vscode/](vscode/)) diffs each open file against its
   copy (line LCS, then word LCS inside changed lines), and against the text
   before the latest edit (last history line) to tell latest (bright) from
   earlier (dim).
3. Accept writes the change at the cursor into the copy; Accept all deletes the
   copy. The history stays.

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

2. Ignore the copies: add `.claude/agent-review/` to `.gitignore` (or to your
   global git ignore file).
3. Extension: `npm run package`, then install `dist/agent-review-<version>.vsix`
   (`code --install-extension …`, or Extensions view → Install from VSIX).

## Limits

- Latest vs earlier is decided per line.
- The preview works per block (no word marks there); a deleted table row is not
  shown in the preview.
- Every difference between the copy and the file is marked, including your own
  edits to the same file.
- The history stores the full text before each edit: small for documents.
- Plain O(n·m) LCS on the part between the common head and tail; fine for
  documents, slow for files with thousands of changed lines.

## Develop

```sh
npm install      # markdown-it, for the preview tests only
npm test         # hook, diff and preview tests (node:test)
npm run package  # builds dist/agent-review-<version>.vsix
```

## License

MIT
