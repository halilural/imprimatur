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
  assert.deepEqual([s.status.mode, s.status.word], ["block", "Where we are"]);
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

test("designFirst: code on a <type>/<n>-… branch before the task has a spec or an ADR is a warning (#186)", () => {
  const root = repo({ process: {} });
  sh(root, "switch", "-q", "-c", "feat/56-process");
  const edit = (records) => check("PreToolUse", { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/a.js") } }, { records });
  const known = { ...noRecords, repoId: () => 1, task: () => ({ key: "#56" }) };
  const none = edit({ ...known, recordsOf: () => [{ kind: "todo" }] });
  assert.equal(none.block, undefined);
  assert.match(none.context[0], /#56 has no spec or ADR[\s\S]*\/to-spec/);
  assert.deepEqual(edit({ ...known, recordsOf: () => [{ kind: "pdr" }] }), {}, "an old PDR still counts");
  // The task's spec with a section counts (Pocock's, #186); an empty one does not.
  const withSpec = (secs) => edit({ ...known, recordsOf: () => [], dbOf: () => ({ recordsByKind: () => [], taskDocFind: () => ({ id: 9 }), docSections: () => secs }) });
  assert.deepEqual(withSpec([{ status: "current" }]), {});
  assert.match(withSpec([]).context[0], /#56 has no spec/);
  // An ADR or PDR under another task (imported design records) that names the issue counts.
  const elsewhere = (r) => edit({ ...known, recordsOf: () => [], dbOf: () => ({ recordsByKind: () => [r] }) });
  assert.deepEqual(elsewhere({ kind: "pdr", title: "Tax page", links: { issue: 56 } }), {});
  assert.deepEqual(elsewhere({ kind: "adr", title: "Tax data (#56)" }), {});
  assert.match(elsewhere({ kind: "adr", title: "other job (#567)" }).context[0], /#56 has no spec or ADR/);
  assert.deepEqual(edit(noRecords), {}, "no database answer, no warning");
  const md = check("PreToolUse", { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "notes.md") } }, { records: { ...known, recordsOf: () => [] } });
  assert.deepEqual(md, {}, "Markdown is not code");
  // Once per session and task.
  const s1 = (records) => check("PreToolUse", { cwd: root, session_id: "S1", tool_name: "Edit", tool_input: { file_path: "src/b.js" } }, { records });
  assert.match(s1({ ...known, recordsOf: () => [] }).context[0], /#56/);
  assert.deepEqual(s1({ ...known, recordsOf: () => [] }), {});
});

test("designFirst (#207): a Jira-keyed branch is checked too, and the warning tells the agent how to write the spec itself", () => {
  const { taskOfBranch } = req("../vscode/process.js");
  assert.equal(taskOfBranch("feat/56-process"), "#56");
  assert.equal(taskOfBranch("dev/LATD-14087-transaction-id"), "LATD-14087");
  assert.equal(taskOfBranch("fix/proj-12"), "PROJ-12");
  assert.equal(taskOfBranch("main"), undefined);
  const root = repo({ process: {} });
  sh(root, "switch", "-q", "-c", "dev/LATD-14087-transaction-id");
  let asked;
  const records = { ...noRecords, repoId: () => 1, task: (_r, key) => ((asked = key), { key }), recordsOf: () => [] };
  const out = check("PreToolUse", { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/a.java") } }, { records });
  assert.equal(asked, "LATD-14087");
  assert.match(out.context[0], /LATD-14087 has no spec or ADR/);
  assert.match(out.context[0], /doc_section_upsert kind "spec", task "LATD-14087"/);
  assert.match(out.context[0], /skills[\\/]to-spec[\\/]SKILL\.md/);
  // An ADR elsewhere that names the key counts; a longer key does not.
  const named = (title) => check("PreToolUse", { cwd: root, session_id: title, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/b.java") } },
    { records: { ...records, dbOf: () => ({ recordsByKind: () => [{ kind: "adr", title }] }) } });
  assert.deepEqual(named("Transaction ids (LATD-14087)"), {});
  assert.match(named("Other (LATD-140871)").context[0], /LATD-14087 has no spec/);
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
  // Turkish input: the "açılmadı" (not opened) marker unopenedSources looks for
  fs.writeFileSync(path.join(root, "docs", "market-research", "x.md"), "- source (açılmadı)\n");
  const post = (file) => check("PostToolUse", { cwd: root, tool_name: "Write", tool_input: { file_path: path.join(root, file) } });
  assert.deepEqual(post("docs/market-research/x.md").context, ["Imprimatur (docsToc): toc: docs/a.md updated", 'Imprimatur (unopenedSources): x.md has sources marked "not opened" ("açılmadı"). Open them now (WebFetch); only an HTTP error is written, as "açılamadı: 403".']);
  assert.deepEqual(post("src/a.js"), {});
});

test("issueCreate reminds; issueFields names what the new issue lacks", () => {
  const root = repo({ process: {} });
  const gh = () => JSON.stringify({ milestone: null, projectItems: [{ title: "Board", status: null }] });
  const r = check("PostToolUse", { cwd: root, session_id: "S1", tool_name: "Bash", tool_input: { command: "gh issue create -t x -b y" }, tool_response: { stdout: "https://github.com/u/r/issues/57\n" } }, { gh });
  assert.deepEqual(r.context.length, 1);
  assert.match(r.context[0], /link it under its epic/);
  // The fields are set in the next steps: checked once, at the turn's end.
  // The answer has the default status section, so only issueFields is under test.
  const end = () => check("Stop", { cwd: root, session_id: "S1", last_assistant_message: "Where we are" }, { gh });
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

test("Stop: no status section blocks once (stop_hook_active ends it); the word is the repo's own", () => {
  const root = repo({ process: {} });
  assert.match(check("Stop", { cwd: root, last_assistant_message: "Done." }).block, /no "Where we are" section/);
  assert.deepEqual(check("Stop", { cwd: root, last_assistant_message: "Done.\n\n## Where we are\n- x" }), {});
  assert.deepEqual(check("Stop", { cwd: root, stop_hook_active: true, last_assistant_message: "Done." }), {});
  // Turkish input: a repo's own status word, matched with Turkish casing (İ/i, I/ı).
  const tr = repo({ process: { status: { word: "neredeyiz" } } });
  assert.deepEqual(check("Stop", { cwd: tr, last_assistant_message: "Bitti.\n\n## NEREDEYİZ\n- x" }), {});
});

test("Stop (#176): with a Turkish reply language the default status word is asked as \"Neredeyiz\"; English still counts", () => {
  const root = repo({ process: {} });
  const was = process.env.IMPRIMATUR_REPLY_LANG;
  process.env.IMPRIMATUR_REPLY_LANG = "Turkish";
  try {
    assert.match(check("Stop", { cwd: root, last_assistant_message: "Bitti." }).block, /no "Neredeyiz" section/);
    assert.deepEqual(check("Stop", { cwd: root, last_assistant_message: "Bitti.\n\n## Neredeyiz\n- x" }), {});
    assert.deepEqual(check("Stop", { cwd: root, last_assistant_message: "Done.\n\n## Where we are\n- x" }), {});
    assert.match(check("SessionStart", { cwd: root }, { records: noRecords }).context?.join("\n") ?? "", /status section is "Neredeyiz"/);
  } finally {
    if (was === undefined) delete process.env.IMPRIMATUR_REPLY_LANG;
    else process.env.IMPRIMATUR_REPLY_LANG = was;
  }
});

test("branchFinish: merged branches left behind are told to the agent at session start and after a merge", () => {
  const root = repo({ process: { whereWeLeftOff: false } });
  sh(root, "branch", "feat/3-new");
  sh(root, "switch", "-q", "-c", "feat/2-done");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work");
  sh(root, "switch", "-q", "main");
  sh(root, "merge", "-q", "--ff-only", "feat/2-done");
  const want = ["Imprimatur (branchFinish): merged into main but not deleted: feat/2-done. Delete them: git branch -d feat/2-done."];
  assert.deepEqual(check("SessionStart", { cwd: root }).context?.filter((l) => !/replyLang/.test(l)), want);
  assert.deepEqual(check("PostToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "git merge --ff-only feat/2-done" } }).context, want);
  assert.deepEqual(check("PostToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "npm test" } }), {});
  // The default status section is there, so only the timing is under test.
  assert.deepEqual(check("Stop", { cwd: root, last_assistant_message: "Where we are" }), {}, "not at Stop: only the user would see it");
});

test("SessionStart: the repo's tasks and their 👉 from the database", () => {
  const root = repo({ process: {} });
  const records = { ...noRecords, repoId: () => 1, dbOf: () => ({ whereWeLeftOff: () => [{ key: "#56", title: "Process", status: "active", pointer_title: "process.mjs", open_records: 2 }] }) };
  const r = check("SessionStart", { cwd: root }, { records });
  assert.match(r.context.find((l) => /Where we left off/.test(l)) ?? "", /Where we left off[\s\S]*- #56 Process \[active\] 👉 process\.mjs \(2 open\)/);
  const long = { ...records, dbOf: () => ({ whereWeLeftOff: () => Array.from({ length: 15 }, (_, i) => ({ key: `#${i}`, title: "t".repeat(500), status: "active", pointer_title: "p".repeat(500) })) }) };
  const big = check("SessionStart", { cwd: root }, { records: long }).context.find((l) => /Where we left off/.test(l)) ?? "";
  assert.ok(big.length <= 1500, `${big.length} characters: short enough for every session start (#29)`);
  assert.match(big, /t{59}…/);
  assert.match(big, /\(7 more open tasks: where_we_left_off lists them all\.\)$/, "at most 8 listed");
  const mixed = { ...records, dbOf: () => ({ whereWeLeftOff: () => [{ key: "#1", title: "Idle epic", status: "open" }, { key: "#2", title: "Busy", status: "open", pointer_title: "next" }] }) };
  const m = check("SessionStart", { cwd: root }, { records: mixed }).context.find((l) => /Where we left off/.test(l)) ?? "";
  assert.match(m, /- #2 Busy \[open\] 👉 next/);
  assert.doesNotMatch(m, /Idle epic/, "a task with no work in hand is left to the count");
  assert.match(m, /\(1 more open task: /);
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

test("repo language (#80): \"lang\" alone says it at SessionStart and turns no check on", () => {
  const root = repo({ lang: "English" });
  assert.equal(settingsOf(root), undefined);
  const r = check("SessionStart", { cwd: root, source: "startup" }, { records: noRecords });
  assert.equal(r.context?.length, 2);
  assert.match(r.context[0], /repoLang.*in English/);
  assert.match(r.context[1], /replyLang/);
  assert.deepEqual(check("PreToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "git commit --no-verify" } }), {});
});

test("repo language (#80): with process settings, the line comes first; none without \"lang\"", () => {
  const withLang = repo({ lang: "English", process: {} });
  assert.ok(settingsOf(withLang));
  const r = check("SessionStart", { cwd: withLang, source: "startup" }, { records: noRecords });
  assert.match(r.context?.[0] ?? "", /repoLang/);
  const plain = check("SessionStart", { cwd: repo(), source: "startup" }, { records: noRecords });
  assert.ok(!(plain.context ?? []).some((l) => /repoLang/.test(l)));
  assert.ok((plain.context ?? []).some((l) => /replyLang.*reply to the user in \w+/.test(l)), "the reply language is said in every repo (#176)");
});

test("keepGoing (#194): the epic's next ready child blocks the stop; a question, nothing ready or the limit lets it end", () => {
  const { openDb } = req("../vscode/db.js");
  const db = openDb({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-194-")), "x.db") });
  const root = repo({ process: { status: false, keepGoing: { mode: "block", max: 2 } } });
  const rid = db.repoOf(root).id;
  const epic = db.upsertTask(rid, "#10", { title: "Epic", status: "active" });
  const part = db.upsertTask(rid, "#11", { title: "Part", status: "active", epicId: epic.id });
  db.upsertTask(rid, "#12", { title: "Done one", status: "done", epicId: part.id });
  db.upsertTask(rid, "#14", { title: "Waits", epicId: part.id, summary: "Not started; blocked by #13" });
  db.upsertTask(rid, "#13", { title: "Ready one", epicId: part.id });
  const records = { repoId: () => rid, recordsOf: () => [], dbOf: () => db };
  const stop = (msg, session = "s1") => check("Stop", { cwd: root, session_id: session, last_assistant_message: msg }, { records });
  assert.match(stop("Shipped #12.").block ?? "", /keepGoing.*epic #10 still has work ready: #13 Ready one.*\(1\/2\)/);
  assert.deepEqual(stop("Shipped. 👉 Which one first?"), {}, "a question to the user ends the turn");
  assert.match(stop("Shipped #13.").block ?? "", /\(2\/2\)/);
  assert.deepEqual(stop("Shipped again."), {}, "the limit ends it");
  const t13 = db.taskByKey(rid, "#13");
  const ok = db.addRecord(t13.id, { kind: "todo", owner: "K", title: "Approve the report", pointer: true }, { kind: "agent" });
  assert.equal(stop("Report is ready.", "s4").block, undefined, "a task whose 👉 is the user's is not ready");
  db.updateRecord(ok.id, { status: "done" }, { kind: "user" });
  db.addRecord(t13.id, { kind: "question", title: "Which target?" }, { kind: "agent" });
  assert.equal(stop("Asked.", "s5").block, undefined, "an open question to the user is not ready either");
  db.upsertTask(rid, "#13", { status: "done" });
  db.upsertTask(rid, "#14", { status: "done" });
  assert.match(stop("Parts done.", "s2").block ?? "", /#11 Part/, "a part whose children are done is next: close it");
  db.upsertTask(rid, "#11", { status: "done" });
  assert.deepEqual(stop("All done.", "s3"), {}, "nothing ready");
});

test("fileContext (#137): the first edit of a file hears the records that name it, ADRs first, with a stale mark; once per session", () => {
  const root = repo({ process: { mainGuard: false, designFirst: false } });
  sh(root, "switch", "-q", "-c", "feat/137-x");
  const { openDb } = req("../vscode/db.js");
  const db = openDb({ path: path.join(root, "x.db") });
  const r = db.repoOf(root);
  const task = db.upsertTask(r.id, "#7", { title: "T", status: "open" });
  const agent = { kind: "agent", id: "t" };
  db.addRecord(task.id, { kind: "note", title: "A note about a", links: { files: ["src/a.js"] } }, agent);
  const adr = db.addRecord(task.id, { kind: "adr", status: "done", title: "a.js stays pure", links: { files: ["src/a.js", "src/b.js"] } }, agent);
  db.addRecord(task.id, { kind: "decision", status: "dropped", title: "Dropped one", links: { files: ["src/a.js"] } }, agent);
  db.addRecord(task.id, { kind: "decision", status: "done", title: "Only b", links: { files: ["src/b.js"] } }, agent);
  db.q("UPDATE records SET updated_at = 1000 WHERE id = ?").run(adr.id);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.js"), "1");
  sh(root, "add", ".");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change a");
  const records = { dbOf: () => db, repoId: () => r.id, recordsOf: () => [], task: () => undefined };
  const edit = (file, session = "S1") => check("PreToolUse", { cwd: root, session_id: session, tool_name: "Edit", tool_input: { file_path: path.join(root, file) } }, { records });
  const first = edit("src/a.js").context?.join("\n") ?? "";
  assert.match(first, /src\/a\.js is named by 2 records/);
  assert.match(first, new RegExp(`adr ${adr.id} \\(#7\\): a\\.js stays pure \\[possibly stale: src/a\\.js changed since, \\w+ change a\\]; note \\d+ \\(#7\\): A note about a`));
  assert.doesNotMatch(first, /Dropped one|Only b/);
  assert.deepEqual(edit("src/a.js"), {}, "once per file per session");
  assert.match(edit("src/a.js", "S2").context?.join("\n") ?? "", /named by 2 records/, "a new session hears it again");
  assert.deepEqual(edit("src/c.js"), {}, "a file no record names adds nothing");
});

// #223: work without a task. The repos here have a GitHub origin: without a tracker nothing is checked.
const tracked = (process = {}) => {
  const root = repo({ process: { status: false, docUpdate: false, keepGoing: false, ...process } });
  sh(root, "remote", "add", "origin", "https://github.com/u/r.git");
  return root;
};
const wrote = (root, session, task = "#12") => check("PostToolUse", { cwd: root, session_id: session, tool_name: "mcp__imprimatur__record_add", tool_input: { task, kind: "note", title: "x" } }, { records: noRecords });

test("commitRef (#223): a commit naming no task is stopped; a reference, the session's task or its branch lets it pass", () => {
  const root = tracked({ specFirst: false });
  const pre = (command, session = "c1") => check("PreToolUse", { cwd: root, session_id: session, tool_name: "Bash", tool_input: { command } });
  assert.match(pre('git commit -m "fix: x"').block ?? "", /commitRef.*Which task is this commit for\?.*Refs #N/);
  assert.deepEqual(pre('git commit -m "fix: x" -m "Refs #12"'), {});
  assert.deepEqual(pre('git add -A && git commit -am "PROJ-7 fix"'), {}, "a Jira key");
  assert.deepEqual(pre("git commit -q -F - <<'EOF'\nfix: x\n\nCloses #226\nEOF"), {}, "a heredoc message");
  fs.writeFileSync(path.join(root, "msg.txt"), "fix\n\nRefs #12\n");
  fs.writeFileSync(path.join(root, "bare.txt"), "fix\n");
  assert.deepEqual(pre("git commit -F msg.txt"), {}, "the reference in the -F file");
  assert.match(pre("git commit --file=bare.txt").block ?? "", /commitRef/);
  assert.deepEqual(pre("git commit --amend --no-edit"), {}, "no message given: not checked");
  assert.deepEqual(pre("git commit-tree HEAD^{tree} -m x"), {}, "not a commit");
  wrote(root, "c2");
  assert.deepEqual(pre('git commit -m "fix: x"', "c2"), {}, "the session wrote to #12");
  sh(root, "switch", "-q", "-c", "feat/12-x");
  assert.deepEqual(pre('git commit -m "fix: x"'), {}, "the branch names the task");
  sh(root, "switch", "-q", "main");
  assert.deepEqual(check("PreToolUse", { cwd: tracked({ commitRef: false }), tool_name: "Bash", tool_input: { command: 'git commit -m "x"' } }), {}, "off");
  assert.deepEqual(check("PreToolUse", { cwd: repo(), tool_name: "Bash", tool_input: { command: 'git commit -m "x"' } }), {}, "no tracker");
});

test("fileWork (#223): a turn that committed or pushed with no Imprimatur write is asked once, with the hashes", () => {
  const root = tracked({ specFirst: false });
  const post = (command, stdout = "", session = "w1") => check("PostToolUse", { cwd: root, session_id: session, tool_name: "Bash", tool_input: { command }, tool_response: { stdout } });
  const stop = (session = "w1", active = false) => check("Stop", { cwd: root, session_id: session, last_assistant_message: "Done.", stop_hook_active: active }, { records: noRecords });
  post('git commit -m "Refs #1"', "[main abc1234] Refs #1\n 1 file changed\n");
  post("git push origin main");
  assert.match(stop().block ?? "", /fileWork.*this turn made commit abc1234, a git push without an Imprimatur task/);
  assert.deepEqual(stop(), {}, "once: the next stop of the turn has nothing");
  post("ls -la");
  assert.deepEqual(stop(), {}, "a turn without commits");
  post('git commit -m x', "[feat/2-y def5678] x\n");
  assert.deepEqual(stop("w1", true), {}, "not while the stop hook is already continuing");
  assert.deepEqual(stop(), {}, "and the list was taken then: no loop");
  post('git commit -m x', "[main 1111111] x\n", "w2");
  wrote(root, "w2");
  assert.deepEqual(stop("w2"), {}, "the session wrote to Imprimatur");

  const own = tracked({ specFirst: false, fileWork: { patterns: ["\\bmake ship\\b"] } });
  const ship = (command) => check("PostToolUse", { cwd: own, session_id: "d1", tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "" } });
  ship("npm publish");
  assert.deepEqual(check("Stop", { cwd: own, session_id: "d1", last_assistant_message: "x" }, { records: noRecords }), {}, "the repo's patterns replace the defaults");
  ship("make ship");
  assert.match(check("Stop", { cwd: own, session_id: "d1", last_assistant_message: "x" }, { records: noRecords }).block ?? "", /a deploy \(make ship\)/);

  const off = tracked({ fileWork: false, specFirst: false });
  check("PostToolUse", { cwd: off, session_id: "o", tool_name: "Bash", tool_input: { command: "git push" }, tool_response: { stdout: "" } });
  assert.deepEqual(check("Stop", { cwd: off, session_id: "o", last_assistant_message: "x" }, { records: noRecords }), {}, "off");
  const bare = repo({ process: { status: false, docUpdate: false, keepGoing: false, specFirst: false } });
  check("PostToolUse", { cwd: bare, session_id: "n", tool_name: "Bash", tool_input: { command: "git push" }, tool_response: { stdout: "" } });
  assert.deepEqual(check("Stop", { cwd: bare, session_id: "n", last_assistant_message: "x" }, { records: noRecords }), {}, "no tracker");
});

test("issueBody and specFirst (#223 comment): a task opened for an issue gets its body; an active task with no spec is asked for one, once", () => {
  const { openDb } = req("../vscode/db.js");
  const db = openDb({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-223-")), "x.db") });
  const root = tracked();
  const rid = db.repoOf(root).id;
  const records = { repoId: () => rid, recordsOf: () => [], dbOf: () => db };
  db.upsertTask(rid, "#30", { title: "From GitHub", status: "active" });
  const calls = [];
  const gh = (args) => (calls.push(args.join(" ")), JSON.stringify({ body: "Brief from GitHub" }));
  const upsert = (key) => check("PostToolUse", { cwd: root, session_id: "s1", tool_name: "mcp__imprimatur__task_upsert", tool_input: { key, status: "active" } }, { records, gh });
  upsert("#30");
  assert.equal(db.taskByKey(rid, "#30").issue_body, "Brief from GitHub");
  upsert("#30");
  assert.deepEqual(calls, ["issue view 30 --json body"], "a task with a body is left alone");

  const stop = (session = "s1") => check("Stop", { cwd: root, session_id: session, last_assistant_message: "Done." }, { records });
  assert.match(stop().block ?? "", /specFirst.*#30 has no spec; no task is left without one.*doc_section_upsert kind "spec", task "#30"/);
  assert.deepEqual(check("Stop", { cwd: root, session_id: "s1", last_assistant_message: "Done.", stop_hook_active: true }, { records }), {}, "no loop within a turn");
  assert.match(stop().block ?? "", /specFirst.*#30/, "the next turn asks again: until the spec exists");
  db.upsertSection(db.taskDocOf(rid, "#30", "spec").id, "problem", { title: "P", body: "Why." }, { kind: "agent" });
  check("PostToolUse", { cwd: root, session_id: "s2", tool_name: "mcp__imprimatur__record_add", tool_input: { task: "#30", kind: "note", title: "x" } }, { records });
  assert.deepEqual(stop("s2"), {}, "a task with a spec");
  // #227: an open task opened this turn is asked too; a done task and a bucket are not.
  db.upsertTask(rid, "#31", { title: "Open one", issueBody: "x" });
  check("PostToolUse", { cwd: root, session_id: "s3", tool_name: "mcp__imprimatur__task_upsert", tool_input: { key: "#31", title: "Open one" } }, { records, gh });
  assert.match(stop("s3").block ?? "", /specFirst.*#31 has no spec/, "an open task, just opened");
  db.upsertSection(db.taskDocOf(rid, "#31", "spec").id, "problem", { title: "P", body: "Why." }, { kind: "agent" });
  assert.deepEqual(stop("s3"), {}, "written: no more asking");
  db.upsertTask(rid, "#32", { title: "Finished", status: "done" });
  db.upsertTask(rid, "RECS", { title: "Bucket" });
  for (const [task, tool] of [["#32", "record_add"], ["RECS", "record_add"]])
    check("PostToolUse", { cwd: root, session_id: "s4", tool_name: `mcp__imprimatur__${tool}`, tool_input: { task, kind: "note", title: "x" } }, { records });
  assert.deepEqual(stop("s4"), {}, "a done task and a bucket are not asked");
});

test("no task without a spec (#227): the issue-created reminder and the issues skill name the spec", () => {
  const root = repo({ process: {} });
  const r = check("PostToolUse", { cwd: root, tool_name: "Bash", tool_input: { command: "gh issue create -t x -b y" }, tool_response: { stdout: "" } });
  assert.match(r.context[0], /write its spec now \(doc_section_upsert kind "spec", the to-spec gates\)/);
  const text = fs.readFileSync(new URL("../skills/issues/SKILL.md", import.meta.url), "utf8");
  assert.match(text, /Write its spec in the same turn:\*\* no task is left without one/);
});

test("issues skill (#223): work that becomes real gets a task without being asked", () => {
  const text = fs.readFileSync(new URL("../skills/issues/SKILL.md", import.meta.url), "utf8");
  assert.match(text, /becomes real gets a task without being asked.*first commit, push or deploy.*Refs #N/);
});

test("linkAccess (#165): a page WebFetch could not open becomes one link-access issue; a network hiccup does not", () => {
  const root = repo();
  sh(root, "remote", "add", "origin", "https://github.com/o/r.git");
  const calls = [];
  let next = 301;
  const gh = (args) => (calls.push(args), args[0] === "issue" ? `https://github.com/o/r/issues/${next++}\n` : args[0] === "repo" ? "PUBLIC\n" : "");
  const fail = (url, error) => check("PostToolUseFailure", { cwd: root, session_id: `S-${Math.random()}`, tool_name: "WebFetch", tool_input: { url }, error }, { records: noRecords, gh });
  const r = fail("https://www.example.com/report", "Request failed with status code 403");
  assert.match(r.context.join("\n"), /opened #301 \(label link-access\)/);
  const create = calls.find((a) => a[0] === "issue");
  assert.deepEqual(create.slice(0, 4), ["issue", "create", "--label", "link-access"]);
  assert.match(create[5], /^Link: www\.example\.com/);
  // A public repo's issue names the site only.
  assert.match(create[7], /^\*\*Site:\*\* www\.example\.com/);
  assert.doesNotMatch(create[7], /report/);
  // The same link again: the same issue, no new one.
  const again = fail("https://www.example.com/report", "403 Forbidden");
  assert.match(again.context.join("\n"), /#301/);
  assert.equal(calls.filter((a) => a[0] === "issue").length, 1);
  // DNS and timeouts are not closed pages.
  assert.deepEqual(fail("https://down.example.com/", "getaddrinfo ENOTFOUND down.example.com"), {});
  assert.equal(calls.filter((a) => a[0] === "issue").length, 1);
  // No query, fragment or user ever reaches the issue or the agent's line; the query-less link is the same link.
  const secret = fail("https://user:pw@www.example.com/report?token=abc#x", "403");
  assert.doesNotMatch(JSON.stringify(secret) + JSON.stringify(calls), /token=abc|user:pw/);
  assert.equal(calls.filter((a) => a[0] === "issue").length, 1);
  // At most three a session.
  const session = { cwd: root, session_id: "S-cap", tool_name: "WebFetch", error: "403" };
  for (const i of [1, 2, 3, 4]) check("PostToolUseFailure", { ...session, tool_input: { url: `https://site${i}.example.com/` } }, { records: noRecords, gh });
  assert.equal(calls.filter((a) => a[0] === "issue").length, 4);
});
