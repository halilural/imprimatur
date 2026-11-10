// @ts-check
// The new Imprimatur panel's data (#195, screen map: decision 10582 on #190). Pure: the database and a
// place in, a plain object out, so the panel and the tests share it. Five areas (Home, Tasks, Docs,
// Edits, Setup) and More; a document opens in the one reading layout (its sections, the page,
// "on this page").
"use strict";
const path = require("node:path");

/** The areas of the left nav, in order; g + key jumps there. */
const AREAS = [
  { id: "home", label: "Home", key: "h", icon: "home" },
  { id: "tasks", label: "Tasks", key: "t", icon: "checklist" },
  { id: "docs", label: "Docs", key: "d", icon: "book" },
  { id: "edits", label: "Edits", key: "e", icon: "git-merge" },
  { id: "setup", label: "Setup", key: "s", icon: "settings-gear" },
];
/** Under More: the pages that are not daily work. */
const MORE = [
  { id: "exercises", label: "Exercises", command: "imprimatur.openExercises" },
  { id: "meetings", label: "Meetings", command: "imprimatur.openMeetings" },
  { id: "social", label: "Social", command: "imprimatur.openSocial" },
];
/** The documents of the Docs area, in reading order (Pocock's, then the wiki). */
const DOCS = [
  { id: "project", label: "Project", kind: "project" },
  { id: "capabilities", label: "Capabilities", kind: "capability" },
  { id: "adrs", label: "ADRs", kind: "adr" },
  { id: "glossary", label: "Glossary", kind: "glossary" },
  { id: "out-of-scope", label: "Out of scope", kind: "out-of-scope" },
  { id: "wiki", label: "Wiki", kind: "wiki" },
];

/** A section's first paragraph as one line: the summary shown first. @param {unknown} body */
function summaryOf(body) {
  const para = String(body ?? "").replace(/\r\n/g, "\n").split(/\n\s*\n/).find((p) => p.trim() && !/^(#|```|<!--|\||- \[)/.test(p.trim())) ?? "";
  const s = para.replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
}

/**
 * A document as the reading layout wants it: title, a summary, and its current sections.
 * @param {string} title @param {Array<{key: string, title: string, body?: string | null}>} sections @param {string} [summary]
 */
function reading(title, sections, summary) {
  const list = sections.map((s) => ({ key: s.key, title: s.title, body: s.body ?? "" }));
  return { title, summary: summary ?? summaryOf(list[0]?.body), sections: list };
}

/**
 * The reading model of a Docs page (#195 reads; #198 edits).
 * @param {any} db @param {any} repo @param {string} root @param {string} doc one of DOCS' ids @param {string} [scope] a capability's name
 */
function docReading(db, repo, root, doc, scope) {
  const current = (/** @type {any} */ d) => (d ? db.docSections(d.id).filter((/** @type {any} */ s) => s.status === "current") : []);
  if (doc === "adrs") {
    const adrs = db.q(`SELECT r.* FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? AND r.kind = 'adr' AND r.status <> 'dropped' ORDER BY r.created_at`).all(repo.id);
    return reading("ADRs", adrs.map((/** @type {any} */ r) => {
      let n;
      try {
        n = JSON.parse(r.links ?? "{}").madr;
      } catch {}
      return { key: `adr-${n ?? r.id}`, title: `${n ? `${String(n).padStart(4, "0")} · ` : ""}${String(r.title).replace(/\s+/g, " ").slice(0, 140)}`, body: [String(r.title), r.body ?? ""].join("\n\n") };
    }), "Decisions that are hard to reverse, surprising without their context, and the result of a real trade-off.");
  }
  if (doc === "capabilities") {
    const caps = db.q("SELECT * FROM documents WHERE repo_id = ? AND kind = 'capability' ORDER BY scope").all(repo.id);
    const pick = caps.find((/** @type {any} */ c) => c.scope === scope) ?? caps[0];
    if (!pick) return { ...reading("Capabilities", [], "How the system behaves now. A capability appears when a task with a spec is done and its changes merge."), scopes: [] };
    return { ...reading(`Capability · ${pick.scope}`, current(pick)), scopes: caps.map((/** @type {any} */ c) => c.scope), scope: pick.scope };
  }
  if (doc === "wiki") {
    const fs = require("node:fs");
    const dir = path.join(root, "docs", "wiki");
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((/** @type {string} */ f) => f.endsWith(".md")).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));
    } catch {}
    const pages = names.map((/** @type {string} */ f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").replace(/^#\s+[^\n]*\n+/, "");
      return { key: f.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-"), title: f === "README.md" ? "Overview" : `${f.replace(/\.md$/, "")}/`, body: text };
    });
    return reading("Wiki", pages, pages.length ? undefined : "No wiki yet: npm run wiki writes it from the code's comments, the ADRs and the glossary.");
  }
  const kind = DOCS.find((d) => d.id === doc)?.kind ?? "project";
  const label = DOCS.find((d) => d.id === doc)?.label ?? "Project";
  return reading(label, current(db.docFind(repo.id, kind)), {
    project: "Mission, constraints, tech stack and roadmap.",
    glossary: "The words this project uses, one entry each.",
    "out-of-scope": "What the project decided not to do, and why.",
  }[kind]);
}

/**
 * The panel's model for a place.
 * @param {any} db @param {any} repo @param {string} root
 * @param {{area?: string, doc?: string, scope?: string}} at
 */
function appModel(db, repo, root, at = {}) {
  const area = AREAS.some((a) => a.id === at.area) ? /** @type {string} */ (at.area) : "home";
  const waiting = db.openAsks ? db.openAsks({ repoId: repo.id, limit: 200 }).length : 0;
  const base = { repo: { name: repo.name ?? path.basename(root), root }, areas: AREAS, more: MORE, area, waiting };
  if (area === "docs") {
    const doc = DOCS.some((d) => d.id === at.doc) ? /** @type {string} */ (at.doc) : "project";
    return { ...base, docs: DOCS, doc, reading: docReading(db, repo, root, doc, at.scope) };
  }
  if (area === "home") {
    const tasks = db.whereWeLeftOff(repo.id).slice(0, 12);
    return { ...base, tasks };
  }
  return base;
}

module.exports = { appModel, docReading, reading, summaryOf, AREAS, MORE, DOCS };
