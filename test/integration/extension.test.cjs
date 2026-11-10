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

  test("the old panel's commands open the new panel at their area; the seeded task is on Home (#202)", async () => {
    const { appState } = await api();
    for (const [command, area] of [["imprimatur.openGraph", "edits"], ["imprimatur.openTasks", "tasks"], ["imprimatur.openGlossary", "docs"], ["imprimatur.openMeetings", "meetings"], ["imprimatur.openHome", "home"]]) {
      await vscode.commands.executeCommand(command);
      assert.equal(appState().at.area, area, command);
    }
    assert.ok(appState().open && appState().visible);
    const deadline = Date.now() + 5000;
    while (!appState().html.includes("Integration task") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(appState().html.includes("Integration task"), "the seeded task on Home");
  });

  test("records.reveal opens the seeded task's page", async () => {
    const { appState } = await api();
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: process.env.IMPRIMATUR_IT_ROOT, task: "IT-1" });
    assert.equal(appState().at.area, "tasks");
    assert.equal(appState().at.task, "IT-1");
    assert.ok(appState().html.includes("Integration task"), "its page drawn");
  });
});
