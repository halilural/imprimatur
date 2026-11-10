// Records in a real extension host (#71, #202): the new panel follows the database, a write from
// another process (as the MCP server or a hook) shows within 500 ms, and the backstop poll runs
// only while the panel is visible. Each test seeds its own task through a second connection.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const ID = "halilural.imprimatur";
const EXT = path.join(__dirname, "..", "..", "vscode");
const { openDb } = require(path.join(EXT, "db.js"));
const ROOT = process.env.IMPRIMATUR_IT_ROOT;
const AGENT = { kind: "agent", id: "claude-code:it-session" };

/** The extension's exports, activating it if it is not yet. */
async function api() {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, `${ID} is loaded`);
  return ext.isActive ? ext.exports : ext.activate();
}

/** A second connection to the test database, closed after fn. @template T @param {(db: any) => T} fn @returns {T} */
function withDb(fn) {
  const db = openDb({ path: process.env.IMPRIMATUR_DB });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** A fresh task in the workspace repo with these records. @param {string} key @param {object} task @param {object[]} [list] */
function seedTask(key, task, list = []) {
  return withDb((db) => {
    const repo = db.repoOf(ROOT);
    const t = db.upsertTask(repo.id, key, task);
    const recs = list.map((r) => db.addRecord(t.id, r, AGENT));
    return { repo, task: t, records: recs };
  });
}

/** Polls until fn returns something truthy. @template T @param {() => T} fn @param {string} what */
async function until(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite("The new panel follows the database (#71, #202)", () => {
  test("#71 the 500 ms backstop runs only while the panel is visible", async () => {
    const { appState, backstop } = await api();
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: ROOT, task: "IT-1" });
    await until(() => appState().visible, "the panel visible");
    await until(() => backstop.running, "the backstop running");
    // Another editor in the panel's column hides it.
    const doc = await vscode.workspace.openTextDocument({ content: "hide the panel" });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
    await until(() => !appState().visible, "the panel hidden");
    await until(() => !backstop.running, "the backstop stopped");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await vscode.commands.executeCommand("imprimatur.records.reveal", { root: ROOT, task: "IT-1" });
    await until(() => appState().visible && backstop.running, "running again once visible");
  });

  test("#71 a record written by another process is on the panel within 500 ms (measured)", async () => {
    const { appState } = await api();
    const { spawn } = require("node:child_process");
    const { task } = seedTask("IT-71", { title: "Live panel", status: "active" }, [{ kind: "todo", owner: "C", title: "Existing" }]);
    await vscode.commands.executeCommand("imprimatur.app.open", { root: ROOT, area: "tasks", task: "IT-71", tab: "records" });
    await until(() => appState().at.task === "IT-71", "the panel on IT-71");
    await until(() => appState().html.includes("Live panel"), "IT-71's page drawn");
    // Another process (as the MCP server or a hook): it prints the time right after its commit.
    const child = `const {openDb}=require(${JSON.stringify(path.join(EXT, "db.js"))});const db=openDb({path:process.env.IMPRIMATUR_DB});` +
      `db.addRecord(${task.id},{kind:"note",title:process.argv[1]},{kind:"agent",id:"it-71"});process.stdout.write(String(Date.now()));db.close();`;
    /** @param {string} title @returns {Promise<number>} the commit time */
    const writeElsewhere = (title) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["-e", child, title], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (code === 0 && out ? resolve(Number(out)) : reject(new Error(`writer exited ${code}: ${err}`))));
    });
    const took = [];
    for (let i = 0; i < 5; i++) {
      const title = `Live note ${i} ${Date.now()}`;
      const committed = writeElsewhere(title);
      const deadline = Date.now() + 5000;
      while (!appState().html.includes(title)) {
        if (Date.now() > deadline) assert.fail(`note ${i} not drawn within 5 s`);
        await new Promise((r) => setTimeout(r, 2));
      }
      took.push(Date.now() - (await committed));
      await new Promise((r) => setTimeout(r, 120));
    }
    const sorted = [...took].sort((a, b) => a - b);
    console.log(`      #71 local latency, commit in another process → panel page posted: ${took.join(", ")} ms (median ${sorted[2]} ms)`);
    for (const ms of took) assert.ok(ms < 500, `under 500 ms, took ${ms} ms`);
  });
});
