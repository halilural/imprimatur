// @ts-check
// Dismiss / reopen a recommendation (#87), the same from the Recommendations tree and
// the RECS page: why, from one list (the producer's reasons, the likely one first);
// "decided against" asks which decision record settles it; a note is kept in the body.
"use strict";
const vscode = require("vscode");
const recs = require("./recs.js");

/** @type {import("./db.js").Actor} */
const USER = { kind: "user" };

/**
 * Dismiss (status "dropped") or reopen ("open") or mark applied ("done") a record of
 * either producer. False when the user cancelled or it is not a recommendation.
 * @param {any} db @param {number} id @param {"dropped" | "open" | "done"} status @returns {Promise<boolean>}
 */
async function setRecommendation(db, id, status) {
  const rec = db.record(id);
  const which = recs.sourceOf(rec);
  if (!which) return false;
  const link = which === "audit" ? "audit" : "best";
  const data = { ...rec.links[link] };
  /** @type {Record<string, any>} */
  const patch = { status };
  if (status === "dropped") {
    const likely = which === "audit" ? require("./setup-audit-tree.js").reasonOf(rec) : data.decision_ids?.length ? "decided" : "not-applicable";
    const picks = recs.reasonsFor(which, likely);
    const pick = await vscode.window.showQuickPick(picks, { title: `Dismiss: ${rec.title}`, placeHolder: "Why? (it will not be suggested again)" });
    if (!pick) return false;
    let tag = pick.label;
    if (pick.key === "decided") {
      const task = db.taskById(rec.task_id);
      const touched = new Set(data.decision_ids ?? []);
      const decisions = db.recordsByKind(task.repo_id, ["adr", "pdr", "decision"], { limit: 500 }).filter((/** @type {any} */ r) => r.status !== "dropped");
      const d = await vscode.window.showQuickPick(
        decisions.map((/** @type {any} */ r) => ({ label: `#${r.id} ${String(r.kind).toUpperCase()}`, description: r.title, id: r.id, near: touched.has(r.id) }))
          .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.near) - Number(a.near)),
        { title: "Which decision settles this?", matchOnDescription: true },
      );
      if (!d) return false;
      data.decision = d.id;
      tag = `${pick.label} #${d.id}`;
    }
    const note = await vscode.window.showInputBox({ title: `Dismiss: ${pick.label}`, prompt: "Note (optional), kept in the record" });
    if (note === undefined) return false;
    data.reason = pick.key;
    patch.body = `${rec.body ?? ""}\n\n_Dismissed (${tag})${note.trim() ? `:_ ${note.trim()}` : "._"}`;
  } else {
    delete data.reason;
    delete data.decision;
  }
  patch.links = { ...rec.links, [link]: data };
  db.updateRecord(id, patch, USER);
  return true;
}

module.exports = { setRecommendation };
