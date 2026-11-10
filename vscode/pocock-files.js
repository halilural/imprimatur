// @ts-check
// The rest of Matt Pocock's file layout (#193), written from the database with edits read back
// (scratch-files.js writeOne):
//   .out-of-scope/<concept>.md   one per section of the out-of-scope document (triage's OUT-OF-SCOPE format)
//   docs/capabilities/<name>.md  a capability: how the system behaves now (OpenSpec); a done task's
//                                spec deltas merge into it once
//   docs/agents/issue-tracker.md, domain.md  Pocock's setup files, pointing his skills at Imprimatur
//   docs/PROJECT.md              the project page: mission, constraints, tech stack, roadmap
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { writeOne, takeSections } = require("./scratch-files.js");

const actor = { kind: /** @type {const} */ ("import"), name: "pocock-files" };
/** A name as a file name: kebab-case ASCII. @param {string} s */
const fileSlug = (s) => require("./decisions.js").slug(s);

/** An out-of-scope concept's file: "# <concept>" and its reasoning. @param {any} s @param {string} header */
const conceptText = (s, header) => [header, `# ${String(s.title).replace(/\s+/g, " ").trim()}`, String(s.body ?? "").replace(/\r\n/g, "\n").trim() || "Not written yet."].join("\n\n") + "\n";

/** A concept file's title and text. @param {string} text */
function parseConcept(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const h = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h < 0) return undefined;
  const body = lines.slice(h + 1).join("\n").trim();
  return { title: lines[h].replace(/^#\s+/, "").trim(), body: body === "Not written yet." ? "" : body };
}

/**
 * A done task's spec deltas into their capabilities, once (#193, OpenSpec's archive). A delta
 * section's key is "<capability>--<requirement>": added and modified write the requirement,
 * renamed its title, removed supersedes it.
 * @param {any} db @param {number} repoId
 */
function mergeDeltas(db, repoId) {
  const specs = db.q(`SELECT d.* FROM documents d JOIN tasks t ON t.repo_id = d.repo_id AND t.key = d.scope
                      WHERE d.repo_id = ? AND d.kind = 'spec' AND t.status = 'done'`).all(repoId);
  for (const spec of specs) {
    const mark = `capmerge:${spec.id}`;
    if (db.meta(mark)) continue;
    for (const s of db.docSections(spec.id).filter((/** @type {any} */ x) => x.delta && x.status === "current")) {
      const [cap, req] = String(s.key).split("--");
      if (!cap || !req) continue;
      const doc = db.taskDocOf(repoId, cap, "capability");
      if (s.delta === "removed") {
        if (db.docSection(doc.id, req)) db.upsertSection(doc.id, req, { status: "superseded" }, actor);
      } else if (s.delta === "renamed") {
        if (db.docSection(doc.id, req)) db.upsertSection(doc.id, req, { title: s.title }, actor);
      } else db.upsertSection(doc.id, req, { title: s.title, body: s.body ?? null, status: "current" }, actor);
    }
    db.setMeta(mark, String(Date.now()));
  }
}

/**
 * The kept documents as domain.md lists them (#206): each with when to read it, none loaded up front.
 * @param {Array<{path: string, when?: string}>} kept
 */
const keptLines = (kept) => kept.length
  ? ["## Kept documents: read only when you need them",
    "Hand-written documents this repo keeps as they are. Do not read them up front; `search` finds inside them (its `files`), then read the file at that line.",
    kept.map((k) => `- \`${k.path}\`${k.when ? `: ${k.when}` : ""}`).join("\n")]
  : [];

/** Pocock's docs/agents files, pointing his skills at Imprimatur. @param {string} header @param {Array<{path: string, when?: string}>} [kept] */
const agentFiles = (header, kept = []) => ({
  "issue-tracker.md": [header, "# Issue tracker: Imprimatur",
    "Issues and specs for this repo live in Imprimatur's database, written out as Pocock's local Markdown tracker under `.scratch/`. Read and write them with the Imprimatur MCP tools; the files follow.",
    "## Conventions",
    [
      "- One feature per directory: `.scratch/<task>/`; the spec is `.scratch/<task>/spec.md` (`doc_section_upsert` with kind `spec`, the task's key).",
      "- A ticket is a child task of the feature's task (`task_upsert` with `epic`), written to `.scratch/<task>/issues/NN-slug.md` with `Status:`, `Type:` and `Blocked by:` lines.",
      "- Status: open, claimed (the task active), resolved (the task done).",
      "- A wayfinder map is `.scratch/<task>/map.md` (kind `map`); its tickets are the task's children with a type (research, prototype, grilling, task).",
      "- Comments and answers are records on the task (`record_add`).",
    ].join("\n"),
    "## When a skill says \"publish to the issue tracker\"", "Create the task and its spec in Imprimatur; the files are written for you.",
    "## When a skill says \"fetch the relevant ticket\"", "Read it with `task_get`, or read its file under `.scratch/`."].join("\n\n") + "\n",
  "domain.md": [header, "# Domain Docs",
    "How the engineering skills read this repo's domain documentation.",
    "## Before exploring, read these",
    "- **`GLOSSARY.md`** at the repo root.\n- **`docs/adr/`**: the ADRs that touch the area you are about to work in.\n- **`docs/PROJECT.md`**: mission, constraints, tech stack, roadmap.\n- **`docs/capabilities/`**: how the system behaves now.",
    "If any of these files don't exist, proceed silently. Terms and ADRs are written with Imprimatur's tools (`doc_section_upsert` kind `glossary`, `record_add` kind `adr`); the files follow.",
    ...keptLines(kept)].join("\n\n") + "\n",
});

/**
 * Writes .out-of-scope/, docs/capabilities/ and docs/agents/ (#193), after merging done specs'
 * deltas. Returns the files written.
 * @param {any} db @param {any} repo @param {string} root
 * @param {{header: string, generatedText: (t: string) => boolean, inside: (f: string) => boolean}} io
 */
function exportPocock(db, repo, root, io) {
  const written = [];
  mergeDeltas(db, repo.id);
  const { docMarkdown } = require("./docs-export.js");
  // Out of scope: one file per concept.
  const oos = db.docFind(repo.id, "out-of-scope");
  for (const s of oos ? db.docSections(oos.id).filter((/** @type {any} */ x) => x.status === "current") : []) {
    const rel = path.join(".out-of-scope", `${s.key}.md`);
    const take = (/** @type {string} */ text) => {
      const got = parseConcept(text);
      if (got && (got.title !== s.title || got.body !== String(s.body ?? "").trim())) db.upsertSection(oos.id, s.key, { title: got.title, body: got.body || null }, actor);
    };
    const keep = (/** @type {string} */ text) => db.upsertSection(oos.id, `${s.key}-file-edit`, { title: `${s.title} (file edit not taken)`, body: text, status: "superseded" }, actor);
    if (writeOne(db, repo, root, rel, () => conceptText(db.docSection(oos.id, s.key), io.header), take, () => db.docSection(oos.id, s.key).updated_at, keep, io)) written.push(rel);
  }
  // The project page and the capabilities (how the system behaves now), each one document per file.
  const project = db.docFind(repo.id, "project");
  const docs = [...(project ? [{ doc: project, rel: path.join("docs", "PROJECT.md") }] : []),
    ...db.q("SELECT * FROM documents WHERE repo_id = ? AND kind = 'capability' ORDER BY scope").all(repo.id)
      .map((/** @type {any} */ doc) => ({ doc, rel: path.join("docs", "capabilities", `${fileSlug(doc.scope)}.md`) }))];
  for (const { doc, rel } of docs) {
    const keep = (/** @type {string} */ text) => db.upsertSection(doc.id, "file-edit-not-taken", { title: "File edit not taken (the document changed too)", body: text, status: "superseded" }, actor);
    if (writeOne(db, repo, root, rel, () => docMarkdown(db, doc.id), (t) => takeSections(db, doc.id, t, actor), () => db.docById(doc.id).updated_at, keep, io)) written.push(rel);
  }
  // Pocock's setup files, once the repo uses his layout (a spec, a map, a capability or out-of-scope).
  const uses = db.q("SELECT 1 FROM documents WHERE repo_id = ? AND kind IN ('spec', 'map', 'capability', 'out-of-scope', 'project') LIMIT 1").get(repo.id);
  if (uses)
    for (const [name, text] of Object.entries(agentFiles(io.header, require("./doc-rules.js").keepOf(root)))) {
      const f = path.join(root, "docs", "agents", name);
      if (!io.inside(f)) continue;
      let old;
      try {
        old = fs.readFileSync(f, "utf8");
      } catch {}
      if (old === text || (old !== undefined && !io.generatedText(old))) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (!io.inside(f)) continue;
      fs.writeFileSync(f, text);
      written.push(path.relative(root, f));
    }
  return written;
}

module.exports = { exportPocock, mergeDeltas, conceptText, parseConcept, agentFiles };
