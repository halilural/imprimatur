# Imprimatur

*Imprimatur* (Latin, "let it be printed"): the approval stamp.

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
- **✓ Accept** in the editor (CodeLens) per Markdown unit: a block that is all
  new (table, quote, list item, paragraph, heading, code, HTML, rule) is one
  unit, a changed line (e.g. a table cell) is its own; and on each
  changed block in the Markdown preview accepts that block; **Imprimatur:
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
  session, click a row for its diff. The description is what the agent said it
  was doing (or the Bash command's description); for older edits, the nearest
  heading and the first changed line. Your request is in the row's tooltip, the
  session column shows Claude's title for the conversation.
  A green ✓ marks edits with nothing left under review, an amber dot the rest:
  hover it for an Accept button (or right-click the row: Accept this edit, Open
  diff); hover the row to see its change (the popup stays while you move into
  it, and scrolls). The status bar's **Agent Graph** button opens it and shows
  how many asks wait on you.
- **Waiting on you**, the graph's second tab: everything the agent asked of
  you (questions, commands waiting for permission, "verify / test this" at the
  end of a turn), open ones first, with your answer once you reply. Click a row
  for "What you need to do" as a numbered list (full message folded below);
  right-click: Mark as done, Copy. The filter works on both tabs.

Setting `imprimatur.showIn`: Markdown files are marked only in the preview by
default (`preview`); `both` adds the editor marks and its ✓ Accept lenses,
`editor` uses the editor only. Other file types are always marked in the editor.
`imprimatur.editorAlsoFor` (globs, e.g. `["**/todos/**"]`) adds the editor
marks for matching Markdown files while `showIn` stays `preview`.

The Markdown preview also gets thin marks over its scrollbar, like the editor's
overview ruler: one colored tick
per change (green added, blue changed, red old or deleted),
click a tick to jump there.

With `imprimatur.mermaidDiff` on (off by default; two Mermaid preview
extensions in one window can then fail to render), changed Mermaid flowcharts
are colored in the preview like a visual diff: new
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
   - copies the file to `.claude/imprimatur/baseline/<path>` if there is no
     copy yet (an empty copy for a new file);
   - appends `{t, session, tool, prompt, before}` to
     `.claude/imprimatur/history/<path>.jsonl`, a history of the agent's edits.
2. The VS Code extension ([vscode/](vscode/)) diffs each open file against its
   copy (line LCS, then word LCS inside changed lines). Every change looks the
   same, whichever agent edit made it; the edit history keeps the order.
3. Accept writes the change at the cursor into the copy; Accept all deletes the
   copy. The history stays.
4. A second hook ([hooks/waiting.mjs](hooks/waiting.mjs)) appends what the
   agent waits on you for to `.claude/imprimatur/waiting/<session>.jsonl`:
   AskUserQuestion, PermissionRequest, input notifications, and the lines of
   the final message that ask something (a `?`, or phrases like "test et",
   "please verify", "shall I"). Any later event in the session closes the
   earlier items; your next prompt is kept as the answer.

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
           "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/path/to/imprimatur/hooks/baseline.mjs md mdx" }]
         }
       ],
       "PostToolUse": [
         {
           "matcher": "Bash",
           "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/path/to/imprimatur/hooks/baseline.mjs md mdx" }]
         }
       ]
     }
   }
   ```

   For the **Waiting on you** tab, also run `hooks/waiting.mjs` (no
   arguments) on `PreToolUse` and `PostToolUse` with matcher `AskUserQuestion`,
   on `PermissionRequest`, `Stop` and `UserPromptSubmit`, and on `Notification`
   with matcher `agent_needs_input|elicitation_dialog|elicitation_url_dialog`.

2. Ignore the copies: add `.claude/imprimatur/` to `.gitignore` (or to your
   global git ignore file).
3. Extension: `npm run package`, then install `dist/imprimatur-<version>.vsix`
   (`code --install-extension …`, or Extensions view → Install from VSIX).

## Limits

- No marks in diff tabs (e.g. Working Tree): git already colors those.
- Bash edits are seen only for files named in the command; a glob
  (`sed -i *.md`) is missed.
- Ordered list numbers are not compared: deleting an item does not mark the
  renumbered items after it.
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
npm run package  # builds dist/imprimatur-<version>.vsix
```

## License

MIT
