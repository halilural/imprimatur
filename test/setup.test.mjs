import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHooks, mergeShowIn } from "../scripts/setup.mjs";

const root = "/home/u/projects/imprimatur";

test("setup: adds every hook to empty settings, keeps other hooks", () => {
  const before = { model: "x", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "heal.mjs" }] }] } };
  const { settings, changes } = mergeHooks(before, { root, lang: "Turkish" });
  assert.equal(changes.length, 8);
  assert.ok(changes.every((c) => c.startsWith("added")));
  assert.deepEqual(settings.hooks.SessionStart, before.hooks.SessionStart);
  assert.equal(settings.model, "x");
  assert.deepEqual(settings.hooks.PreToolUse[0], {
    matcher: "Edit|Write|Bash",
    hooks: [{ type: "command", command: `IMPRIMATUR_LANG=Turkish node "${root}/hooks/baseline.mjs" md mdx` }],
  });
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: "command", command: `IMPRIMATUR_LANG=Turkish node "${root}/hooks/waiting.mjs"` }] }]);
  assert.equal(before.hooks.PreToolUse, undefined); // the input is not changed
});

test("setup: a second run changes nothing; an old path or language is updated in place", () => {
  const once = mergeHooks({}, { root, lang: "Turkish" }).settings;
  assert.deepEqual(mergeHooks(once, { root, lang: "Turkish" }).changes, []);
  const unquoted = JSON.parse(JSON.stringify(once).replaceAll('\\"', ""));
  assert.deepEqual(mergeHooks(unquoted, { root, lang: "Turkish" }).changes, []); // quotes alone are no change
  const old = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node /old/imprimatur/hooks/baseline.mjs md mdx" }] }] } };
  const { settings, changes } = mergeHooks(old, { root });
  assert.ok(changes.includes("updated PostToolUse [Bash] → baseline.mjs"));
  assert.equal(settings.hooks.PostToolUse.filter((e) => e.matcher === "Bash").length, 1);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, `node "${root}/hooks/baseline.mjs" md mdx`);
});

test("setup: --show-in sets imprimatur.showIn, keeps the rest, rejects other values", () => {
  const { settings, change } = mergeShowIn({ "editor.fontSize": 14 }, "both");
  assert.deepEqual(settings, { "editor.fontSize": 14, "imprimatur.showIn": "both" });
  assert.equal(change, "imprimatur.showIn: (default preview) → both");
  assert.equal(mergeShowIn(settings, "both").change, undefined);
  assert.throws(() => mergeShowIn({}, "everywhere"));
});
