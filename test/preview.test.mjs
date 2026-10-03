import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const MarkdownIt = req("markdown-it");
const { review } = req("../vscode/diff.js");
const { markdownItPlugin } = req("../vscode/preview.js");

/**
 * Render `current` with marks against `base` (latest edit = `before`) the way
 * VS Code does: parse without the document, render with env.currentDocument.
 */
function render(base, before, current) {
  const md = markdownItPlugin(new MarkdownIt({ html: true }), (env) => (env.currentDocument === "doc" ? review(base, before, current) : []));
  const tokens = md.parse(current, { currentDocument: undefined });
  // data-ar (the accept group id) has its own test; leave it out of the shape checks
  return md.renderer.render(tokens, md.options, { currentDocument: "doc" }).replace(/ data-ar="[^"]*"/g, "");
}

test("changed paragraph: class on the block, old text struck right above", () => {
  const html = render("# T\n\nSprint cumartesi başlar.\n", undefined, "# T\n\nSprint pazartesi başlar.\n");
  assert.match(html, /<div class="imprimatur-old imprimatur-latest"><del>Sprint cumartesi başlar\.<\/del><\/div>\s*<p class="imprimatur-changed imprimatur-latest">Sprint pazartesi başlar\.<\/p>/);
  assert.match(html, /<h1>T<\/h1>/); // untouched block stays plain
});

test("added heading and deleted paragraph", () => {
  const html = render("a\n\ngone\n\nz\n", undefined, "a\n\n## New\n\nz\n");
  assert.match(html, /<h2 class="imprimatur-[a-z]+ imprimatur-latest">New<\/h2>/);
  assert.match(html, /<del>gone<\/del>/);
});

test("earlier edits dim, latest bright", () => {
  const html = render("a\n", "a\n\nC1\n", "a\n\nC1\n\nC2\n");
  assert.match(html, /<p class="imprimatur-added imprimatur-earlier">C1<\/p>/);
  assert.match(html, /<p class="imprimatur-added imprimatur-latest">C2<\/p>/);
});

test("table row gets the class, no div inside the table", () => {
  const html = render("| a |\n| - |\n| x |\n", undefined, "| a |\n| - |\n| y |\n");
  assert.match(html, /<tr class="imprimatur-changed imprimatur-latest">\s*<td>y<\/td>/);
  assert.doesNotMatch(html.slice(html.indexOf("<table>"), html.indexOf("</table>")), /<div/);
});

test("old text renders as Markdown, without the list marker", () => {
  const html = render("- **bold** y z\n", undefined, "- plain new text\n");
  assert.match(html, /<del><strong>bold<\/strong> y z<\/del>/);
});

test("without a formatter old text is escaped", () => {
  const { planBlocks } = req("../vscode/preview.js");
  const plan = planBlocks([{ start: 0, end: 1 }], review("<b>x</b> y z\n", undefined, "plain new text\n"));
  assert.match(plan[0].before[0], /<del>&lt;b&gt;x&lt;\/b&gt; y z<\/del>/);
});

test("accept button per changed block, with the block's line range", () => {
  const md = markdownItPlugin(
    new MarkdownIt({ html: true }),
    () => review("a\n\nold one two\n", undefined, "a\n\nnew three four\n"),
    (_env, start, end) => `vscode://x.y/accept?start=${start}&end=${end}`,
  );
  const html = md.renderer.render(md.parse("a\n\nnew three four\n", {}), md.options, {});
  assert.match(html, /<a class="imprimatur-accept" data-ar="2-3" href="vscode:\/\/x\.y\/accept\?start=2&(amp;)?end=3"/);
  assert.equal((html.match(/imprimatur-accept/g) || []).length, 1);
});

test("no copy: output unchanged", () => {
  const md = markdownItPlugin(new MarkdownIt({ html: true }), () => []);
  assert.equal(md.render("hi\n", {}), new MarkdownIt().render("hi\n"));
});

test("cached tokens are not changed by a render", () => {
  const md = markdownItPlugin(new MarkdownIt({ html: true }), () => review("a\n", undefined, "b\n"));
  const tokens = md.parse("b\n", {});
  const first = md.renderer.render(tokens, md.options, {});
  const second = md.renderer.render(tokens, md.options, {});
  assert.equal(first, second); // no class piling up on reuse
  assert.equal(tokens[0].attrs, null);
});

test("a changed Mermaid diagram gets color lines and a legend, the file text stays", () => {
  const oldMd = "# T\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";
  const newMd = "# T\n\n```mermaid\nflowchart LR\n  A -->|id| B\n  B --> C[New]\n```\n";
  const md = markdownItPlugin(new MarkdownIt({ html: true }), () => [], () => "vscode://x/accept", () => oldMd);
  const tokens = md.parse(newMd, {});
  const html = md.renderer.render(tokens, md.options, {});
  assert.match(html, /Agent changes in this diagram/);
  assert.match(html, /class C arAdded/);
  assert.match(html, /linkStyle 0 stroke:#d29922/);
  assert.doesNotMatch(tokens.find((t) => t.type === "fence").content, /arAdded/); // cached token untouched
});

test("a table with marked rows gets one Accept above it", () => {
  const md = markdownItPlugin(new MarkdownIt({ html: true }), () => review("| a |\n| - |\n| 1 |\n", undefined, "| a |\n| - |\n| 2 |\n| 3 |\n"), (_e, s, e) => `vscode://x/accept?start=${s}&end=${e}`);
  const html = md.renderer.render(md.parse("| a |\n| - |\n| 2 |\n| 3 |\n", {}), md.options, {});
  assert.match(html, /✓ Accept table<\/a>\s*<table>/);
  assert.equal((html.match(/imprimatur-accept/g) || []).length, 1);
});

test("a deletion with accept links renders (regression: blank preview)", () => {
  const md = markdownItPlugin(new MarkdownIt({ html: true }), () => review("a\n\ngone\n\nz\n", undefined, "a\n\nz\n"), (_e, s, e) => `vscode://x/accept?start=${s}&end=${e}`);
  const html = md.renderer.render(md.parse("a\n\nz\n", {}), md.options, {});
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /imprimatur-accept/);
});

test("a bug in the marks leaves the preview rendered, unmarked", () => {
  const md = markdownItPlugin(new MarkdownIt({ html: true }), () => [{ marks: [{ kind: "changed", line: 0, oldText: null }] }]);
  const html = md.renderer.render(md.parse("text\n", {}), md.options, {});
  assert.match(html, /<p>text<\/p>/);
});

test("a button, its old box and its block share one data-ar id", () => {
  const md = markdownItPlugin(new MarkdownIt(), () => review("# T\n\nold words here\n", undefined, "# T\n\nnew text there\n"), () => "vscode://x.y/accept?ui=1");
  const html = md.renderer.render(md.parse("# T\n\nnew text there\n", {}), md.options, {});
  const ids = [...html.matchAll(/data-ar="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["2-3", "2-3", "2-3"]);
});
