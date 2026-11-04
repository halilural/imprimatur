// @ts-check
// "#140" in Go to File (Ctrl+P) or Go to Symbol in Workspace (Ctrl+T) lists the repo's GitHub
// issues from Imprimatur's tasks; picking one opens the issue's page in the GitHub Pull
// Requests extension, or in the browser without it. Typing "#" there searches workspace
// symbols, so the issues come in as symbols: the pick opens the issue and leaves the cursor
// where it was.
"use strict";
const vscode = require("vscode");
const path = require("node:path");
const records = require("./records.js");
const { githubOf } = require("./tasks.js");
const { issueMatches } = require("./issue-match.js");

const PR_EXTENSION = "github.vscode-pull-request-github";

/** The PR extension's address that opens an issue's page. @param {string} url https://github.com/o/r/issues/n */
const issueWebview = (url) =>
  vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: PR_EXTENSION, path: "/open-issue-webview", query: new URLSearchParams({ uri: url }).toString() });

/** @param {vscode.ExtensionContext} ctx @param {() => string[]} roots */
function registerIssueSymbols(ctx, roots) {
  /** Where the cursor was, so a pick goes back there: Quick Open always moves to a location. */
  let last = vscode.window.activeTextEditor;
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => e && (last = e)));
  /** @type {WeakMap<vscode.SymbolInformation, string>} */
  const urls = new WeakMap();
  ctx.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query) {
        const db = records.dbOf();
        if (!db || !query.trim()) return [];
        const out = [];
        for (const root of roots()) {
          const gh = githubOf(root);
          const id = gh && records.repoId(root);
          if (!gh || !id) continue;
          for (const t of issueMatches(db.tasksOf(id, { limit: 2000 }), query)) {
            const s = new vscode.SymbolInformation(`${t.key} ${t.title}`, vscode.SymbolKind.Event, `${t.status} · ${path.basename(root)}`,
              new vscode.Location(last?.document.uri ?? vscode.Uri.file(path.join(root, "README.md")), new vscode.Position(0, 0)));
            // No range: VS Code calls resolveWorkspaceSymbol when it is picked.
            s.location = /** @type {any} */ ({ uri: s.location.uri });
            urls.set(s, `${gh}/issues/${t.key.slice(1)}`);
            out.push(s);
          }
        }
        return out;
      },
      async resolveWorkspaceSymbol(s) {
        const url = urls.get(s);
        if (url) await vscode.env.openExternal(vscode.extensions.getExtension(PR_EXTENSION) ? issueWebview(url) : vscode.Uri.parse(url));
        const ed = last && !last.document.isClosed ? last : undefined;
        s.location = ed ? new vscode.Location(ed.document.uri, ed.selection.active) : new vscode.Location(s.location.uri, new vscode.Position(0, 0));
        return s;
      },
    }),
  );
}

module.exports = { registerIssueSymbols };
