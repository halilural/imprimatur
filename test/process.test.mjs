// Process checks (#56): vscode/process.js and hooks/process.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { check, reply, settingsOf, starterSettings } = req("../vscode/process.js");
const HOOK = new URL("../hooks/process.mjs", import.meta.url).pathname;

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function repo(settings = { process: {} }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-56-")));
  sh(root, "init", "-q", "-b", "main");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  if (settings) {
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "imprimatur.json"), JSON.stringify(settings));
  }
  return root;
}
const noRecords = { repoId: () => undefined, recordsOf: () => [], dbOf: () => undefined };

test("no .claude/imprimatur.json: nothing runs", () => {
  const root = repo(null);
  assert.deepEqual(check("PreToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "git commit --no-verify" } }), {});
  assert.deepEqual(check("Stop", { cwd: root, last_assistant_message: "done" }), {});
});

test("settings: missing keys take the defaults; strings, booleans and objects", () => {
  const root = repo({ process: { hookBypass: "warn", designFirst: false, mainGuard: { allow: ["^(todos|docs)/"] }, status: true } });
  const s = settingsOf(root);
  assert.equal(s.hookBypass.mode, "warn");
  assert.equal(s.designFirst.mode, false);
  assert.deepEqual([s.mainGuard.mode, s.mainGuard.branch, s.mainGuard.allow], ["block", "main", ["^(todos|docs)/"]]);
  assert.deepEqual([s.status.mode, s.status.word], ["block", "neredeyiz"]);
  assert.equal(s.sweep.mode, "warn");
  assert.equal(settingsOf(repo(null)), undefined);
});

test("hookBypass: --no-verify, commit -n and HUSKY=0 are blocked; a plain commit is not", () => {
  const root = repo();
  const bash = (command) => check("PreToolUse", { cwd: root, tool_name: "Bash", tool_input: { command } });
  for (const c of ["git commit --no-verify -m x", "git push --no-verify", "git commit -n -m x", "HUSKY=0 git commit -m x"]) assert.match(bash(c).block, /hooks are not skipped/, c);
  assert.deepEqual(bash("git commit -m 'no -n here'"), {});
  assert.deepEqual(bash("npm test -- -n 3"), {});
});

test("mainGuard: on main only the allowed paths; ignored files and other branches pass", () => {
  const root = repo({ process: { mainGuard: { allow: ["^docs/"] }, designFirst: false } });
  fs.writeFileSync(path.join(root, ".gitignore"), "tmp/\n");
  const edit = (file) => check("PreToolUse", { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, file) } });
  assert.match(edit("src/a.js").block, /on main, only \^docs\/ is edited.*File: src\/a\.js/);
  assert.deepEqual(edit("docs/a.md"), {});
  assert.deepEqual(edit("tmp/x.log"), {});
  assert.deepEqual(check("PreToolUse", { cwd: root, tool_name: "Write", tool_input: { file_path: "/elsewhere/x.js" } }), {});
  sh(root, "switch", "-q", "-c", "feat/1-x");
  assert.deepEqual(edit("src/a.js"), {});
});

test("designFirst: code on a <type>/<n>-… branch before the task has an ADR or PDR is a warning", () => {
  const root = repo({ process: {} });
  sh(root, "switch", "-q", "-c", "feat/56-process");
  const edit = (records) => check("PreToolUse", { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/a.js") } }, { records });
  const known = { ...noRecords, repoId: () => 1, task: () => ({ key: "#56" }) };
  const none = edit({ ...known, recordsOf: () => [{ kind: "todo" }] });
  assert.equal(none.block, undefined);
  assert.match(none.context[0], /#56 has no ADR or PDR/);
  assert.deepEqual(edit({ ...known, recordsOf: () => [{ kind: "pdr" }] }), {});
  // An ADR or PDR under another task (imported design records) that names the issue counts.
  const elsewhere = (r) => edit({ ...known, recordsOf: () => [], dbOf: () => ({ recordsByKind: () => [r] }) });
  assert.deepEqual(elsewhere({ kind: "pdr", title: "Vergi sayfası", links: { issue: 56 } }), {});
  assert.deepEqual(elsewhere({ kind: "adr", title: "Vergi verisi (#56)" }), {});
  assert.match(elsewhere({ kind: "adr", title: "başka iş (#567)" }).context[0], /#56 has no ADR/);
  assert.deepEqual(edit(noRecords), {}, "no database answer, no warning");
  const md = check("PreToolUse", { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "notes.md") } }, { records: { ...known, recordsOf: () => [] } });
  assert.deepEqual(md, {}, "Markdown is not code");
  // Once per session and task.
  const s1 = (records) => check("PreToolUse", { cwd: root, session_id: "S1", tool_name: "Edit", tool_input: { file_path: "src/b.js" } }, { records });
  assert.match(s1({ ...known, recordsOf: () => [] }).context[0], /#56/);
  assert.deepEqual(s1({ ...known, recordsOf: () => [] }), {});
});

test("docsToc: only a trusted repo's script, inside the repo; never a flag or a path outside", () => {
  const root = repo({ process: { docsToc: { script: "scripts/toc.mjs" } } });
  process.env.IMPRIMATUR_DB = path.join(root, "db", "i.db");
  const { trust, isTrusted, scriptIn } = req("../vscode/process.js");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "toc.mjs"), "console.log('ran')");
  const post = () => check("PostToolUse", { cwd: root, tool_name: "Write", tool_input: { file_path: path.join(root, "docs/a.md") } });
  assert.match(post().context[0], /not run: this repo is not trusted/);
  trust(root);
  assert.equal(isTrusted(root), true);
  assert.deepEqual(post().context, ["Imprimatur (docsToc): ran"]);
  assert.equal(scriptIn(root, "--eval=1"), undefined);
  assert.equal(scriptIn(root, "../../etc/passwd"), undefined);
  assert.equal(scriptIn(root, "/etc/hostname"), undefined);
});

test("docsToc runs the repo's script after a docs edit; unopenedSources warns", () => {
  const root = repo({ process: {} });
  process.env.IMPRIMATUR_DB = path.join(root, "db", "i.db");
  req("../vscode/process.js").trust(root);
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "scripts", "docs-toc.mjs"), "console.log('toc: docs/a.md updated')");
  fs.mkdirSync(path.join(root, "docs", "market-research"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "market-research", "x.md"), "- kaynak (açılmadı)\n");
  const post = (file) => check("PostToolUse", { cwd: root, tool_name: "Write", tool_input: { file_path: path.join(root, file) } });
  assert.deepEqual(post("docs/market-research/x.md").context, ["Imprimatur (docsToc): toc: docs/a.md updated", 'Imprimatur (unopenedSources): x.md has sources marked "açılmadı". Open them now (WebFetch); only an HTTP error is written, as "açılamadı: 403".']);
  assert.deepEqual(post("src/a.js"), {});
});

test("issueCreate reminds; issueFields names what the new issue lacks", () => {
  const root = repo({ process: {} });
  const gh = () => JSON.stringify({ milestone: null, projectItems: [{ title: "Board", status: null }] });
  const r = check("PostToolUse", { cwd: root, session_id: "S1", tool_name: "Bash", tool_input: { command: "gh issue create -t x -b y" }, tool_response: { stdout: "https://github.com/u/r/issues/57\n" } }, { gh });
  assert.deepEqual(r.context.length, 1);
  assert.match(r.context[0], /link it under its epic/);
  // The fields are set in the next steps: checked once, at the turn's end.
  const end = () => check("Stop", { cwd: root, session_id: "S1", last_assistant_message: "Neredeyiz" }, { gh });
  assert.deepEqual(end().notice, ["Imprimatur (issueFields): #57, opened this turn, has no milestone, board Status."]);
  assert.deepEqual(end(), {});
  assert.deepEqual(check("PostToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "gh issue list" } }), {});
});

test("sweep: a task set done while its issue is open", () => {
  const root = repo({ process: {} });
  const call = (state) => check("PostToolUse", { cwd: root, tool_name: "mcp__imprimatur__task_upsert", tool_input: { key: "#56", status: "done" } }, { gh: () => JSON.stringify({ state }), records: noRecords });
  assert.match(call("OPEN").context[0], /#56 is done in Imprimatur but its GitHub issue is open/);
  assert.deepEqual(call("CLOSED"), {});
  // The plugin's server names the tool mcp__plugin_imprimatur_imprimatur__task_upsert (#67).
  const plugin = check("PostToolUse", { cwd: root, tool_name: "mcp__plugin_imprimatur_imprimatur__task_upsert", tool_input: { key: "#56", status: "done" } }, { gh: () => JSON.stringify({ state: "OPEN" }), records: noRecords });
  assert.match(plugin.context[0], /#56 is done in Imprimatur/);
});

test("Stop: no 'Neredeyiz' blocks once (stop_hook_active ends it); merged branches left behind are named", () => {
  const root = repo({ process: {} });
  assert.match(check("Stop", { cwd: root, last_assistant_message: "Bitti." }).block, /no "neredeyiz" section/);
  assert.deepEqual(check("Stop", { cwd: root, last_assistant_message: "Bitti.\n\n## Neredeyiz\n- x" }), {});
  assert.deepEqual(check("Stop", { cwd: root, stop_hook_active: true, last_assistant_message: "Bitti." }), {});
});

test("branchFinish: merged branches left behind are told to the agent at session start and after a merge", () => {
  const root = repo({ process: { whereWeLeftOff: false } });
  sh(root, "branch", "feat/3-new");
  sh(root, "switch", "-q", "-c", "feat/2-done");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  sh(root, "switch", "-q", "main");
  sh(root, "merge", "-q", "--ff-only", "feat/2-done");
  const want = ["Imprimatur (branchFinish): merged into main but not deleted: feat/2-done. Delete them: git branch -d feat/2-done."];
  assert.deepEqual(check("SessionStart", { cwd: root }).context, want);
  assert.deepEqual(check("PostToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "git merge --ff-only feat/2-done" } }).context, want);
  assert.deepEqual(check("PostToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "npm test" } }), {});
  assert.deepEqual(check("Stop", { cwd: root, last_assistant_message: "Neredeyiz" }), {}, "not at Stop: only the user would see it");
});

test("SessionStart: the repo's tasks and their 👉 from the database", () => {
  const root = repo({ process: {} });
  const records = { ...noRecords, repoId: () => 1, dbOf: () => ({ whereWeLeftOff: () => [{ key: "#56", title: "Process", status: "active", pointer_title: "process.mjs", open_records: 2 }] }) };
  const r = check("SessionStart", { cwd: root }, { records });
  assert.match(r.context[0], /Where we left off[\s\S]*- #56 Process \[active\] 👉 process\.mjs \(2 open\)/);
  const long = { ...records, dbOf: () => ({ whereWeLeftOff: () => Array.from({ length: 15 }, (_, i) => ({ key: `#${i}`, title: "t".repeat(500), status: "active", pointer_title: "p".repeat(500) })) }) };
  const big = check("SessionStart", { cwd: root }, { records: long }).context[0];
  assert.ok(big.length <= 4100, `${big.length} characters`);
  assert.match(big, /t{79}…/);
});

test("bypasses: real flags only, not quoted text, heredocs or other tools", () => {
  const { bypasses } = req("../vscode/process.js");
  for (const c of ["git commit -an -m x", "cd x && git push --no-verify", "FOO=1 HUSKY=0 git commit -m x", "git status\ngit commit --no-verify"]) assert.equal(bypasses(c), true, c);
  for (const c of ["git log -n 5", "npm run lint -- --no-verify", "gitleaks --no-verify", 'git commit -m "skip -n and --no-verify"', "git commit -F - <<EOF\nno --no-verify, -n\nEOF", "git status\nnpm run x -- --no-verify"]) assert.equal(bypasses(c), false, c);
});

test("reply: a block keeps the warnings after its reason", () => {
  assert.deepEqual(reply("Stop", { block: "b", notice: ["n"] }), { code: 2, stderr: "b\nn" });
});

test("reply: block exits 2, context goes to additionalContext, Stop warnings to systemMessage", () => {
  assert.deepEqual(reply("PreToolUse", { block: "no" }), { code: 2, stderr: "no" });
  assert.deepEqual(JSON.parse(reply("PostToolUse", { context: ["a", "b"] }).stdout), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "a\nb" } });
  assert.deepEqual(JSON.parse(reply("Stop", { notice: ["n"] }).stdout), { systemMessage: "n" });
  assert.deepEqual(reply("Stop", {}), { code: 0 });
});

test("hook process: real JSON in, exit code and output out; no settings, no output; bad input exits 0", () => {
  const root = repo({ process: { designFirst: false } });
  const run = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, IMPRIMATUR_DB: path.join(root, "i.db") } });
  const blocked = run({ hook_event_name: "PreToolUse", cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/a.js") } });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /mainGuard/);
  const start = run({ hook_event_name: "SessionStart", cwd: root });
  assert.equal(start.status, 0);
  assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /No unfinished tasks in Imprimatur/);
  const plain = repo(null);
  assert.deepEqual([run({ hook_event_name: "Stop", cwd: plain, last_assistant_message: "x" }).status, run({ hook_event_name: "Stop", cwd: plain }).stdout], [0, ""]);
  assert.equal(spawnSync(process.execPath, [HOOK], { input: "nope" }).status, 0);
});

test("starter settings: every check, with the repo's own main allow list", () => {
  const s = starterSettings({ allow: ["^(todos|docs)/"] }).process;
  assert.deepEqual(s.mainGuard, { mode: "block", branch: "main", allow: ["^(todos|docs)/"] });
  assert.equal(s.hookBypass, "block");
  assert.equal(s.whereWeLeftOff, true);
});
