import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { allowed, altOf, shotMarkdown, shotPath, shotRecordLine } from "../skills/issues/screenshots.mjs";

const { renderMarkdown, SHOT_IMG } = createRequire(import.meta.url)("../vscode/markdown.js");

test("issues screenshots (#159): a record's shot: image points into the data folder; nothing outside it", () => {
  assert.equal(shotRecordLine("817", "2026-11-06", "/t/1-meetings.png", "1 meetings"), "![1 meetings](shot:817/2026-11-06/1-meetings.png)");
  assert.match(renderMarkdown("![a](shot:817/2026-11-06/1-meetings.png)"), new RegExp(`src="${SHOT_IMG}817/2026-11-06/1-meetings.png"`));
  for (const bad of ["shot:../../etc/passwd", "shot:/etc/passwd", "shot:a/../../b.png"])
    assert.doesNotMatch(renderMarkdown(`![x](${bad})`), /<img/, bad);
});

test("issues screenshots (#158): an image's place on the branch, its Markdown, and the public-repo guard", () => {
  assert.equal(shotPath("817", "2026-11-06", "C:/tmp/shots/3-answer.png"), "817/2026-11-06/3-answer.png");
  assert.equal(altOf("/x/2-session_open.png"), "2 session open");
  assert.equal(
    shotMarkdown("o/r", "abc", "817/2026-11-06/1-meetings.png", "1 meetings"),
    "![1 meetings](https://github.com/o/r/blob/abc/817/2026-11-06/1-meetings.png?raw=true)"
  );
  assert.equal(allowed("PRIVATE", false), true);
  assert.equal(allowed("PUBLIC", false), false);
  assert.equal(allowed("PUBLIC", true), true);
});
