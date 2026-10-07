// The graph's hover shows a Markdown edit as the preview's review (#50).
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";

const req = createRequire(import.meta.url);
const { reviewHtml, scopeCss } = req("../vscode/preview.js");

test("#50: an edit renders as Markdown with its added and changed blocks marked, old text in a box", () => {
  const md = new MarkdownIt({ html: true });
  const before = "# Title\n\nKept paragraph.\n\nOld **wording** here.\n";
  const after = "# Title\n\nKept paragraph.\n\nNew **wording** here.\n\n- added item\n";
  const html = reviewHtml(md, before, after);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p class="imprimatur-changed imprimatur-latest"[^>]*>New <strong>wording<\/strong> here\.<\/p>/);
  assert.match(html, /class="imprimatur-old imprimatur-latest"[^>]*><del>Old <strong>wording<\/strong> here\.<\/del>/);
  assert.match(html, /<li class="imprimatur-added imprimatur-latest"/);
  assert.doesNotMatch(html, /imprimatur-accept/); // no Accept buttons in a hover
});

test("#50: an edit inside a code block only marks nothing (the line diff stays)", () => {
  const md = new MarkdownIt();
  assert.equal(reviewHtml(md, "```\na\n```\n", "```\nb\n```\n"), undefined);
});

test("#50: the preview's stylesheet is scoped to the hover", () => {
  const css = scopeCss("/* c */\n.a,\n.b { color: red; }\n.c del { x: 1; }\n", "#pop .review");
  assert.equal(css, "#pop .review .a, #pop .review .b { color: red; }\n#pop .review .c del { x: 1; }");
});

test("#50: the graph page's script parses, with the scoped review styles and a CSP that blocks forms", async () => {
  const Module = req("node:module");
  const load = Module._load;
  Module._load = function (r, ...a) {
    return r === "vscode" ? { window: {}, workspace: {}, commands: {}, env: {}, Uri: {} } : load.call(this, r, ...a);
  };
  try {
    const { html } = req("../vscode/graphView.js");
    const page = html({ rows: [], lanes: [], sessions: [] }, "/tmp/x", "N", []);
    const js = page.match(/<script nonce="N">([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new Function(js));
    assert.match(page, /#pop \.review \.imprimatur-added/);
    assert.match(page, /form-action 'none'; base-uri 'none'/);
  } finally {
    Module._load = load;
  }
});
