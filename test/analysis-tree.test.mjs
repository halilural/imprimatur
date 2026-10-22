// Görev analizleri's tree (#97): file › "##" sections › "###" headings; titles people can read.
import { createRequire } from "node:module";
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
