import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { FILE, parseLog, historyLines, capDiff, SetupHistory } = createRequire(import.meta.url)("../vscode/setup-history.js");

function gitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-history-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z" } }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write(".claude/hooks/old.sh", "#!/bin/bash\necho one\necho two\necho three\n");
  git("add", "-A");
  git("commit", "-qm", "feat: add the hook");
  git("mv", ".claude/hooks/old.sh", ".claude/hooks/new.sh");
  git("commit", "-qm", "refactor: rename the hook");
  write(".claude/hooks/new.sh", "#!/bin/bash\necho one\necho TWO\necho three\n");
  git("commit", "-qam", "fix: louder hook");
  write(".claude/settings.json", "{}\n");
  return { root, git };
}

test("history: parseLog reads commits newest first with the path at each", () => {
  const out = "\x1eaaa\x1fa1\x1f2026-10-05T00:00:00Z\x1flast\n\nnew.sh\n\x1ebbb\x1fb1\x1f2026-10-01T00:00:00Z\x1ffirst\n\nold.sh\n";
  const log = parseLog(out, "new.sh");
  assert.deepEqual(log.map((c) => [c.short, c.path, c.subject]), [["a1", "new.sh", "last"], ["b1", "old.sh", "first"]]);
  assert.deepEqual(parseLog("", "x"), []);
  assert.deepEqual(historyLines(undefined), ["_Not committed yet._"]);
  assert.match(capDiff(["diff --git a b", "@@ -1 +1 @@", ...Array.from({ length: 200 }, (_, i) => `+${i}`)].join("\n")), /… 81 more lines$/);
});

test("history: added and last commit follow renames, git runs again only after a new HEAD; explanation is lazy and cached", async () => {
  const { root, git } = gitRepo();
  const calls = [];
  const run = (args, cwd) => {
    calls.push(args[0]);
    return Promise.resolve(execFileSync("git", args, { cwd }).toString());
  };
  const prompts = [];
  const h = new SetupHistory({ run, ask: async (p) => (prompts.push(p), "Makes the hook print TWO in capitals.\n"), lang: () => "English" });
  const rels = [".claude/hooks/new.sh", ".claude/settings.json"];
  assert.equal(await h.refresh(root, rels), true);
  const info = h.info(root, ".claude/hooks/new.sh");
  assert.equal(info.first.subject, "feat: add the hook");
  assert.equal(info.first.path, ".claude/hooks/old.sh");
  assert.equal(info.last.subject, "fix: louder hook");
  assert.equal(h.info(root, ".claude/settings.json"), undefined, "not committed");
  const lines = historyLines(info);
  assert.match(lines[0], /^Added 2026-10-01 · `[0-9a-f]{7}` · feat: add the hook$/);
  assert.match(lines[1], /^Last changed 2026-10-01 · `[0-9a-f]{7}` · fix: louder hook$/);
  assert.equal(prompts.length, 0, "no model call until asked");

  // Same HEAD: no git log again.
  calls.length = 0;
  assert.equal(await h.refresh(root, rels), false);
  assert.deepEqual(calls, ["rev-parse"]);

  // Explain: one model call with the last commit's diff, then from the cache (also after a reload).
  assert.equal(await h.explain(root, ".claude/hooks/new.sh"), "Makes the hook print TWO in capitals.");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^-echo two$/m);
  assert.match(prompts[0], /^\+echo TWO$/m);
  assert.match(prompts[0], /fix: louder hook/);
  assert.equal(await h.explain(root, ".claude/hooks/new.sh"), "Makes the hook print TWO in capitals.");
  assert.equal(prompts.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
  assert.equal(saved.explained[`${info.last.hash}:.claude/hooks/new.sh`], "Makes the hook print TWO in capitals.");
  const again = new SetupHistory({ run, ask: async () => assert.fail("cached") });
  calls.length = 0;
  await again.refresh(root, rels);
  assert.deepEqual(calls, ["rev-parse"], "history read from the file at the same HEAD");
  assert.equal(again.explained(root, ".claude/hooks/new.sh"), "Makes the hook print TWO in capitals.");

  // A new commit: history is read again, the new last change is not explained yet.
  git("add", "-A");
  git("commit", "-qm", "chore: settings");
  assert.equal(await h.refresh(root, rels), true);
  assert.equal(h.info(root, ".claude/settings.json").last.subject, "chore: settings");
  assert.equal(h.explained(root, ".claude/settings.json"), undefined);
});

test("history: no model call in an untrusted workspace", async () => {
  const { root } = gitRepo();
  let asked = 0;
  const gate = [];
  const h = new SetupHistory({ ask: async () => (asked++, "x"), allowed: (what) => (gate.push(what), false) });
  await h.refresh(root, [".claude/hooks/new.sh"]);
  assert.equal(await h.explain(root, ".claude/hooks/new.sh"), undefined);
  assert.equal(asked, 0);
  assert.equal(gate.length, 1);
});
