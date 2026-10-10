// Design documents (#72) in a real extension host: the Mimari and Ürün tabs render
// from the database, a section edited from the page round-trips (written as the
// user, drawn again), the deep link lights a section, and the Markdown export
// writes docs/ARCHITECTURE.md into the workspace repo.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const ID = "halilural.imprimatur";
const EXT = path.join(__dirname, "..", "..", "vscode");
const { openDb } = require(path.join(EXT, "db.js"));
const ROOT = process.env.IMPRIMATUR_IT_ROOT;
const AGENT = { kind: "agent", id: "claude-code:it-docs" };

async function api() {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, `${ID} is loaded`);
  return ext.isActive ? ext.exports : ext.activate();
}

/** @template T @param {(db: any) => T} fn @returns {T} */
function withDb(fn) {
  const db = openDb({ path: process.env.IMPRIMATUR_DB });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function until(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite("Design documents on the Imprimatur panel (#72)", () => {
  test("Mimari and Ürün render; a section edit round-trips; the deep link; the export", async () => {
    const { panelState, panelMessage, launcher } = await api();
    const { section, adr } = withDb((db) => {
      const repo = db.repoOf(ROOT);
      const task = db.upsertTask(repo.id, "IT-72", { title: "Docs", status: "active" });
      const adr = db.addRecord(task.id, { kind: "adr", title: "SQLite is the source of truth" }, AGENT);
      const doc = db.docOf(repo.id, "architecture");
      const section = db.upsertSection(doc.id, "storage", { title: "Storage", body: "**SQLite** in WAL mode.", addRecords: [adr.id] }, AGENT);
      return { section, adr };
    });
    assert.deepEqual(launcher.getChildren().map((r) => r.id).slice(3, 5), ["architecture", "product"], "launcher rows after Bende bekleyenler");

    await vscode.commands.executeCommand("imprimatur.openArchitecture");
    await until(() => panelState().view.tab === "architecture" && panelState().html.includes('id="sec-storage"'), "the Mimari tab drawn");
    const html = panelState().html;
    assert.match(html, /<button data-tab="inbox">[^]*<button data-tab="architecture">Mimari<\/button><button data-tab="product">Ürün<\/button><button data-tab="edits">/);
    assert.match(html, /<strong>SQLite<\/strong> in WAL mode\./);
    assert.ok(html.includes(`data-act="showRecord" data-id="${adr.id}"`), "the contributing ADR as a chip");
    // ```mermaid blocks: the page may load the extension's own mermaid (dist/), by the nonce or the webview's cspSource, nothing else.
    const csp = html.match(/Content-Security-Policy" content="([^"]*)"/)[1];
    assert.match(csp, /^default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-[0-9a-f]*'( 'self')? https:\/\/[^;' ]+; form-action 'none'; base-uri 'none';$/, csp);
    const src = html.match(/<meta name="imprimatur-mermaid" content="([^"]+)">/)?.[1];
    assert.match(src ?? "", /^https:\/\/.+\/dist\/mermaid\.min\.js$/, "mermaid from the extension's dist/");
    assert.ok(fs.existsSync(path.join(EXT, "dist", "mermaid.min.js")), "the build put mermaid next to the bundle");

    // Düzenle → the editor; Kaydet → written as the user, drawn again.
    panelMessage({ type: "view", view: { tab: "architecture", edit: `architecture:${section.id}` } });
    await until(() => panelState().html.includes(`data-draft="doc-architecture-${section.id}"`), "the editor open");
    panelMessage({ type: "docSave", kind: "architecture", id: section.id, title: "Storage", body: "SQLite, WAL, one file per device." });
    panelMessage({ type: "view", view: { tab: "architecture", edit: null } });
    const saved = withDb((db) => ({ s: db.sectionById(section.id), v: db.sectionVersions(section.id)[0] }));
    assert.equal(saved.s.body, "SQLite, WAL, one file per device.");
    assert.equal(saved.v.actor_kind, "user");
    await until(() => panelState().html.includes("SQLite, WAL, one file per device.") && !panelState().html.includes("<textarea data-draft=\"doc-architecture"), "the saved section drawn");

    // Yeni bölüm from the page.
    panelMessage({ type: "docNew", kind: "architecture", title: "Dışa aktarma", body: "2 s sonra." });
    await until(() => panelState().html.includes('id="sec-disa-aktarma"'), "the new section drawn");

    // Ürün: empty, with the text saying the agent fills it.
    await vscode.commands.executeCommand("imprimatur.openProduct");
    await until(() => panelState().view.tab === "product" && panelState().html.includes("bir PDR ya da karar"), "the Ürün tab's empty state");

    // Deep link: Mimari, the section lit.
    await vscode.commands.executeCommand("imprimatur.docs.reveal", { root: ROOT, kind: "architecture", section: "storage" });
    await until(() => panelState().view.docFlash === "storage" && panelState().html.includes('class="dsec flash" id="sec-storage"'), "the section lit");

    // The export (debounced 2 s after the database's change).
    const file = path.join(ROOT, "docs", "ARCHITECTURE.md");
    await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("## 2. Dışa aktarma"), "docs/ARCHITECTURE.md written", 8000);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith("<!-- Generated by Imprimatur from its database"));
    assert.match(text, /_Katkı veren kayıtlar: ADR · SQLite is the source of truth \(IT-72\)_/);
  });
});
