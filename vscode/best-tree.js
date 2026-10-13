// @ts-check
// The project's best-practice recommendations (best-practice.js, #86/#87) grouped:
//   status (open, applied, dismissed) → [dismissed: why] → category (ISO 25010 / SSDF)
//   → subcategory → recommendation, high severity first.
// Plain data, for the Recommendations tree (setup-audit-tree.js) and the RECS page.
"use strict";

const { CATEGORIES } = require("./best-practice.js");
const { REASONS } = require("./recs.js");

const STATUSES = [["open", "Open", "Açık", "lightbulb"], ["done", "Applied", "Uygulandı", "pass"], ["dropped", "Dismissed", "Reddedildi", "circle-slash"]];
const SEVERITY = ["high", "medium", "low"];
const CAT_TR = {
  security: "Güvenlik", reliability: "Güvenilirlik", maintainability: "Bakım kolaylığı", compatibility: "Uyumluluk", "performance-efficiency": "Performans verimliliği",
  ssdf: "Geliştirme süreci (SSDF)", flexibility: "Esneklik", "interaction-capability": "Etkileşim yeteneği", "functional-suitability": "İşlevsel uygunluk", safety: "Emniyet",
};

/**
 * @typedef {{id: number, status: string, title: string, body?: string | null, links?: any}} BestRecord
 * @typedef {{key: string, label: string, icon?: string, count: number, levels?: Record<string, number>, children?: BestGroup[], records?: BestRecord[]}} BestGroup
 */

/** @param {BestRecord[]} rs @returns {Record<string, number>} */
const severities = (rs) => Object.fromEntries(SEVERITY.map((s) => [s, rs.filter((r) => r.links.best.severity === s).length]).filter(([, n]) => n));

/** @param {BestRecord[]} recs @param {(r: BestRecord) => string} keyOf @param {(k: string, rs: BestRecord[]) => Omit<BestGroup, "count">} make @param {string[]} [order] @returns {BestGroup[]} */
function groupBy(recs, keyOf, make, order) {
  /** @type {Map<string, BestRecord[]>} */
  const by = new Map();
  for (const r of recs) by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r]);
  return [...by.entries()]
    .sort(([a, x], [b, y]) => (order ? order.indexOf(a) - order.indexOf(b) : 0) || y.length - x.length || a.localeCompare(b))
    .map(([k, rs]) => ({ ...make(k, rs), count: rs.length, levels: severities(rs) }));
}

/** @param {BestRecord} a @param {BestRecord} b */
const bySeverity = (a, b) => SEVERITY.indexOf(a.links.best.severity) - SEVERITY.indexOf(b.links.best.severity) || a.title.localeCompare(b.title);

/** A record's category (older records: their pillar). @param {BestRecord} r */
const catOf = (r) => r.links.best.category ?? r.links.best.pillar ?? "other";

/** Category → subcategory → recommendations. @param {BestRecord[]} rs @param {boolean} tr */
function byCategory(rs, tr) {
  return groupBy(rs, catOf, (cat, xs) => {
    const c = CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (cat)];
    const name = tr ? CAT_TR[/** @type {keyof typeof CAT_TR} */ (cat)] ?? c?.name ?? cat : c?.name ?? cat;
    return {
      key: `cat:${cat}`, label: c ? `${name} · ${c.std}` : name, icon: "symbol-namespace",
      children: groupBy(xs, (r) => r.links.best.subcategory ?? "other", (sub, ys) => ({ key: `sub:${cat}:${sub}`, label: sub, icon: "symbol-field", records: ys.sort(bySeverity) }), c?.subs.map((s) => s[0])),
    };
  }, Object.keys(CATEGORIES));
}

/** The groups of a repo's project recommendations. @param {BestRecord[]} records @param {{lang?: "en" | "tr"}} [o] @returns {BestGroup[]} */
function bestGroups(records, { lang = "tr" } = {}) {
  const tr = lang === "tr";
  const recs = records.filter((r) => r.links?.best && !r.links.best.duplicate);
  return STATUSES.flatMap(([st, en, trName, icon]) => {
    const rs = recs.filter((r) => r.status === st);
    if (!rs.length) return [];
    const children = st === "dropped"
      ? groupBy(rs, (r) => r.links.best.reason ?? "other", (why, xs) => {
        const lab = REASONS[/** @type {keyof typeof REASONS} */ (why)] ?? REASONS.other;
        return { key: `why:${why}`, label: tr ? lab[1] : lab[0], icon: "circle-slash", children: byCategory(xs, tr) };
      }, Object.keys(REASONS))
      : byCategory(rs, tr);
    return [{ key: `st:${st}`, label: tr ? trName : en, icon, count: rs.length, levels: severities(rs), children }];
  });
}

module.exports = { bestGroups, CAT_TR };
