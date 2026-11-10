// @ts-check
// The Current File view (#200, after Swimm): what the agent did, decided and documented about the
// file open in the editor: its edits (the Agent Change Graph's rows for it), the records that name
// it (ADRs and decisions first), and the document sections read from it. Newest first.
"use strict";
const path = require("node:path");

/**
 * The view's items for a file. Pure: the database, the repo, the file and the graph rows in.
 * @param {any} db @param {number} repoId @param {string} rel the file, relative to the repo
 * @param {any[]} rows graph.js graphRows(root).rows
 */
function currentFileModel(db, repoId, rel, rows) {
  const like = `%"${rel.replace(/[\\%_"]/g, (c) => `\\${c}`)}"%`;
  const records = db.q(`SELECT r.id, r.kind, r.title, r.status, r.updated_at, t.key AS task_key FROM records r JOIN tasks t ON t.id = r.task_id
                        WHERE t.repo_id = ? AND r.status <> 'dropped' AND r.links LIKE ? ESCAPE '\\' ORDER BY r.updated_at DESC LIMIT 40`).all(repoId, like);
  // Decisions first: they are why the file is the way it is.
  const rank = (/** @type {string} */ k) => (k === "adr" ? 0 : k === "decision" || k === "pdr" ? 1 : 2);
  records.sort((/** @type {any} */ a, /** @type {any} */ b) => rank(a.kind) - rank(b.kind) || b.updated_at - a.updated_at);
  const sections = db.q(`SELECT s.key, s.title, d.kind AS doc_kind, d.scope FROM doc_sections s JOIN documents d ON d.id = s.doc_id
                         WHERE d.repo_id = ? AND s.status = 'current' AND s.source = ? ORDER BY s.updated_at DESC LIMIT 20`).all(repoId, rel);
  const edits = rows.filter((r) => r.file === rel).sort((a, b) => String(b.t).localeCompare(String(a.t))).slice(0, 30)
    .map((r) => ({ t: r.t, what: r.summary || r.intent || r.prompt || r.tool || "edit", accepted: !!r.accepted }));
  return { file: rel, edits, records, sections };
}

/** @param {import("vscode").ExtensionContext} ctx */
function registerCurrentFile(ctx) {
  const vscode = require("vscode");
  const records = require("./records.js");
  const emitter = new vscode.EventEmitter();
  /** @type {ReturnType<typeof currentFileModel> | undefined} */ let model;
  /** @type {string | undefined} */ let root;

  const refresh = () => {
    model = undefined;
    const doc = vscode.window.activeTextEditor?.document;
    const db = records.dbOf();
    if (doc?.uri.scheme === "file" && db) {
      const { repoRootOf } = require("./config.js");
      root = repoRootOf(path.dirname(doc.uri.fsPath));
      const repo = db.repoByRoot(root);
      if (repo) {
        let rows = [];
        try {
          rows = require("./graph.js").graphRows(root).rows;
        } catch {}
        model = currentFileModel(db, repo.id, path.relative(root, doc.uri.fsPath).split(path.sep).join("/"), rows);
      }
    }
    emitter.fire(undefined);
  };

  const provider = {
    onDidChangeTreeData: emitter.event,
    /** @param {any} e */
    getTreeItem: (e) => e,
    /** @param {any} [parent] */
    getChildren: (parent) => {
      if (!model) return [new vscode.TreeItem("Open a file of a repo Imprimatur knows")];
      const m = model;
      if (!parent) {
        const group = (/** @type {string} */ id, /** @type {string} */ label, /** @type {number} */ n, /** @type {string} */ icon) => Object.assign(new vscode.TreeItem(`${label} · ${n}`, n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None), { id: `cf-${id}`, group: id, iconPath: new vscode.ThemeIcon(icon) });
        return [group("records", "Decisions and records", m.records.length, "law"), group("edits", "Agent edits", m.edits.length, "git-merge"), group("sections", "Documented in", m.sections.length, "book")];
      }
      if (parent.group === "records") {
        return m.records.map((/** @type {any} */ r) => Object.assign(new vscode.TreeItem(r.title.slice(0, 120)), {
          description: `${r.task_key} · ${r.kind}`, tooltip: r.title, iconPath: new vscode.ThemeIcon(r.kind === "adr" ? "law" : "note"),
          command: { command: "imprimatur.records.reveal", title: "Open", arguments: [{ root, record: r.id }] },
        }));
      }
      if (parent.group === "edits") {
        return m.edits.map((/** @type {any} */ e) => Object.assign(new vscode.TreeItem(String(e.what).replace(/\s+/g, " ").slice(0, 120)), {
          description: String(e.t).slice(0, 16).replace("T", " "), iconPath: new vscode.ThemeIcon(e.accepted ? "check" : "circle-outline"),
          command: { command: "imprimatur.openGraph", title: "Review" },
        }));
      }
      return m.sections.map((/** @type {any} */ s) => Object.assign(new vscode.TreeItem(s.title), {
        description: `${s.doc_kind}${s.scope ? ` ${s.scope}` : ""}`,
        command: { command: "imprimatur.app.open", title: "Open", arguments: [{ root, area: "docs" }] },
      }));
    },
  };
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("imprimatur.currentFile", provider),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidSaveTextDocument(refresh),
  );
  refresh();
}

module.exports = { currentFileModel, registerCurrentFile };
