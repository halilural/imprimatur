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
  /**
   * What a pick opens: the task on the panel's Tasks tab (#160), or the issue's page.
   * @type {WeakMap<vscode.SymbolInformation, {task: string, root: string} | {url: string}>}
   */
  const targets = new WeakMap();
  /** A row that Quick Open does not navigate: no range, so resolveWorkspaceSymbol runs on pick. */
  const row = (/** @type {string} */ name, /** @type {vscode.SymbolKind} */ kind, /** @type {string} */ container, /** @type {string} */ root) => {
    const s = new vscode.SymbolInformation(name, kind, container, new vscode.Location(vscode.Uri.file(path.join(root, "README.md")), new vscode.Position(0, 0)));
    s.location = /** @type {any} */ ({ uri: s.location.uri });
    return s;
  };
  ctx.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query) {
        const db = records.dbOf();
        if (!db || !query.trim()) return [];
        const out = [];
        for (const root of roots()) {
          const id = records.repoId(root);
          if (!id) continue;
          const gh = githubOf(root);
          const repo = path.basename(root);
          for (const t of issueMatches(db.tasksOf(id, { limit: 2000 }), query)) {
            // First the task in Imprimatur (#160), then, with a GitHub remote, the issue's page.
            const task = row(`${t.key} ${t.title}`, vscode.SymbolKind.Object, `Imprimatur task · ${t.status} · ${repo}`, root);
            targets.set(task, { task: t.key, root });
            out.push(task);
            if (gh && /^#\d+$/.test(t.key)) {
              const issue = row(`${t.key} ${t.title}`, vscode.SymbolKind.Event, `GitHub issue · ${repo}`, root);
              targets.set(issue, { url: `${gh}/issues/${t.key.slice(1)}` });
              out.push(issue);
            }
          }
        }
        log?.info(`issue search "${query}": ${out.length} rows from ${roots().length} repos`);
        return out;
      },
      async resolveWorkspaceSymbol(s) {
        const to = targets.get(s);
        if (!to) return s;
        if ("task" in to) {
          await vscode.commands.executeCommand("imprimatur.records.reveal", { root: to.root, task: to.task });
          log?.info(`task pick ${to.task} in ${to.root}`);
          throw new vscode.CancellationError();
        }
        const url = to.url;
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
