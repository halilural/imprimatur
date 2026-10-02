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
  return md.renderer.render(tokens, md.options, { currentDocument: "doc" });
}

test("changed paragraph: class on the block, old text struck right above", () => {
  const html = render("# T\n\nSprint cumartesi başlar.\n", undefined, "# T\n\nSprint pazartesi başlar.\n");
  assert.match(html, /<div class="agent-review-old agent-review-latest"><del>Sprint cumartesi başlar\.<\/del><\/div>\s*<p class="agent-review-changed agent-review-latest">Sprint pazartesi başlar\.<\/p>/);
  assert.match(html, /<h1>T<\/h1>/); // untouched block stays plain
});

test("added heading and deleted paragraph", () => {
  const html = render("a\n\ngone\n\nz\n", undefined, "a\n\n## New\n\nz\n");
  assert.match(html, /<h2 class="agent-review-[a-z]+ agent-review-latest">New<\/h2>/);
  assert.match(html, /<del>gone<\/del>/);
});

test("earlier edits dim, latest bright", () => {
  const html = render("a\n", "a\n\nC1\n", "a\n\nC1\n\nC2\n");
  assert.match(html, /<p class="agent-review-added agent-review-earlier">C1<\/p>/);
  assert.match(html, /<p class="agent-review-added agent-review-latest">C2<\/p>/);
});

test("table row gets the class, no div inside the table", () => {
  const html = render("| a |\n| - |\n| x |\n", undefined, "| a |\n| - |\n| y |\n");
  assert.match(html, /<tr class="agent-review-changed agent-review-latest">\s*<td>y<\/td>/);
  assert.doesNotMatch(html.slice(html.indexOf("<table>"), html.indexOf("</table>")), /<div/);
});

test("old text is escaped", () => {
  const html = render("<b>x</b> y z\n", undefined, "plain new text\n");
  assert.match(html, /<del>&lt;b&gt;x&lt;\/b&gt; y z<\/del>/);
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
