# agent-review

See what an AI coding agent changed in your docs, right in the editor, like
tracked changes in a word processor, until you accept it. Git is not involved:
staging or committing does not clear the marks.

- Added lines get a green background.
- A changed line where only one word changed marks that word: the new word
  highlighted, the old one in a red box next to it. When more than one word
  changed, the old sentence is shown above the line (a CodeLens: the editor API
  cannot insert a real line) and the new line is highlighted.
- A deleted block shows a red marker on the line before it; hover to read it.
- Marks in the overview ruler, a change count in the status bar.
- **✓ Accept** above each change block in the editor (CodeLens) and on each
  changed block in the Markdown preview accepts that block; **Agent Review:
  Accept Agent Change at Cursor** and **Accept All Agent Changes in File** do
  the same from the command palette. After an accept the view moves to the
  next change, like a review queue.
- Old text is shown as plain text in a red box (no strike line, so it stays
  readable); in the preview it is rendered as Markdown.
- A status bar button, **N agent edits**, lists the agent's edits to the file
  newest first, like a commit log; pick one to open its diff (before / after),
  or **All changes under review**. It stays after Accept all.
- **Agent Change Graph** (from that list, or the command palette): every agent
  edit in the repo as a table like Git Graph, one colored lane per Claude
  session, the user's request that led to each edit, click a row for its diff.

Setting `agentReview.showIn`: Markdown files are marked only in the preview by
default (`preview`); `both` adds the editor marks and its ✓ Accept lenses,
`editor` uses the editor only. Other file types are always marked in the editor.
`agentReview.editorAlsoFor` (globs, e.g. `["**/todos/**"]`) adds the editor
marks for matching Markdown files while `showIn` stays `preview`.

The Markdown preview also gets thin marks over its scrollbar, like the editor's
overview ruler: one colored tick
per change (green added, blue changed, red old or deleted),
click a tick to jump there.

Changed Mermaid flowcharts are colored in the preview like a visual diff: new
nodes and arrows green, changed labels orange, removed ones red and dashed
(kept visible), with a legend and an Accept button above the diagram.

The Markdown preview shows the same changes per block: changed blocks are
colored, their old text struck through right above them, deleted lines struck
through where they were.

## How it works

1. A Claude Code hook ([hooks/baseline.mjs](hooks/baseline.mjs)), before each
   agent edit of a listed file type (Edit, Write, or a Bash command that names
   the file, e.g. a python or sed edit; Bash is compared before/after so read-only
   commands leave no trace):
   - copies the file to `.claude/agent-review/baseline/<path>` if there is no
     copy yet (an empty copy for a new file);
   - appends `{t, session, tool, prompt, before}` to
     `.claude/agent-review/history/<path>.jsonl`, a history of the agent's edits.
2. The VS Code extension ([vscode/](vscode/)) diffs each open file against its
   copy (line LCS, then word LCS inside changed lines). Every change looks the
   same, whichever agent edit made it; the edit history keeps the order.
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
           "matcher": "Edit|Write|Bash",
           "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/path/to/agent-review/hooks/baseline.mjs md mdx" }]
         }
       ],
       "PostToolUse": [
         {
           "matcher": "Bash",
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

- No marks in diff tabs (e.g. Working Tree): git already colors those.
- Bash edits are seen only for files named in the command; a glob
  (`sed -i *.md`) is missed.
- Changes inside fenced code blocks (``` or ~~~) are not marked; the edit
  history still lists them.
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
