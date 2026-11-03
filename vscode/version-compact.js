// @ts-check
// Lossless compaction of the version tables (#121). Only what another stored value already
// says is dropped, and hydrate*() puts it back when a history is read:
//   a. an update's `before` field equal to the value an earlier stored `after` set;
//   b. a record's only version, its create, when the record still holds every created value:
//      its `after` becomes {"@row": [keys]}, read back from the record;
//   c. a section's latest version whose `after.body` is the section's body now: the body
//      becomes "@body": 1, read back from the next version's `before.body` or the section.
// Nothing is reconstructed from a value that was itself compacted, so running it again, or
// after new versions came, stays lossless.
"use strict";

const ROW = "@row";
const BODY = "@body";

/** @param {any} a @param {any} b */
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** @param {any} v */
const isRowMarker = (v) => v && typeof v === "object" && Array.isArray(v[ROW]);

/**
 * The changes that compact one record's versions.
 * @param {Array<{id: number, op: string, before: any, after: any}>} versions oldest first, JSON parsed
 * @param {Record<string, any>} row the record now (recordOf: pointer boolean, links parsed)
 * @returns {Array<{id: number, before?: any, after?: any}>}
 */
function compactRecord(versions, row) {
  /** @type {Array<{id: number, before?: any, after?: any}>} */
  const out = [];
  if (versions.length === 1 && versions[0].op === "create" && versions[0].after && !isRowMarker(versions[0].after)) {
    const a = versions[0].after;
    const keys = Object.keys(a);
    if (keys.length && keys.every((k) => k in row && same(a[k], row[k]))) out.push({ id: versions[0].id, after: { [ROW]: keys } });
    return out;
  }
  /** What the stored afters set so far (a compacted create sets nothing). @type {Record<string, any>} */
  const state = {};
  for (const v of versions) {
    if (v.op === "update" && v.before && typeof v.before === "object") {
      const kept = {};
      let dropped = false;
      for (const [k, val] of Object.entries(v.before)) {
        if (k in state && same(state[k], val)) dropped = true;
        else /** @type {any} */ (kept)[k] = val;
      }
      if (dropped) out.push({ id: v.id, before: kept });
    }
    if (v.after && typeof v.after === "object" && !isRowMarker(v.after)) Object.assign(state, v.after);
  }
  return out;
}

/**
 * One record's versions as they were written: compacted fields filled back in.
 * @template {{id: number, op: string, before: any, after: any}} V
 * @param {V[]} versions oldest first @param {Record<string, any> | undefined} row
 * @returns {V[]}
 */
function hydrateRecord(versions, row) {
  const vs = versions.map((v) => ({ ...v, before: v.before && { ...v.before }, after: v.after && { ...v.after } }));
  const first = vs[0];
  if (first && isRowMarker(first.after) && row) {
    // The values at creation: the record now, with every later change taken back.
    const at = { ...row };
    for (let i = vs.length - 1; i > 0; i--) if (vs[i].before) Object.assign(at, vs[i].before);
    first.after = Object.fromEntries(/** @type {string[]} */ (first.after[ROW]).map((k) => [k, at[k] ?? null]));
  }
  /** @type {Record<string, any>} */
  const state = {};
  for (const v of vs) {
    if (v.op === "update" && v.after && typeof v.after === "object") {
      // In after's key order, as the writer made it (before and after name the same fields).
      const kept = v.before ?? {};
      /** @type {Record<string, any>} */
      const full = {};
      for (const k of Object.keys(v.after)) if (k in kept) full[k] = kept[k];
      else if (k in state) full[k] = state[k];
      for (const k of Object.keys(kept)) if (!(k in full)) full[k] = kept[k];
      v.before = v.before === null && !Object.keys(full).length ? null : full;
    }
    if (v.after && typeof v.after === "object") Object.assign(state, v.after);
  }
  return /** @type {V[]} */ (vs);
}

/**
 * The change that compacts a section's versions: its latest version's body, when it is the body now.
 * @param {Array<{id: number, before: any, after: any}>} versions oldest first @param {{body: string | null}} section
 * @returns {Array<{id: number, after: any}>}
 */
function compactSection(versions, section) {
  const last = versions[versions.length - 1];
  if (!last?.after || typeof last.after !== "object" || last.after[BODY] || typeof last.after.body !== "string" || last.after.body !== section.body) return [];
  // The marker takes the body's place, so the fields read back in their order.
  return [{ id: last.id, after: Object.fromEntries(Object.entries(last.after).map(([k, v]) => (k === "body" ? [BODY, 1] : [k, v]))) }];
}

/**
 * A section's versions with compacted bodies filled back in.
 * @template {{id: number, before: any, after: any}} V
 * @param {V[]} versions oldest first @param {{body: string | null} | undefined} section
 * @returns {V[]}
 */
function hydrateSection(versions, section) {
  const vs = versions.map((v) => ({ ...v, after: v.after && { ...v.after } }));
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i].after;
    if (!a?.[BODY]) continue;
    const next = vs.slice(i + 1).find((w) => w.before && typeof w.before === "object" && "body" in w.before);
    const body = next ? next.before.body : section?.body ?? null;
    vs[i].after = Object.fromEntries(Object.entries(a).map(([k, v]) => (k === BODY ? ["body", body] : [k, v])));
  }
  return /** @type {V[]} */ (vs);
}

module.exports = { compactRecord, hydrateRecord, compactSection, hydrateSection, ROW, BODY };
