// @ts-check
// "#140" in Go to File (Ctrl+P) or Go to Symbol in Workspace (Ctrl+T) lists the repo's GitHub
// issues from Imprimatur's tasks; picking one opens the issue's page in the GitHub Pull
// Requests extension, or in the browser without it. Typing "#" there searches workspace
// symbols, so the issues come in as symbols: the pick opens the issue and nothing else.
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

/** @param {vscode.ExtensionContext} ctx @param {() => string[]} roots @param {vscode.LogOutputChannel} [log] */
function registerIssueSymbols(ctx, roots, log) {
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
              new vscode.Location(vscode.Uri.file(path.join(root, "README.md")), new vscode.Position(0, 0)));
            // No range: VS Code calls resolveWorkspaceSymbol when it is picked, which opens the issue instead.
            s.location = /** @type {any} */ ({ uri: s.location.uri });
            urls.set(s, `${gh}/issues/${t.key.slice(1)}`);
            out.push(s);
          }
        }
        log?.info(`issue search "${query}": ${out.length} issues from ${roots().length} repos`);
        return out;
      },
      async resolveWorkspaceSymbol(s) {
        const url = urls.get(s);
        if (!url) return s;
        const target = vscode.extensions.getExtension(PR_EXTENSION) ? issueWebview(url) : vscode.Uri.parse(url);
        const ok = await vscode.env.openExternal(target);
        log?.info(`issue pick ${url}: opened ${target.toString(true)} → ${ok}`);
        // Quick Open would now go to the symbol's file; a cancellation stops that, and VS Code
        // drops a cancellation silently, so only the issue page opens.
        throw new vscode.CancellationError();
      },
    }),
  );
}

module.exports = { registerIssueSymbols };
