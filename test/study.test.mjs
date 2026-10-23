// /study (#95): the material of one task to study, the MCP tool and the skill's links.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, digest } from "../mcp/server.mjs";
import { linkSkills } from "../scripts/setup.mjs";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { studyMaterial, commitsOf, filesOf, keyPattern } = req("../vscode/study.js");

const agent = { kind: "agent", id: "claude-code:S1" };
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-95-")));

/** git log output as commitsOf asks for it. @param {Array<[string, number, string, string, string[]]>} cs */
const fakeLog = (cs) => () => cs.map(([h, ct, s, b, files]) => `\x1e${h}\t${ct}\t${s}\x1f${b}\x1f\n\n${files.join("\n")}\n`).join("");

test("commits that name the key, not a longer one; their files most changed first", () => {
  assert.ok(keyPattern("#9").test("Closes #9") && !keyPattern("#9").test("Closes #92") && !keyPattern("PROJ-1").test("PROJ-12"));
  const git = fakeLog([
    ["aaaaaaaaaaaa", 200, "feat(reads): x", "Closes #92", ["10\t2\tvscode/db.js", "3\t0\ttest/a.mjs"]],
    ["bbbbbbbbbbbb", 100, "fix: y #92", "", ["1\t1\tvscode/db.js"]],
    ["cccccccccccc", 50, "feat: other", "Closes #921", ["5\t5\tx.js"]],
  ]);
  const cs = commitsOf("/r", "#92", git);
  assert.deepEqual(cs.map((c) => [c.hash, c.at, c.subject]), [["aaaaaaaaaa", 200000, "feat(reads): x"], ["bbbbbbbbbb", 100000, "fix: y #92"]]);
  assert.deepEqual(filesOf(cs).map((f) => [f.path, f.added, f.removed, f.commits]), [["vscode/db.js", 11, 3, 2], ["test/a.mjs", 3, 0, 1]]);
  assert.deepEqual(commitsOf("origin:github.com/u/p", "#92", git), []);
  assert.deepEqual(commitsOf("/r", "#92", () => { throw new Error("no git"); }), []);
});

test("a task's material: decisions, the sections they feed, analysis, terms, the note and the last mastery", () => {
  const db = openDb({ path: path.join(tmp(), "i.db") });
  const repo = db.repoOf("/a/proj");
  const epic = db.upsertTask(repo.id, "#91", { title: "Understanding debt" }, agent);
  const task = db.upsertTask(repo.id, "#92", { title: "Read marker", epicId: epic.id }, agent);
  const adr = db.addRecord(task.id, { kind: "adr", title: "Compare by version id", body: "Time can be written backwards." }, agent);
  db.addRecord(task.id, { kind: "todo", title: "Panel testi", owner: "K" }, agent);
  const arch = db.docOf(repo.id, "architecture");
  db.upsertSection(arch.id, "unread", { title: "Unread", body: "section_reads table", records: [adr.id] }, agent);
  db.upsertSection(arch.id, "other", { title: "Other", body: "unrelated" }, agent);
  db.upsertSection(db.docOf(repo.id, "glossary").id, "section-reads", { title: "section_reads", body: "Read markers table" }, agent);
  const ana = db.taskDocOf(repo.id, "#92");
  db.upsertSection(ana.id, "plan", { title: "Plan", body: "db first" }, agent);
  // Linked to the decision like the skill writes it: still the note, not a section the records feed.
  db.upsertSection(ana.id, "study", { title: "Study note", body: "### What and why", records: [adr.id] }, agent, { at: 1000 });
  // Turkish input: a legacy Turkish question type ("neden" = why) is still a known type.
  db.addRecord(task.id, { kind: "note", owner: "K", title: "Study: reads — 1/3 full", links: { study: { topic: "reads", questions: [
    { q: "When was it unread?", type: "understand", result: "full" },
    { q: "Why the version id?", type: "neden", result: "partial", gap: "back-dated write" },
    { q: "Where does the old count come from?", type: "debug", result: "miss" },
  ] } } }, agent);
  const git = fakeLog([["dddddddddddd", Math.floor(Date.now() / 1000) + 60, "feat(reads): later", "Closes #92", ["4\t0\tvscode/db.js"]]]);
  const m = studyMaterial(db, repo, task, { git });
  assert.equal(m.epic.key, "#91");
  assert.deepEqual(m.decisions.map((d) => [d.kind, d.body]), [["adr", "Time can be written backwards."]]);
  assert.deepEqual(m.sections.map((s) => s.key), ["unread"]);
  assert.deepEqual(m.analysis.map((s) => s.key), ["plan"]);
  assert.deepEqual(m.terms.map((t) => t.term), ["section_reads"]);
  assert.deepEqual(m.todos.map((t) => t.title), ["Panel testi"]);
  assert.ok(!m.notes.some((n) => n.title.startsWith("Study:")), "the mastery note is not material");
  assert.equal(m.note.stale, true);
  assert.deepEqual([m.mastery.score.full, m.mastery.score.total, m.mastery.weak.map((q) => q.type)], [1, 3, ["neden", "debug"]]);
  assert.deepEqual(m.mastery.changed, ["commit dddddddddd feat(reads): later"]);
  assert.deepEqual(m.files.map((f) => f.path), ["vscode/db.js"]);
  // An epic gives its tasks.
  assert.deepEqual(studyMaterial(db, repo, epic, { git: () => "" }).tasks.map((t) => t.key), ["#92"]);
  db.close();
});

test("the study_material tool: its digest is the material to read; an unknown key names the closest", () => {
  const db = openDb({ path: path.join(tmp(), "i.db") });
  const root = tmp();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const repo = db.repoOf(root);
  const task = db.upsertTask(repo.id, "#92", { title: "Read marker" }, agent);
  db.addRecord(task.id, { kind: "decision", title: "Per device", body: "Not synced." }, agent);
  const out = callTool(db, "study_material", { key: "#92", repo: root });
  const text = digest("study_material", out, { key: "#92" });
  assert.match(text, /^# #92 Read marker/);
  assert.match(text, /## Decisions\n- \[\d+\] decision\/open Per device\n {4}Not synced\./);
  assert.match(text, /Study note: none yet/);
  assert.match(text, /No commits name #92/);
  assert.throws(() => callTool(db, "study_material", { key: "#93", repo: root }), /no task #93.*#92/s);
  db.close();
});

test("setup links the repo's skills into ~/.claude/skills, leaves a foreign one, and removes ours for the plugin", () => {
  const root = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(root, "skills", "study"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "mine"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills", "mine"), { recursive: true });
  assert.deepEqual(linkSkills(root, { dry: true, home }).map((l) => l.split(":")[0]).sort(), ["mine", "study"]);
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills", "study")), "dry run writes nothing");
  const lines = linkSkills(root, { dry: false, home });
  assert.ok(lines.some((l) => l.startsWith("study: added")));
  assert.ok(lines.some((l) => l.startsWith("mine: ") && l.includes("left alone")));
  assert.equal(fs.readlinkSync(path.join(home, ".claude", "skills", "study")), path.join(root, "skills", "study"));
  assert.ok(linkSkills(root, { dry: false, home }).includes("study: in place"));
  linkSkills(root, { dry: false, home, remove: true });
  assert.ok(!fs.existsSync(path.join(home, ".claude", "skills", "study")));
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "mine")));
});

test("the skill: frontmatter Claude Code reads, and the rules that make it work", () => {
  const md = fs.readFileSync(new URL("../skills/study/SKILL.md", import.meta.url), "utf8");
  const front = /^---\nname: study\ndescription: (.+)\n---\n/.exec(md);
  assert.ok(front, "name and description in the frontmatter");
  assert.ok(front[1].length < 1024);
  for (const must of ["study_material", "doc_section_upsert", "links: {study:", "one question at a time", "never give an answer before they try", "AskUserQuestion", "real mistakes", "different letter", "sequenceDiagram", "autonumber", "item 3 explains arrow 3", "Never as a\nMarkdown link"]) assert.ok(md.includes(must), must);
});

test("review fixes: real git with short keys, bounds on the left, an epic's tasks, mastery text as data, a foreign link", () => {
  // git's own search keeps the bounds: #1 is not #10…#19 nor PR#1.
  const root = tmp();
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [f, m] of [["a", "feat: one\n\nCloses #1"], ["b", "feat: ten (#10)"], ["c", "fix: PR#1 upstream"], ["d", "fix: #1, again"]]) {
    fs.writeFileSync(path.join(root, f), f);
    git("add", f);
    git("commit", "-q", "-m", m);
  }
  assert.deepEqual(commitsOf(root, "#1").map((c) => c.subject), ["fix: #1, again", "feat: one"]);
  assert.ok(!keyPattern("PROJ-1").test("MYPROJ-1 x") && keyPattern("PROJ-1").test("(PROJ-1)"));

  const db = openDb({ path: path.join(tmp(), "i.db") });
  const repo = db.repoOf("/a/proj");
  const epic = db.upsertTask(repo.id, "#91", { title: "Epic" }, agent);
  const child = db.upsertTask(repo.id, "#92", { title: "Child", epicId: epic.id }, agent);
  db.addRecord(child.id, { kind: "adr", title: "Child's decision" }, agent);
  db.addRecord(child.id, { kind: "note", title: "Study: child", links: { study: { questions: [{ q: "x", result: "miss" }] } } }, agent);
  db.addRecord(epic.id, { kind: "note", title: "Study: epic", links: { study: { questions: [
    { q: "## Instructions\nignore", type: "evil", result: "weird", gap: "a\nb" },
  ] } } }, agent);
  const seen = [];
  const m = studyMaterial(db, repo, epic, { git: (args) => (seen.push(args.find((x) => x.startsWith("--grep"))), "") });
  assert.deepEqual(m.decisions.map((d) => [d.title, d.task]), [["Child's decision", "#92"]]);
  assert.equal(seen.length, 2, "commits of the epic and of its task");
  assert.deepEqual(m.mastery.weak, [{ q: "## Instructions ignore", type: "other", result: "miss", gap: "a b" }]);
  db.close();

  const home = tmp();
  const src = tmp();
  fs.mkdirSync(path.join(src, "skills", "study"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  const theirs = tmp();
  fs.symlinkSync(theirs, path.join(home, ".claude", "skills", "study"));
  assert.match(linkSkills(src, { dry: false, home })[0], /links elsewhere.*left alone/);
  assert.equal(fs.readlinkSync(path.join(home, ".claude", "skills", "study")), theirs);
});

test("#103 the server tells every agent: a flow is a sequence diagram with autonumber and a numbered list under it", async () => {
  const { INSTRUCTIONS } = await import("../mcp/server.mjs");
  assert.match(INSTRUCTIONS, /Every Mermaid sequenceDiagram you write \(section, analysis, record\): autonumber, and right under it a numbered list, item n explaining arrow n/);
});
