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

  test("the launcher opens the panel's tabs; the seeded ask waits on Home", async () => {
    const { launcher, panelState } = await api();
    assert.ok(launcher, "activate hands out the launcher");
    assert.deepEqual(launcher.getChildren().map((r) => r.command), ["imprimatur.openHome", "imprimatur.openTasks", "imprimatur.openArchitecture", "imprimatur.openProduct", "imprimatur.openGlossary", "imprimatur.openGraph"]);
    // Home last: the seeded ask is looked for on it (what waits on the user is on Home).
    for (const [command, tab] of [["imprimatur.openHome", "home"], ["imprimatur.openTasks", "tasks"], ["imprimatur.openArchitecture", "architecture"], ["imprimatur.openProduct", "product"], ["imprimatur.openGlossary", "glossary"], ["imprimatur.openHome", "home"]]) {
      await vscode.commands.executeCommand(command);
      assert.equal(panelState().view.tab, tab, command);
    }
    // Other suites add asks of their own: find the seeded one.
    const deadline = Date.now() + 5000;
    while (!panelState().html.includes("Integration ask for the user") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(panelState().html.includes("Integration ask for the user"), "the seeded ask on Home");
    assert.equal(panelState().root, process.env.IMPRIMATUR_IT_ROOT);
  });

  test("records.reveal opens the seeded task on Tasks", async () => {
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

  test("#114: a burst of 20 tool calls builds the panel at most twice", async () => {
    const { panelState, watchChanged } = await api();
    await vscode.commands.executeCommand("imprimatur.openGraph");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + 10_000;
    while (!panelState().visible && Date.now() < deadline) await wait(100);
    assert.ok(panelState().visible, "the panel shows");
    const fs = require("node:fs");
    const base = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, ".claude", "imprimatur");
    for (const d of ["activity", "history", "pending"]) fs.mkdirSync(path.join(base, d), { recursive: true });
    await wait(3500); // earlier tests' redraws settle
    const before = panelState().builds;
    // What one tool call writes: an activity line, a pending file, process.json, open-edits.json;
    // every fifth an edit, with its history. Each write goes through the watcher's handler.
    const write = (rel, text) => {
      fs.writeFileSync(path.join(base, rel), text);
      watchChanged(path.join(base, rel));
    };
    for (let i = 0; i < 20; i++) {
      write(path.join("activity", "it-burst.jsonl"), "");
      write(path.join("pending", `it-${i}.json`), "{}");
      write("process.json", JSON.stringify({ i }));
      write("open-edits.json", JSON.stringify({ at: Date.now(), edits: 0 }));
      if (i % 5 === 0) write(path.join("history", "it-burst.md.jsonl"), "");
      await wait(50);
    }
    await wait(4000);
    const builds = panelState().builds - before;
    assert.ok(builds >= 1 && builds <= 2, `panel builds for the burst: ${builds}`);
  });
});
