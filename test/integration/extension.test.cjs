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

  test("the launcher opens the panel's tabs; the seeded ask waits on Bende bekleyenler", async () => {
    const { launcher, panelState } = await api();
    assert.ok(launcher, "activate hands out the launcher");
    assert.deepEqual(launcher.getChildren().map((r) => r.command), ["imprimatur.openHome", "imprimatur.openTasks", "imprimatur.openInbox", "imprimatur.openGraph"]);
    for (const [command, tab] of [["imprimatur.openHome", "home"], ["imprimatur.openTasks", "tasks"], ["imprimatur.openInbox", "inbox"]]) {
      await vscode.commands.executeCommand(command);
      assert.equal(panelState().view.tab, tab, command);
    }
    // Other suites add asks of their own: find the seeded one.
    const deadline = Date.now() + 5000;
    while (!panelState().html.includes("Integration ask for the user") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(panelState().html.includes("Integration ask for the user"), "the seeded ask on Bende bekleyenler");
    assert.equal(panelState().root, process.env.IMPRIMATUR_IT_ROOT);
  });

  test("records.reveal opens the seeded task on Görevler", async () => {
    const { panelState } = await api();
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: process.env.IMPRIMATUR_IT_ROOT, task: "IT-1" });
    const s = panelState();
    assert.equal(s.view.tab, "tasks");
    assert.ok(s.view.sel, "a task selected");
    assert.ok(s.html.includes("Integration task"), "its page drawn");
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
