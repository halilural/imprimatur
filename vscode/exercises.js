// @ts-check
// Exercises (#108) for the new panel's More (#202): the user's exercises, of no repo or task, with the
// step to do now; and the writes from the page (a step ticked, skipped or noted, an exercise dropped
// or resumed, a recall graded). Kept from the old exerciseView.js.
"use strict";

const NOTE_MAX = 4000;

const RESULT_LABEL = { right: "Got it", partly: "Partly", missed: "Missed" };

/**
 * The tab's model: the active exercises with their steps, and the finished ones by name.
 * @param {any} db
 */
function exerciseModel(db, now = Date.now()) {
  const reviews = db.reviews({ now });
  const counts = db.reviewCounts(now);
  const active = db.exercises({ status: "active" }).map((/** @type {any} */ e) => withNow(db.exercise(e.id)));
  const finished = [...db.exercises({ status: "done", limit: 50 }), ...db.exercises({ status: "dropped", limit: 50 })]
    .sort((a, b) => b.updated_at - a.updated_at).slice(0, 50);
  return { active, finished, reviews, next: counts.next };
}

/** The step to do now: the first open one that is not split (a split step is done through its smaller steps). @param {any} e */
function withNow(e) {
  const split = new Set(e.steps.filter((/** @type {any} */ s) => s.parent_id).map((/** @type {any} */ s) => s.parent_id));
  const top = e.steps.filter((/** @type {any} */ s) => !s.parent_id);
  const now = e.steps.find((/** @type {any} */ s) => s.status === "open" && !split.has(s.id));
  return { ...e, split, now, total: top.length, closed: top.filter((/** @type {any} */ s) => s.status !== "open").length };
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
    case "exReview":
      if (!Object.hasOwn(RESULT_LABEL, m.result)) throw new Error(`Imprimatur: bad recall result ${m.result}`);
      return db.answerReview(id(m.id), m.result);
    default:
      throw new Error(`Imprimatur: unknown exercise message ${m?.type}`);
  }
}

const EXERCISE_MESSAGES = ["exStep", "exNote", "exDrop", "exResume", "exReview"];

module.exports = { exerciseModel, withNow, applyExerciseMessage, EXERCISE_MESSAGES };
