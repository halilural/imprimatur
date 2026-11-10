// @ts-check
// The new Imprimatur panel in VS Code (#195): one webview, re-rendered from app/model.js on every move.
"use strict";
const crypto = require("node:crypto");
const vscode = require("vscode");
const records = require("../records.js");

/** @type {vscode.WebviewPanel | undefined} */ let panel;
/** @type {{root?: string, area?: string, doc?: string, scope?: string, task?: string, tab?: string}} */ let at = {};

/** The repo to show: the one asked for, else the first folder of this window that Imprimatur knows. @param {string} [root] */
function repoFor(root) {
  const db = records.dbOf();
  if (!db) return undefined;
  const roots = [root, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)].filter(Boolean);
  for (const r of roots) {
    const repo = db.repoByRoot(/** @type {string} */ (r));
    if (repo) return { db, repo, root: /** @type {string} */ (r) };
  }
  const first = db.repos()[0];
  return first ? { db, repo: first, root: first.root } : undefined;
}

function render() {
  if (!panel) return;
  const got = repoFor(at.root);
  if (!got) {
    panel.webview.html = "<!doctype html><body style='font-family:var(--vscode-font-family);padding:24px'>Imprimatur has no repo yet: open a folder with a git repo.</body>";
    return;
  }
  const { appModel } = require("./model.js");
  const { appHtml } = require("./html.js");
  const { renderMarkdown } = require("../docsView.js");
  const m = appModel(got.db, got.repo, got.root, at);
  panel.title = `Imprimatur · ${m.repo.name}`;
  panel.webview.html = appHtml(m, { nonce: crypto.randomBytes(16).toString("hex"), cspSource: panel.webview.cspSource, render: (md) => renderMarkdown(md) });
}

/**
 * Approves a spec's gate (#197): a decision record on the task with links.gate, by the user.
 * @param {string} key @param {string} gate
 */
function approveGate(key, gate) {
  const got = repoFor(at.root);
  const { GATES } = require("./model.js");
  const g = GATES.find((/** @type {any} */ x) => x.id === gate);
  const task = got && g && got.db.taskByKey(got.repo.id, key);
  if (!task) return;
  got.db.addRecord(task.id, { kind: "decision", status: "done", title: `Approved: ${g.label}`, links: { gate } }, { kind: "user", id: "panel" });
}

/**
 * Writes a section from the panel (#198) the way the agent's doc_section_upsert does: db.upsertSection,
 * here as the user. A new section gets a key from its title.
 * @param {any} msg {kind, scope?, key?, isNew, title, body, chapter?}
 */
function saveSection(msg) {
  const got = repoFor(at.root);
  if (!got) return;
  const { db, repo } = got;
  const kinds = ["project", "glossary", "out-of-scope", "capability", "social"];
  if (!kinds.includes(msg.kind)) throw new Error(`${msg.kind} is not edited here`);
  const doc = msg.kind === "capability" ? db.taskDocOf(repo.id, String(msg.scope), "capability") : db.docOf(repo.id, msg.kind);
  const title = String(msg.title ?? "").trim();
  if (!title) throw new Error("a section needs a title");
  const key = msg.isNew ? require("../decisions.js").slug(title).slice(0, 64) : String(msg.key);
  if (msg.isNew && db.docSection(doc.id, key)) throw new Error(`there is already a section "${key}"`);
  db.upsertSection(doc.id, key, { title, body: String(msg.body ?? "") || null, ...(msg.isNew && msg.chapter && { chapter: String(msg.chapter) }) }, { kind: "user", id: "panel" });
}

/** Opens the panel (or brings it forward) at a place. @param {{root?: string, area?: string, doc?: string, scope?: string}} [to] */
function openApp(to = {}) {
  at = { ...at, ...to };
  if (panel) {
    panel.reveal();
    return render();
  }
  panel = vscode.window.createWebviewPanel("imprimatur.app", "Imprimatur", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
  panel.onDidDispose(() => (panel = undefined));
  panel.webview.onDidReceiveMessage((/** @type {any} */ msg) => {
    if (msg?.type === "go") {
      at = { ...at, area: msg.area, doc: msg.doc, scope: msg.scope, task: msg.task, tab: msg.tab };
      render();
    } else if (msg?.type === "task") {
      at = { ...at, area: "tasks", task: String(msg.key), tab: undefined };
      render();
    } else if (msg?.type === "save") {
      try {
        saveSection(msg);
      } catch (e) {
        vscode.window.showErrorMessage(`Imprimatur: ${/** @type {Error} */ (e).message}`);
      }
      render();
    } else if (msg?.type === "file") {
      // An agent's edited file: opened in the editor, where its changes are marked to accept or undo.
      const got = repoFor(at.root);
      const rel = String(msg.file);
      if (got && !rel.split("/").includes("..")) vscode.window.showTextDocument(vscode.Uri.file(require("node:path").join(got.root, rel)));
    } else if (msg?.type === "ex") {
      // An exercise's step ticked, skipped, noted; an exercise dropped or resumed; a recall graded.
      const x = require("../exerciseView.js");
      const db = records.dbOf();
      try {
        if (!db || !x.EXERCISE_MESSAGES.includes(msg.act)) throw new Error(`unknown exercise action ${msg.act}`);
        x.applyExerciseMessage(db, { type: msg.act, id: msg.id, status: msg.status, result: msg.result, text: msg.text });
      } catch (e) {
        vscode.window.showErrorMessage(`Imprimatur: ${/** @type {Error} */ (e).message}`);
      }
      render();
    } else if (msg?.type === "gate") {
      approveGate(String(msg.key), String(msg.gate));
      render();
    } else if (msg?.type === "cmd" && typeof msg.command === "string" && msg.command.startsWith("imprimatur.")) {
      vscode.commands.executeCommand(msg.command);
    }
  });
  render();
}

/** @param {vscode.ExtensionContext} ctx */
function registerApp(ctx) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("imprimatur.app.open", (/** @type {any} */ to) => openApp(to && typeof to === "object" ? to : {})),
  );
}

module.exports = { registerApp, openApp, approveGate, saveSection };
