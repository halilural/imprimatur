// Exercise mode (#108): exercises of no repo, split steps, progress that follows the ticks, the
// MCP tools' text, the panel's tab and its writes, and the /exercise skill.
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, digest } from "../mcp/server.mjs";

const req = createRequire(import.meta.url);
const { openDb, VERSION } = req("../vscode/db.js");
// The panel's views load without VS Code: only the extension host has "vscode".
const load = Module._load;
Module._load = function (r, ...a) {
  return r === "vscode" ? {} : load.call(this, r, ...a);
};
const tasksView = req("../vscode/tasksView.js");
const { exerciseModel, exerciseHtml } = req("../vscode/exerciseView.js");
Module._load = load;

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-108-")));
const user = { kind: "user", id: "me" };
const steps = [
  { kind: "learn", title: "Read JEP 444", why: "See the problem", done_when: "Two sentences written", minutes: 15 },
  { kind: "predict", title: "Predict the timings" },
  { kind: "recall", title: "Three questions without notes", minutes: 5 },
];

test("an exercise belongs to no repo; steps keep their order and kinds; bad input is refused", () => {
  const db = openDb({ path: path.join(tmp(), "i.db") });
  assert.equal(db.version, VERSION);
  const e = db.saveExercise({ topic: "  Virtual threads ", goal: "Explain and measure", proof: "Recall + numbers", context: "used it a little", steps });
  assert.equal(e.topic, "Virtual threads");
  assert.equal(e.status, "active");
  assert.deepEqual(e.steps.map((s) => [s.kind, s.title, s.status]), [["learn", "Read JEP 444", "open"], ["predict", "Predict the timings", "open"], ["recall", "Three questions without notes", "open"]]);
  assert.equal(e.steps[1].kind, "predict");
  assert.equal(db.saveExercise({ topic: "x", steps: [{ title: "no kind" }] }).steps[0].kind, "do", "a step's kind is do unless said");
  assert.throws(() => db.saveExercise({ topic: " " }), /needs a topic/);
  assert.throws(() => db.saveExercise({ topic: "t", steps: [{ kind: "read", title: "x" }] }), /not one of learn/);
  assert.throws(() => db.saveExercise({ topic: "t", steps: [{ title: "x", minutes: 0 }] }), /minutes/);
  assert.throws(() => db.saveExercise({ topic: "t", steps: [{ title: "" }] }), /needs a title/);
  assert.throws(() => db.saveExercise({ id: 999, goal: "g" }), /no exercise 999/);
  assert.throws(() => db.saveExercise({ id: e.id, steps: [{ id: 999, status: "done" }] }), /no step 999/);
  // A failed save writes nothing: the steps before the bad one are rolled back too.
  assert.throws(() => db.saveExercise({ id: e.id, steps: [{ title: "kept?" }, { title: "x", kind: "bad" }] }));
  assert.equal(db.exercise(e.id).steps.length, 3);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM tasks").get().n, 0, "no task is made");
});

test("ticks drive progress: a split step is done through its smaller steps, the exercise when all are", () => {
  const db = openDb({ path: path.join(tmp(), "i.db") });
  const e = db.saveExercise({ topic: "Virtual threads", steps });
  const [read, predict, recall] = e.steps;
  const split = db.saveExercise({ id: e.id, steps: [{ parent_id: predict.id, title: "Platform pool" }, { parent_id: predict.id, title: "Virtual threads" }] });
  assert.deepEqual(split.steps.map((s) => s.title), ["Read JEP 444", "Predict the timings", "Platform pool", "Virtual threads", "Three questions without notes"], "smaller steps right under theirs");
  const [, , a, b] = split.steps;
  assert.throws(() => db.saveExercise({ id: e.id, steps: [{ parent_id: a.id, title: "deeper" }] }), /not split again/);

  db.updateStep(read.id, { status: "done" });
  db.updateStep(a.id, { status: "done" });
  assert.equal(db.exercise(e.id).steps.find((s) => s.id === predict.id).status, "open", "one smaller step open: the step stays open");
  db.updateStep(b.id, { status: "skipped", note: "no JDK here" });
  assert.equal(db.exercise(e.id).steps.find((s) => s.id === predict.id).status, "done", "done or skipped: the step is done");
  assert.equal(db.exercise(e.id).status, "active");
  db.updateStep(recall.id, { status: "done" });
  const done = db.exercise(e.id);
  assert.equal(done.status, "done", "every step closed: the exercise is done");
  assert.ok(done.steps.find((s) => s.id === recall.id).done_at > 0);
  assert.deepEqual(db.exercises().map((x) => x.id), [], "active list leaves it out");
  assert.deepEqual(db.exercises({ status: "all" }).map((x) => [x.step_count, x.closed]), [[3, 3]], "a split step counts once");

  db.updateStep(b.id, { status: "open" });
  const back = db.exercise(e.id);
  assert.equal(back.status, "active", "a step opened again: active again");
  assert.equal(back.steps.find((s) => s.id === predict.id).status, "open");
  assert.equal(back.steps.find((s) => s.id === predict.id).done_at, null);

  db.saveExercise({ id: e.id, status: "dropped" });
  db.updateStep(b.id, { status: "done" });
  assert.equal(db.exercise(e.id).status, "dropped", "a dropped exercise stays dropped while ticked");
  db.saveExercise({ id: e.id, status: "active" });
  assert.equal(db.exercise(e.id).status, "done", "resumed with every step closed: done at once");
  db.updateStep(b.id, { status: "open" });
  assert.equal(db.saveExercise({ id: e.id, status: "done" }).status, "active", "done follows the steps, not the call");
  assert.throws(() => db.saveExercise({ id: e.id, steps: [{ title: "x", position: "top" }] }), /position must be a number/);
  assert.equal(db.saveExercise({ id: e.id, steps: [{ title: "no parent", parent_id: null }] }).steps.at(-1).parent_id, null, "parent_id null: a top-level step");
  db.saveExercise({ id: e.id, weak: [" carrier vs virtual ", ""] });
  assert.deepEqual(db.exercise(e.id).weak, ["carrier vs virtual"]);
});

test("MCP: exercise_save and exercise_get, with the text the agent reads", () => {
  const db = openDb({ path: path.join(tmp(), "i.db") });
  const saved = callTool(db, "exercise_save", { topic: "Polish greetings", goal: "Greet and introduce yourself", steps: steps.slice(0, 2) });
  const e = saved.exercise;
  const text = digest("exercise_save", saved);
  assert.match(text, /^Saved exercise \[\d+\] Polish greetings \[active\] 0\/2 steps/);
  assert.match(text, /\[ \] \[\d+\] learn: Read JEP 444 \(15 min\) ← now\n    why: See the problem\n    done when: Two sentences written/);
  callTool(db, "exercise_save", { id: e.id, steps: [{ id: e.steps[0].id, status: "done", note: "said it twice" }, { parent_id: e.steps[1].id, title: "Smaller" }] });
  const got = callTool(db, "exercise_get", { id: e.id });
  assert.equal(got.exercises.length, 1);
  const one = digest("exercise_get", got, { id: e.id });
  assert.match(one, /\[x\] \[\d+\] learn: Read JEP 444 \(15 min\)\n[\s\S]*note: said it twice/);
  assert.match(one, /\n    \[ \] \[\d+\] do: Smaller ← now/, "the smaller step is now, indented");
  assert.equal(digest("exercise_get", callTool(db, "exercise_get", {}), {}), `1 exercise:\n- [${e.id}] Polish greetings [active] 1/2 steps — Greet and introduce yourself`);
  assert.equal(digest("exercise_get", callTool(db, "exercise_get", { status: "done" }), { status: "done" }), "No done exercises.");
  assert.throws(() => callTool(db, "exercise_get", { id: 999 }), /no exercise 999/);
  assert.throws(() => callTool(db, "exercise_save", { topic: "t", steps: [{ title: "x", kind: "nope" }] }), (err) => !/^Imprimatur:/.test(err.message) && /not one of/.test(err.message));
  assert.throws(() => callTool(db, "exercise_save", { topic: "t", repo: "/x" }), /unknown argument "repo"/, "no repo: exercises are the user's");
});

test("the Exercises tab: the now step, split and skip, notes; its writes; finished ones below", () => {
  const db = openDb({ path: path.join(tmp(), "i.db") });
  assert.match(tasksView.paneHtml(db, "/any/repo", { tab: "exercises" }), /No exercise going/);
  const e = db.saveExercise({ topic: "Virtual <threads>", goal: "Explain & measure", steps });
  const [read, predict, recall] = e.steps;
  db.saveExercise({ id: e.id, steps: [{ parent_id: predict.id, title: "Platform pool" }] });
  tasksView.applyMessage(db, { type: "exStep", id: read.id, status: "done" }, user);
  tasksView.applyMessage(db, { type: "exNote", id: read.id, text: "Two sentences: <done>" }, user);
  const html = tasksView.paneHtml(db, "/any/repo", { tab: "exercises" });
  assert.ok(html.includes("Virtual &lt;threads&gt;") && html.includes("Explain &amp; measure") && html.includes("Two sentences: &lt;done&gt;"), "text is escaped");
  assert.equal((html.match(/> now<\/span>/g) ?? []).length, 1, "one now step");
  const sub = db.exercise(e.id).steps.find((s) => s.parent_id);
  assert.match(html, new RegExp(`id="xs-${sub.id}"[^>]*>.*?</li>`), "the smaller step is listed");
  assert.ok(html.includes(`data-k="x${e.id}" `) && html.includes(`data-draft="exnote-${read.id}"`), "a stable card key; notes kept as drafts over redraws");
  assert.match(html, new RegExp(`class="xstep sub now"[^>]*id="xs-${sub.id}"`), "the smaller step is now, not the split one");
  assert.ok(!html.includes(`data-act="exStep" data-id="${predict.id}" data-status="done"`), "a split step has no box of its own");
  assert.ok(html.includes(`/exercise split step ${recall.id} of exercise ${e.id}`), "an open step can be split");
  assert.ok(!html.includes(`split step ${sub.id} `), "a smaller step cannot");
  assert.throws(() => tasksView.applyMessage(db, { type: "exStep", id: recall.id, status: "gone" }, user), /bad step status/);
  assert.throws(() => tasksView.applyMessage(db, { type: "exNote", id: recall.id, text: "x".repeat(4001) }, user), /bad note/);

  tasksView.applyMessage(db, { type: "exDrop", id: e.id }, user);
  let m = exerciseModel(db);
  assert.deepEqual([m.active.length, m.finished.map((x) => x.status)], [0, ["dropped"]]);
  assert.match(exerciseHtml(m), /Finished <span class="dim">· 1<\/span>[\s\S]*data-act="exResume"/);
  tasksView.applyMessage(db, { type: "exResume", id: e.id }, user);
  m = exerciseModel(db);
  assert.equal(m.active.length, 1);
  assert.deepEqual(tasksView.cleanView({ tab: "exercises" }), { tab: "exercises" });
});

test("the /exercise skill: its name, the tools it names, and the rules that make it work", () => {
  const md = fs.readFileSync(new URL("../skills/exercise/SKILL.md", import.meta.url), "utf8");
  assert.match(md, /^---\nname: exercise\ndescription: .+\n---\n/);
  for (const t of ["exercise_save", "exercise_get", "parent_id", "done_when", "skipped", "weak"]) assert.ok(md.includes(t), t);
  for (const kind of ["learn", "example", "predict", "do", "vary", "explain", "recall"]) assert.ok(md.includes(kind), kind);
  assert.match(md, /Do not do it for them/);
  assert.ok(md.length < 20_000, "short enough to load at once");
});
