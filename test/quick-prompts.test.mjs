// Quick prompts: the repo's .claude/imprimatur.json "quickPrompts" become rows under one launcher row;
// a click runs imprimatur.launcher.prompt with the text. No list, no row.
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
class TreeItem {
  constructor(label, collapsibleState) {
    Object.assign(this, { label, collapsibleState });
  }
}
const vscodeStub = {
  EventEmitter: class { event = () => {}; fire() {} },
  TreeItem,
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  workspace: { workspaceFolders: [] },
};
const load = Module._load;
Module._load = function (r, ...a) {
  return r === "vscode" ? vscodeStub : load.call(this, r, ...a);
};
const { LauncherView } = req("../vscode/launcherView.js");
Module._load = load;

function repoWith(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-qp-"));
  if (config) {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify(config));
  }
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
}
const view = () => new LauncherView(() => ({ edits: 0, inbox: 0 }));
const top = (v) => v.getChildren().find((r) => r.id === "prompts");

test("quick prompts: one row per valid entry, a click sends its text; a slash command is a prompt too", () => {
  repoWith({ quickPrompts: [
    { label: "Push", text: "push et her şeyi" },
    { label: "Ponytail full", text: "/ponytail:ponytail full" },
    { label: "", text: "no label" },
    { label: "No text" },
    "bad",
  ] });
  const v = view();
  const row = top(v);
  assert.ok(row, "the row shows when the repo has prompts");
  assert.equal(v.getTreeItem(row).collapsibleState, 1);
  assert.equal(v.getTreeItem(row).command, undefined, "the group row itself does nothing");
  const kids = v.getChildren(row);
  assert.deepEqual(kids.map((k) => k.label), ["Push", "Ponytail full"]);
  const item = v.getTreeItem(kids[1]);
  assert.deepEqual(item.command, { command: "imprimatur.launcher.prompt", title: "Ponytail full", arguments: ["/ponytail:ponytail full"] });
  assert.equal(v.getParent(kids[0]).id, "prompts");
});

test("quick prompts: no row without a list, with an empty one, or with invalid JSON", () => {
  for (const config of [undefined, {}, { quickPrompts: [] }, { quickPrompts: "x" }]) {
    repoWith(config);
    assert.equal(top(view()), undefined, JSON.stringify(config));
  }
});
