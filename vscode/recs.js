// @ts-check
// Recommendations (#87): one record container per repo, RECS, for both producers —
// the agent setup audit (setup-audit.js, records with links.audit) and the project
// best-practice review (best-practice.js, records with links.best). The older
// containers (AUDIT #77, BEST #86) move into it the first time it is asked for.
"use strict";

const TASK = "RECS";
const TASK_TITLE = "Recommendations";
const OLD = ["AUDIT", "BEST"];
/** @type {import("./db.js").Actor} */
const ACTOR = { kind: "hook", id: "recs" };

/**
 * Why a recommendation was dismissed, for both producers: [English, Turkish, which].
 * which: the producers it makes sense for (the dismiss picker shows only those).
 */
const REASONS = {
  false: ["False alarm", "Yanlış alarm", ["audit", "best"]],
  decided: ["Decided against (a decision)", "Bilerek yapmadık (karar)", ["audit", "best"]],
  "not-applicable": ["Not applicable", "Uygulanmaz", ["best"]],
  "accepted-risk": ["Accepted risk", "Kabul edilmiş risk", ["audit", "best"]],
  postponed: ["Postponed", "Ertelendi", ["best"]],
  plugin: ["Third-party plugin", "Üçüncü taraf plugin", ["audit"]],
  synced: ["Synced skill (claude.ai)", "Eşitlenen skill (claude.ai)", ["audit"]],
  local: ["Specific to this machine", "Bu makineye özel", ["audit"]],
  other: ["Other", "Diğer", ["audit", "best"]],
};

/** Which producer a record is: "audit", "best", or undefined (another record). @param {any} r */
const sourceOf = (r) => (r?.links?.audit ? "audit" : r?.links?.best ? "best" : undefined);

/** The same finding already in RECS: an audit fingerprint or a review key (a machine on an older release wrote it again). @param {any} r */
const identity = (r) => (r.links?.audit?.fp ? `audit:${r.links.audit.fp}` : r.links?.best?.key ? `best:${r.links.best.category ?? r.links.best.pillar ?? ""}:${r.links.best.key}` : undefined);

/**
 * The repo's RECS task: the old AUDIT / BEST records moved into it first (the old tasks
 * left dropped). Created only when `create`. No transaction when there is nothing to
 * move (a read must not write: the change gate would redraw again). A record whose
 * finding RECS already has (written again under the old task by a machine on an older
 * release) moves as a dropped duplicate, so nothing shows twice.
 * @param {any} db @param {number} repoId @param {{create?: boolean, actor?: import("./db.js").Actor}} [o]
 */
function recsTask(db, repoId, { create = false, actor = ACTOR } = {}) {
  const pending = () => OLD.map((k) => db.taskByKey(repoId, k)).filter((t) => t && db.recordsOf(t.id, { dropped: true }).length);
  const existing = db.taskByKey(repoId, TASK);
  if (!pending().length) {
    if (existing || !create) return existing;
  }
  return db.tx(() => {
    // Read again under the lock: another process may have moved them meanwhile.
    const task = db.taskByKey(repoId, TASK) ?? db.upsertTask(repoId, TASK, { title: TASK_TITLE, status: "active" }, actor);
    const have = new Set(db.recordsOf(task.id, { dropped: true }).map(identity).filter(Boolean));
    for (const o of pending()) {
      for (const r of db.recordsOf(o.id, { dropped: true })) {
        const id = identity(r);
        db.moveRecord(r.id, task.id, actor);
        if (id && have.has(id)) {
          const link = r.links.audit ? "audit" : "best";
          db.updateRecord(r.id, { status: "dropped", links: { ...r.links, [link]: { ...r.links[link], duplicate: true } } }, actor);
        } else if (id) have.add(id);
      }
      if (o.status !== "dropped") db.upsertTask(repoId, o.key, { status: "dropped", summary: `Moved to ${TASK} (#87)` }, actor);
    }
    return db.taskById(task.id);
  });
}

/** Not a duplicate moved in from an old task. @param {any} r */
const live = (r) => !r.links?.audit?.duplicate && !r.links?.best?.duplicate;

/**
 * The task's one line: each producer's counts, e.g.
 * "Agent setup: 26 open · 668 not loaded · 39 applied · 1016 dismissed | Project: 5 open (2 high)".
 * @param {Array<{status: string, links?: any}>} records
 */
function summaryLine(records) {
  const audit = records.filter((r) => r.links?.audit && live(r));
  const best = records.filter((r) => r.links?.best && live(r));
  const count = (/** @type {any[]} */ rs, /** @type {(r: any) => boolean} */ f) => rs.filter(f).length;
  const parts = [];
  if (audit.length) {
    const live = audit.filter((r) => r.status === "open" && r.links.audit.effect !== "inactive");
    const open = live.length;
    const idle = count(audit, (r) => r.status === "open" && r.links.audit.effect === "inactive");
    const lv = ["error", "warning", "info"].map((l) => [l, count(live, (r) => r.links.audit.level === l)]).filter(([, n]) => n).map(([l, n]) => `${n} ${l}${n === 1 || l === "info" ? "" : "s"}`);
    parts.push(`Agent setup: ${[`${open} open${lv.length ? ` (${lv.join(", ")})` : ""}`, idle && `${idle} not loaded`, count(audit, (r) => r.status === "done") && `${count(audit, (r) => r.status === "done")} applied`, count(audit, (r) => r.status === "dropped") && `${count(audit, (r) => r.status === "dropped")} dismissed`].filter(Boolean).join(" · ")}`);
  }
  if (best.length) {
    const open = best.filter((r) => r.status === "open");
    const sev = ["high", "medium", "low"].map((s) => [s, count(open, (r) => r.links.best.severity === s)]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`);
    parts.push(`Project: ${[`${open.length} open${sev.length ? ` (${sev.join(", ")})` : ""}`, count(best, (r) => r.status === "done") && `${count(best, (r) => r.status === "done")} applied`, count(best, (r) => r.status === "dropped") && `${count(best, (r) => r.status === "dropped")} dismissed`].filter(Boolean).join(" · ")}`);
  }
  return parts.join(" | ") || "nothing yet";
}

/** Writes the task's summary when it says something new. @param {any} db @param {any} task @param {import("./db.js").Actor} [actor] */
function writeSummary(db, task, actor = ACTOR) {
  const line = summaryLine(db.recordsOf(task.id, { dropped: true }));
  if (task.summary !== line) db.upsertTask(task.repo_id, TASK, { summary: line }, actor);
  return line;
}

/** The dismiss reasons for a producer: [{key, label (Turkish)}], the likely one first. @param {"audit" | "best"} which @param {string} [likely] */
function reasonsFor(which, likely) {
  return Object.entries(REASONS).filter(([, v]) => v[2].includes(which)).map(([key, v]) => ({ key, label: v[1] }))
    .sort((a, b) => Number(b.key === likely) - Number(a.key === likely));
}

module.exports = { TASK, TASK_TITLE, OLD, ACTOR, REASONS, sourceOf, recsTask, live, identity, summaryLine, writeSummary, reasonsFor };
