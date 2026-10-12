// @ts-check
// The BEST task's recommendations (best-practice.js, #86) grouped for the task page:
//   status (open, applied, dismissed) → [dismissed: why] → pillar → component → recommendation,
// high severity first. Plain data: tasksView.js draws it.
"use strict";

const STATUSES = [["open", "Açık"], ["done", "Uygulandı"], ["dropped", "Reddedildi"]];
const PILLARS_TR = { deps: "Bağımlılıklar ve sürümler", security: "Güvenlik", testing: "Test ve CI" };
const REASONS_TR = {
  decided: "Bilerek yapmadık (karar)",
  "not-applicable": "Uygulanmaz",
  "accepted-risk": "Kabul edilmiş risk",
  postponed: "Ertelendi",
  other: "Diğer",
};
const SEVERITY = ["high", "medium", "low"];

/**
 * @typedef {{id: number, status: string, title: string, body?: string | null, links?: any}} BestRecord
 * @typedef {{key: string, label: string, count: number, children?: BestGroup[], records?: BestRecord[]}} BestGroup
 */

/** @param {BestRecord[]} recs @param {(r: BestRecord) => string} keyOf @param {(k: string, rs: BestRecord[]) => Omit<BestGroup, "count">} make @param {string[]} [order] @returns {BestGroup[]} */
function groupBy(recs, keyOf, make, order) {
  /** @type {Map<string, BestRecord[]>} */
  const by = new Map();
  for (const r of recs) by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r]);
  return [...by.entries()]
    .sort(([a, x], [b, y]) => (order ? order.indexOf(a) - order.indexOf(b) : 0) || y.length - x.length || a.localeCompare(b))
    .map(([k, rs]) => ({ ...make(k, rs), count: rs.length }));
}

/** @param {BestRecord} a @param {BestRecord} b */
const bySeverity = (a, b) => SEVERITY.indexOf(a.links.best.severity) - SEVERITY.indexOf(b.links.best.severity) || a.title.localeCompare(b.title);

/** Pillar → component → recommendations. @param {BestRecord[]} recs @returns {BestGroup[]} */
function byPillar(recs) {
  return groupBy(recs, (r) => r.links.best.pillar ?? "other", (p, rs) => ({
    key: `pillar:${p}`, label: PILLARS_TR[/** @type {keyof typeof PILLARS_TR} */ (p)] ?? p,
    children: groupBy(rs, (r) => r.links.best.component ?? "?", (c, xs) => ({ key: `comp:${c}`, label: c, records: xs.sort(bySeverity) })),
  }), Object.keys(PILLARS_TR));
}

/** The groups of a BEST task's records. @param {BestRecord[]} records @returns {BestGroup[]} */
function bestGroups(records) {
  const recs = records.filter((r) => r.links?.best);
  return STATUSES.flatMap(([st, label]) => {
    const rs = recs.filter((r) => r.status === st);
    if (!rs.length) return [];
    const children = st === "dropped"
      ? groupBy(rs, (r) => r.links.best.reason ?? "other", (why, xs) => ({ key: `why:${why}`, label: REASONS_TR[/** @type {keyof typeof REASONS_TR} */ (why)] ?? why, children: byPillar(xs) }), Object.keys(REASONS_TR))
      : byPillar(rs);
    return [{ key: `st:${st}`, label, count: rs.length, children }];
  });
}

module.exports = { bestGroups, PILLARS_TR, REASONS_TR };
