// Görev analizleri's tree (#97): file › "##" sections › "###" headings; titles people can read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { plainTitle, titleParts, subHeads, analysisHubHtml } = req("../vscode/tasksView.js");

test("titles: the key and the comma after it, emphasis, two languages", () => {
  assert.equal(plainTitle("LATD-13473, Business System Message JTA transaction refactoring", "LATD-13473"), "Business System Message JTA transaction refactoring");
  assert.equal(plainTitle("**Bold** and `code` and *it*"), "Bold and code and it");
  assert.equal(plainTitle("section_reads and doc_versions"), "section_reads and doc_versions", "snake_case kept");
  assert.deepEqual(titleParts("Background / *Arka plan*"), { main: "Background", alt: "Arka plan" });
  assert.deepEqual(titleParts("Plain"), { main: "Plain" });
  assert.deepEqual(subHeads("### Goal / *Hedef*\ntext\n```\n### not a heading\n```\n### Retry ###"), ["Goal / *Hedef*", "Retry"]);
});

test("the tree: the file's title over its sections over their headings; its own contents out of the tree", () => {
  const html = analysisHubHtml({
    repo: { id: 1, name: "r" }, orphans: [], tasks: [],
    docs: [{ key: "LATD-1", at: 1, task: { id: 9, title: "LATD-1, Refactor it", status: "active" }, files: [{ source: "docs/a.md", local: false, sections: [
      { id: 1, key: "a--overview", title: "Transaction map / *Harita*", body: "intro" },
      { id: 2, key: "a--contents", title: "Contents / *İçindekiler*", body: "- [Background](#background)" },
      { id: 3, key: "a--background", title: "Background / *Arka plan*", body: "### Goal / *Hedef*\nx\n### Retry\ny" },
    ] }] }],
  });
  const toc = /<ol class="atoc"[^>]*>([\s\S]*?)<\/ol><\/li><\/ol>/.exec(html)?.[0] ?? "";
  assert.match(toc, /<li class="afile"[^>]*><a href="#sec-a1"[^>]*>Transaction map <span class="talt">· Harita<\/span><\/a>/);
  assert.match(toc, /<ol class="asub"><li data-k="t3"><a href="#sec-a3"[^>]*>Background <span class="talt">· Arka plan<\/span><\/a><ol class="asub"><li data-k="t3h0"><a href="#sec-a3-h0"[^>]*>Goal <span class="talt">· Hedef<\/span><\/a><\/li><li data-k="t3h1"><a href="#sec-a3-h1"/);
  assert.doesNotMatch(toc, /İçindekiler/, "the file's own contents is not in the tree");
  assert.match(html, /<details class="dsec acontents" id="sec-a2"/);
  assert.match(html, /<h3 id="sec-a3-h0">/);
  assert.match(html, /<h3 id="sec-a3-h1">/);
  assert.match(html, /<span class="ttl">Refactor it<\/span>/);
  assert.match(html, /<h1>Refactor it<\/h1>/);
  assert.doesNotMatch(html, />, Refactor/);
});

/** A Chromium to run the page in, as docs-mermaid.test.mjs finds one. */
function chrome() {
  if (process.env.IMPRIMATUR_CHROME) return process.env.IMPRIMATUR_CHROME;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    for (const d of fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(cache, d))) {
        const bin = path.join(cache, d, sub, "chrome-headless-shell");
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  return undefined;
}
const bin = chrome();

test("#99 clicked again, the chosen task folds its tree and a node folds its children; once more opens them", { skip: !bin && "no Chromium found" }, () => {
  const Module = req("node:module");
  const load = Module._load;
  Module._load = function (r, ...a) {
    return r === "vscode" ? { window: {}, workspace: {}, commands: {}, env: {}, Uri: {} } : load.call(this, r, ...a);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-99-"));
  try {
    const { html } = req("../vscode/graphView.js");
    const pane = analysisHubHtml({
      repo: { id: 1, name: "r" }, orphans: [], tasks: [],
      docs: [{ key: "LATD-1", at: 1, task: { id: 9, title: "T", status: "active" }, files: [{ source: "docs/a.md", local: false, sections: [
        { id: 1, key: "a--overview", title: "Map", body: "intro" },
        { id: 3, key: "a--background", title: "Background", body: "### Goal\nx\n### Retry\ny" },
      ] }] }],
    });
    const page = html({ rows: [], lanes: [], sessions: [] }, dir, "N", [], { view: { tab: "analysis" }, pane, repoName: "r", mermaid: { src: "", csp: "file:" } });
    const probe = `<script nonce="N">window.acquireVsCodeApi = () => ({ postMessage() {}, setState() {}, getState() {} });
addEventListener("click", (e) => { if (e.target.closest("a[href]")) e.preventDefault(); });
(() => {
const out = [];
const toc = () => document.querySelector("#pane .atoc").hidden ? "hidden" : "shown";
const node = () => document.querySelector('#pane .atoc li[data-k="t3"]').classList.contains("shut") ? "shut" : "open";
const task = () => document.querySelector("#pane .aitem");
const sec = () => document.querySelector('#pane .atoc li[data-k="t3"] > a');
const steps = [() => out.push(toc()), () => task().click(), () => out.push(toc()), () => task().click(), () => out.push(toc()),
  () => sec().click(), () => out.push(node()), () => sec().click(), () => out.push(node()), () => sec().click(), () => out.push(node())];
let i = 0;
const next = () => { if (i < steps.length) { steps[i++](); setTimeout(next, 50); } else document.title = "R:" + out.join(","); };
setTimeout(next, 500);
})();</script></head>`;
    const file = path.join(dir, "page.html");
    fs.writeFileSync(file, page.replace("</head>", probe));
    const r = spawnSync(bin, ["--headless", "--no-sandbox", "--disable-gpu", "--window-size=1200,700", "--virtual-time-budget=4000", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.stdout.match(/<title>([^<]*)<\/title>/)?.[1], "R:shown,hidden,shown,open,shut,open", r.stderr.slice(-500));
  } finally {
    Module._load = load;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
