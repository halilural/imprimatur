// @ts-check
// The panel's Exercises tab (#108): the user's exercises, of no repo or task. /exercise in Claude
// Code turns a topic into small steps (exercise_save); here the user ticks them, skips one with
// why, keeps a note on each, and copies a command to ask the agent to split a step.
"use strict";
const { icon } = require("./tasksView.js");
const { mascot } = require("./mascot.js");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const KIND_LABEL = { learn: "Learn", example: "Example", predict: "Predict", do: "Do", vary: "Vary", explain: "Explain", recall: "Recall" };
const STATUS_LABEL = { active: "In progress", done: "Done", dropped: "Dropped" };
const NOTE_MAX = 4000;

/**
 * The tab's model: the active exercises with their steps, and the finished ones by name.
 * @param {any} db
 */
function exerciseModel(db) {
  const active = db.exercises({ status: "active" }).map((/** @type {any} */ e) => withNow(db.exercise(e.id)));
  const finished = [...db.exercises({ status: "done", limit: 50 }), ...db.exercises({ status: "dropped", limit: 50 })]
    .sort((a, b) => b.updated_at - a.updated_at).slice(0, 50);
  return { active, finished };
}

/** The step to do now: the first open one that is not split (a split step is done through its smaller steps). @param {any} e */
function withNow(e) {
  const split = new Set(e.steps.filter((/** @type {any} */ s) => s.parent_id).map((/** @type {any} */ s) => s.parent_id));
  const top = e.steps.filter((/** @type {any} */ s) => !s.parent_id);
  const now = e.steps.find((/** @type {any} */ s) => s.status === "open" && !split.has(s.id));
  return { ...e, split, now, total: top.length, closed: top.filter((/** @type {any} */ s) => s.status !== "open").length };
}

/** One step: its box (none on a split step: its smaller steps tick it), text, and actions. @param {any} e @param {any} s */
function stepHtml(e, s) {
  const done = s.status === "done";
  const skipped = s.status === "skipped";
  const isSplit = e.split.has(s.id);
  const box = isSplit
    ? `<span class="check split${done ? " on" : ""}" title="Done when its smaller steps are">${done ? icon("check", 12) : ""}</span>`
    : `<button class="check${done ? " on" : ""}" data-act="exStep" data-id="${s.id}" data-status="${done ? "open" : "done"}" aria-label="${done ? "Open again" : "Mark as done"}">${done ? icon("check", 12) : ""}</button>`;
  const meta = [
    `<span class="xkind x-${esc(s.kind)}">${esc(KIND_LABEL[/** @type {keyof typeof KIND_LABEL} */ (s.kind)] ?? s.kind)}</span>`,
    s.minutes ? `<span class="dim">${icon("clock", 12)} ${s.minutes} min</span>` : "",
    e.now?.id === s.id ? `<span class="next">${icon("arrow", 12)} now</span>` : "",
    skipped ? `<span class="dim">skipped</span>` : "",
  ].join("");
  const acts = [
    !isSplit && s.status === "open" ? `<button class="mini" data-act="exStep" data-id="${s.id}" data-status="skipped" title="Skip it; say why in its note">${icon("skip", 12)} skip</button>` : "",
    skipped ? `<button class="mini show" data-act="exStep" data-id="${s.id}" data-status="open">undo skip</button>` : "",
    !s.parent_id && !isSplit && s.status === "open" ? `<button class="mini" data-act="exCopy" data-text="${esc(`/exercise split step ${s.id} of exercise ${e.id}`)}" title="Copies a command: paste it in Claude Code and the agent splits this step">${icon("copy", 12)} split</button>` : "",
  ].join("");
  const note = `<details class="xnote"${s.note ? " open" : ""}><summary>${s.note ? "Note" : "Add a note"}</summary><div class="xnrow"><textarea data-draft="exnote-${s.id}" rows="2" maxlength="${NOTE_MAX}" placeholder="What you found, where you got stuck, why you skipped it">${esc(s.note ?? "")}</textarea><button class="ghost" data-act="exNote" data-id="${s.id}">Save</button></div></details>`;
  // Keyed by its own change and whether it is now: a tick redraws that step and the next, not the card.
  return `<li class="xstep${done ? " done" : ""}${skipped ? " skipped" : ""}${s.parent_id ? " sub" : ""}${e.now?.id === s.id ? " now" : ""}" data-k="s${s.id}-${s.updated_at}${e.now?.id === s.id ? "n" : ""}" id="xs-${s.id}">${box}<div class="xcol"><div class="xhead"><span class="ttl">${esc(s.title)}</span>${meta}<span class="xacts">${acts}</span></div>${s.why ? `<p class="xwhy"><span class="lbl">Why</span> ${esc(s.why)}</p>` : ""}${s.done_when ? `<p class="xwhy"><span class="lbl">Done when</span> ${esc(s.done_when)}</p>` : ""}${note}</div></li>`;
}

/** An active exercise as a card. @param {ReturnType<typeof withNow>} e */
function exerciseCard(e) {
  const pct = e.total ? Math.round((e.closed / e.total) * 100) : 0;
  const head = `<div class="xhd" data-k="h${e.updated_at}"><div class="xtop"><h2>${icon("target", 18)}${esc(e.topic)}</h2><span class="dim">${e.closed} / ${e.total} steps</span><button class="mini show" data-act="exDrop" data-id="${e.id}" title="Give up on this exercise; it stays under Finished">drop</button></div>
<div class="progress" role="progressbar" aria-label="${esc(e.topic)} progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="width: ${pct}%"></div></div></div>`;
  const goal = e.goal || e.proof ? `<div class="xgoal" data-k="g${e.updated_at}">${e.goal ? `<p><span class="lbl">Goal</span> ${esc(e.goal)}</p>` : ""}${e.proof ? `<p><span class="lbl">Checked by</span> ${esc(e.proof)}</p>` : ""}</div>` : "";
  const now = e.now ? `<a href="#" class="callout xnow" data-k="n${e.now.id}" data-act="exGo" data-id="${e.now.id}">${icon("arrow", 18)}<div><span class="lbl">Now</span><span class="ptitle">${esc(e.now.title)}</span></div></a>` : "";
  const weak = e.weak.length ? `<div class="xweak" data-k="w${e.updated_at}"><span class="lbl">Weak points</span><ul>${e.weak.map((/** @type {string} */ w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
  // A stable key with keyed children: the page swaps only what changed, so a half-typed note stays.
  return `<section class="card xcard" data-k="x${e.id}" aria-label="${esc(e.topic)}">${head}${goal}${now}<ol class="xsteps" data-k="steps">${e.steps.map((/** @type {any} */ s) => stepHtml(e, s)).join("")}</ol>${weak}</section>`;
}

/** The tab. @param {ReturnType<typeof exerciseModel>} m */
function exerciseHtml(m) {
  const cmd = `<button class="ghost" data-act="exCopy" data-text="/exercise " title="Copies /exercise: paste it in Claude Code with your topic">${icon("copy", 13)} /exercise</button>`;
  const top = `<div class="toprow" data-k="xtop"><div><h1>Exercises</h1><p class="lead">Any topic, in small steps you tick. Start one in Claude Code: <span class="mono">/exercise &lt;topic&gt;</span>. The agent asks a few questions, then breaks it into steps with what each is for and when it counts as done.</p></div>${cmd}</div>`;
  const cards = m.active.length
    ? m.active.map(exerciseCard).join("")
    : `<div class="emptyhero" data-k="xnone">${mascot(56)}<p><b>No exercise going.</b><br>Type <span class="mono">/exercise</span> and a topic in Claude Code: code, a language, a concept, a sport.</p></div>`;
  const finished = m.finished.length
    ? `<details class="blk xdone" data-k="xdone-${m.finished.map((/** @type {any} */ e) => `${e.id}.${e.updated_at}`).join("_")}"><summary><h2>Finished <span class="dim">· ${m.finished.length}</span></h2></summary>${m.finished.map((/** @type {any} */ e) => `<div class="xrow"><span class="st st-${e.status}">${STATUS_LABEL[/** @type {keyof typeof STATUS_LABEL} */ (e.status)] ?? esc(e.status)}</span><b>${esc(e.topic)}</b><span class="dim">${e.closed} / ${e.step_count} steps</span>${e.status === "dropped" ? `<button class="mini show" data-act="exResume" data-id="${e.id}">resume</button>` : ""}</div>`).join("")}</details>`
    : "";
  return `<div class="exercises" data-k="exercises">${top}<div class="xcards" data-k="xcards" data-navgroup="exercises">${cards}</div>${finished}</div>`;
}

const id = (/** @type {any} */ v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Imprimatur: bad id ${v}`);
  return n;
};

/**
 * A write from the tab: a step ticked, skipped or opened again, its note, an exercise dropped
 * or resumed. @param {any} db @param {any} m
 */
function applyExerciseMessage(db, m) {
  switch (m?.type) {
    case "exStep":
      if (!["open", "done", "skipped"].includes(m.status)) throw new Error(`Imprimatur: bad step status ${m.status}`);
      return db.updateStep(id(m.id), { status: m.status });
    case "exNote":
      if (typeof m.text !== "string" || m.text.length > NOTE_MAX) throw new Error("Imprimatur: bad note");
      return db.updateStep(id(m.id), { note: m.text });
    case "exDrop":
      return db.saveExercise({ id: id(m.id), status: "dropped" });
    case "exResume":
      // Back to active; done again at once when every step already is (saveExercise settles).
      return db.saveExercise({ id: id(m.id), status: "active" });
    default:
      throw new Error(`Imprimatur: unknown exercise message ${m?.type}`);
  }
}

const EXERCISE_MESSAGES = ["exStep", "exNote", "exDrop", "exResume"];

const EXERCISE_CSS = `
  .exercises { display: flex; flex-direction: column; gap: 18px; max-width: 980px; }
  .toprow { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .toprow .ghost { display: inline-flex; align-items: center; gap: 6px; }
  .xcards { display: flex; flex-direction: column; gap: 18px; }
  .xcard { display: flex; flex-direction: column; gap: 12px; padding: 18px 20px; }
  .xtop { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .xtop h2 { flex: 1; min-width: 0; }
  .xhd { display: flex; flex-direction: column; gap: 10px; } .xcard .progress { margin-top: 0; }
  .mini.show { opacity: .9; }
  .xgoal p, .xwhy { margin: 0; } .xgoal { display: flex; flex-direction: column; gap: 4px; }
  .xgoal .lbl, .xwhy .lbl, .xweak .lbl { margin-right: 6px; }
  a.callout.xnow { text-decoration: none !important; } a.callout.xnow:hover { background: color-mix(in srgb, var(--acc) 18%, transparent); }
  .xsteps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .xstep { display: flex; align-items: flex-start; gap: 12px; padding: 8px 10px; border-radius: 8px; }
  .xstep:hover { background: var(--vscode-list-hoverBackground); }
  .xstep.now { box-shadow: inset 3px 0 0 var(--acc); background: var(--acc-soft); }
  .xstep.sub { margin-left: 30px; }
  .xstep.done .ttl, .xstep.skipped .ttl { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .xstep .check { margin-top: 3px; } .check.split { cursor: default; border-style: dashed; }
  .xcol { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .xhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .xhead .ttl { font-weight: 700; min-width: 0; }
  .xacts { margin-left: auto; display: flex; gap: 6px; } .xstep:hover .mini, .xstep:focus-within .mini { opacity: .9; }
  .xwhy { font-size: 13px; color: var(--vscode-descriptionForeground); }
  .xkind { flex: none; display: inline-flex; padding: 0 8px; border-radius: 10px; font-size: 12px; font-weight: 700; border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 18%, transparent); }
  .x-learn { --c: var(--vscode-charts-blue); } .x-example { --c: var(--vscode-charts-purple); } .x-predict { --c: var(--vscode-charts-yellow); }
  .x-do { --c: var(--acc); } .x-vary { --c: var(--vscode-charts-red); } .x-explain { --c: var(--vscode-charts-green); } .x-recall { --c: var(--vscode-charts-orange, var(--acc)); }
  .xnote summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); width: fit-content; }
  .xnrow { display: flex; gap: 8px; align-items: flex-end; margin-top: 4px; }
  .xnrow textarea { flex: 1; resize: vertical; min-height: 36px; padding: 6px 9px; border-radius: 6px; font: inherit; font-size: 13px;
    border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .xweak ul { margin: 4px 0 0; padding-left: 20px; }
  .xdone summary { cursor: pointer; list-style: none; } .xdone summary::-webkit-details-marker { display: none; }
  .xrow { display: flex; align-items: center; gap: 10px; padding: 6px 4px; }
`;

module.exports = { exerciseModel, exerciseHtml, applyExerciseMessage, EXERCISE_MESSAGES, EXERCISE_CSS, withNow };
