import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, altOf, shotMarkdown, shotPath } from "../skills/issues/screenshots.mjs";

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
