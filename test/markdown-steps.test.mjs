// #226: a step in rendered Markdown is not the panel's flex "step" row, and its box reads ticked or empty.
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { renderMarkdown } = req("../vscode/markdown.js");
const { CSS } = req("../vscode/app/html.js");

test("steps: own list-item class (not the exercise flex row), box keeps checked and its line", () => {
  const html = renderMarkdown("- [x] Agent `LogsSent` up\n- [ ] Second\n");
  assert.match(html, /<li class="mdstep-item on"><input type="checkbox" class="mdstep" data-line="0" checked disabled/);
  assert.match(html, /<li class="mdstep-item"><input type="checkbox" class="mdstep" data-line="1" disabled/);
  assert.doesNotMatch(html, /class="step/);
});

test("steps: the panel draws the box, ticked filled, read-only never faded", () => {
  assert.match(CSS, /input\.mdstep \{[^}]*appearance: none/);
  assert.match(CSS, /input\.mdstep:checked \{[^}]*background:/);
  assert.match(CSS, /input\.mdstep:checked::after \{[^}]*content: "✓"/);
  assert.match(CSS, /input\.mdstep:disabled \{[^}]*opacity: 1/);
});
