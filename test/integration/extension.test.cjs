// Runs inside a real VS Code extension host (#68), started by @vscode/test-cli
// from .vscode-test.mjs: a temp git repo is the workspace and IMPRIMATUR_DB a
// temp database seeded with a repo row, a task and an open owner-K record.
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const ID = "halilural.imprimatur";
const manifest = require(path.join(__dirname, "..", "..", "vscode", "package.json"));
const contributed = manifest.contributes.commands.map((c) => c.command);

/** The extension's exports, activating it if it is not yet. */
async function api() {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, `${ID} is loaded`);
  return ext.isActive ? ext.exports : ext.activate();
}

/** Every node of a tree data provider, depth first. @param {any} provider @param {any} [node] */
function walk(provider, node) {
  return provider.getChildren(node).flatMap((child) => [child, ...walk(provider, child)]);
}

suite("Imprimatur in the extension host", () => {
  test("activates", async () => {
    const exports = await api();
    assert.ok(vscode.extensions.getExtension(ID).isActive);
    assert.equal(typeof exports.extendMarkdownIt, "function");
  });

  test("registers its contributed commands", async () => {
    await api();
    const have = new Set(await vscode.commands.getCommands(true));
    const wanted = ["imprimatur.openGraph", "imprimatur.processOn", "imprimatur.importMarkdown", ...contributed.filter((c) => c.startsWith("imprimatur.records."))];
    assert.ok(wanted.length > 5, "the manifest lists records commands");
    assert.deepEqual(wanted.filter((c) => !have.has(c)), []);
  });

  test("every command in the manifest is registered", async () => {
    await api();
    const have = new Set(await vscode.commands.getCommands(true));
    assert.deepEqual(contributed.filter((c) => !have.has(c)), []);
  });

  test("the records views show the seeded task and the open ask", async () => {
    const { recordViews } = await api();
    assert.ok(recordViews, "activate hands out the records views");
    await vscode.commands.executeCommand("imprimatur.records.refresh");
    const root = process.env.IMPRIMATUR_IT_ROOT;

    const asks = recordViews.asks.getChildren();
    // Other suites add asks of their own: find the seeded one.
    const ask = asks.find((n) => n.type === "record" && n.record.title === "Integration ask for the user");
    assert.ok(ask, `an ask, got ${JSON.stringify(asks.map((n) => n.text ?? n.id))}`);
    assert.equal(ask.record.title, "Integration ask for the user");
    assert.equal(ask.record.owner, "K");
    assert.equal(ask.repo.root, root);
    assert.equal(recordViews.asks.getTreeItem(ask).label, "Integration ask for the user");

    const tasks = walk(recordViews.tasks);
    const task = tasks.find((n) => n.type === "task" && n.task.key === "IT-1");
    assert.ok(task, "the task under its repo");
    assert.equal(task.task.key, "IT-1");
    assert.equal(task.repo.root, root);
    assert.ok(tasks.some((n) => n.type === "record" && n.record.title === "Integration ask for the user"));

    const questions = walk(recordViews.questions);
    assert.ok(questions.some((n) => n.type === "record" && n.record.kind === "question"));
  });

  test("records.reveal finds the seeded task", async () => {
    await api();
    // Shows the Tasks view and selects the task's records; it must not throw.
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: process.env.IMPRIMATUR_IT_ROOT, task: "IT-1" });
  });

  test("opens the Agent Change Graph", async () => {
    await api();
    await vscode.commands.executeCommand("imprimatur.openGraph");
    const deadline = Date.now() + 10_000;
    /** @returns {vscode.Tab | undefined} */
    const graphTab = () =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("imprimatur.graph"));
    while (!graphTab() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(graphTab(), "a graph webview tab");
  });
});
