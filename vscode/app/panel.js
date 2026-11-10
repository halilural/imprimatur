// @ts-check
// The new Imprimatur panel in VS Code (#195): one webview, re-rendered from app/model.js on every move.
"use strict";
const crypto = require("node:crypto");
const vscode = require("vscode");
const records = require("../records.js");

/** @type {vscode.WebviewPanel | undefined} */ let panel;
/** @type {{root?: string, area?: string, doc?: string, scope?: string}} */ let at = {};

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
      at = { ...at, area: msg.area, doc: msg.doc, scope: msg.scope };
      render();
    } else if (msg?.type === "task") {
      vscode.commands.executeCommand("imprimatur.records.reveal", { root: repoFor(at.root)?.root, task: String(msg.key) });
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

module.exports = { registerApp, openApp };
