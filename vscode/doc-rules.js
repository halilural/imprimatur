// @ts-check
// The documentation standard's rules in setup_audit (#131): checked on the repo's design
// documents (the database) and its agent files, reported in agnix's diagnostic shape, so they
// become Recommendations like agnix's findings. A rule about decisions reports one finding with
// the decisions it names (one per decision would bury the panel under a hundred records).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** The rules: id → what it checks. The ids are Imprimatur's (IMP-DOC-…). */
const RULES = {
  "IMP-DOC-001": "Decisions are numbered once, each number used by one decision; a superseded one names its successor",
  "IMP-DOC-002": "A decision lists at least two considered options: the one chosen and an alternative",
  "IMP-DOC-003": "A decision is linked to the section it shapes",
  "IMP-DOC-004": "The architecture has a section in every chapter, a C4 context view and a C4 container view",
  "IMP-DOC-005": "A sequenceDiagram has autonumber and, under it, a numbered list with an item per arrow",
  "IMP-DOC-006": "AGENTS.md and CLAUDE.md stay under 200 lines",
};
const SOURCES = ["https://adr.github.io/madr/", "https://arc42.org/overview", "https://c4model.com/", "https://agents.md/"];
/** The rules' explanation, in agnix explain's shape (agnix does not know them). @param {string} id */
const ruleInfo = (id) => ({ name: /** @type {any} */ (RULES)[id], evidence: { source_type: "imprimatur", source_urls: SOURCES } });

const LIMIT_LINES = 200;
/** How many decisions a finding names before "and N more". */
const NAMED = 12;

/** Lines of a body that name an option, as in decisions.js. @param {string} body */
const optionLines = (body) => String(body).split(/\r?\n/).filter((l) => /\b(?:alternatives?|rejected|instead of|not chosen|option [a-z0-9]|considered)\b/i.test(l));

/** "0001, 0005 … and 12 more". @param {any[]} recs */
const named = (recs) => {
  const ids = recs.map((r) => String(r.links?.madr ?? "?").padStart(4, "0"));
  return ids.length > NAMED ? `${ids.slice(0, NAMED).join(", ")} and ${ids.length - NAMED} more` : ids.join(", ");
};

/**
 * The current decisions IMP-DOC-002 and 003 name: few, with no alternative; loose, linked to no section.
 * @param {any} db @param {number} repoId @returns {{few: any[], loose: any[]}}
 */
function decisionGaps(db, repoId) {
  const current = db.decisionRecords(repoId).filter((/** @type {any} */ r) => r.status !== "dropped");
  const linked = db.sectionsOfRecords(repoId);
  return {
    // The chosen option is the decision itself: one line naming an alternative makes two.
    few: current.filter((/** @type {any} */ r) => optionLines(`${r.title}\n${r.body ?? ""}`).length < 1),
    loose: current.filter((/** @type {any} */ r) => !linked.has(r.id)),
  };
}

/**
 * Each sequenceDiagram in a Markdown text that lacks autonumber, or the numbered list under it
 * with an item per arrow: its line and why.
 * @param {string} text @returns {Array<{line: number, why: string}>}
 */
function sequenceProblems(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```mermaid\s*$/.test(lines[i])) continue;
    let j = i + 1;
    const body = [];
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++]);
    if (!body.some((l) => /^\s*sequenceDiagram\b/.test(l))) {
      i = j;
      continue;
    }
    const arrows = body.filter((l) => /^\s*[^%\s][^:]*?(?:-->>|->>|-->|->|--x|-x|--\)|-\))[^:]*:/.test(l)).length;
    const auto = body.some((l) => /^\s*autonumber\b/.test(l));
    // The numbered list: the first list after the fence, blank lines and one lead-in line allowed.
    let k = j + 1;
    while (k < lines.length && !lines[k].trim()) k++;
    if (k < lines.length && !/^\s*\d+\.\s/.test(lines[k]) && /\S/.test(lines[k]) && !/^#/.test(lines[k])) k++;
    while (k < lines.length && !lines[k].trim()) k++;
    let items = 0;
    while (k < lines.length && (/^\s*\d+\.\s/.test(lines[k]) || (/^\s{2,}\S/.test(lines[k]) && items))) {
      if (/^\s*\d+\.\s/.test(lines[k])) items++;
      k++;
    }
    const why = [!auto && "no autonumber", items < arrows && `${items} numbered item${items === 1 ? "" : "s"} for ${arrows} arrow${arrows === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    if (why) out.push({ line: i + 1, why });
    i = j;
  }
  return out;
}

/**
 * The documentation findings for a repo (#131), as agnix diagnostics.
 * @param {any} db @param {string} root @param {{docsDir?: string}} [o]
 */
function docDiagnostics(db, root, { docsDir } = {}) {
  const repo = db.repoByRoot(root);
  /** @type {any[]} */
  const out = [];
  const dir = docsDir ?? require("./docs-export.js").dirOf(root);
  const fileOf = (/** @type {string} */ name) => path.join(dir, name);
  /** @param {string} rule @param {string} file @param {string} message @param {string} suggestion @param {number} [line] @param {string} [level] */
  const add = (rule, file, message, suggestion, line = 1, level = "warning") =>
    out.push({ level, rule, file, line, category: "docs", applies_to_tool: "any", message, suggestion });

  if (repo) {
    // Decisions (#130): numbering, options, section links.
    const recs = db.decisionRecords(repo.id);
    const current = recs.filter((/** @type {any} */ r) => r.status !== "dropped");
    const byNumber = new Map();
    for (const r of recs) if (r.links?.madr) byNumber.set(r.links.madr, [...(byNumber.get(r.links.madr) ?? []), r]);
    const twice = [...byNumber.values()].filter((list) => list.length > 1).flat();
    const unnumbered = current.filter((/** @type {any} */ r) => !r.links?.madr);
    if (twice.length || unnumbered.length)
      add("IMP-DOC-001", fileOf("decisions/README.md"), [twice.length && `number used twice: ${named(twice)}`, unnumbered.length && `${unnumbered.length} decision${unnumbered.length === 1 ? "" : "s"} without a number`].filter(Boolean).join("; "),
        "A doubled number comes from two devices numbering before they synced: give one of them a new number (record links.madr). An unnumbered decision gets one at the next document export.");
    // A MADR file that says "superseded by NNNN" names a decision that exists.
    try {
      const names = fs.readdirSync(fileOf("decisions"));
      for (const n of names) {
        const m = /^status:\s*superseded by\s+(\d{1,4})/im.exec(fs.readFileSync(fileOf(`decisions/${n}`), "utf8"));
        if (m && !names.some((x) => x.startsWith(`${m[1].padStart(4, "0")}-`)))
          add("IMP-DOC-001", fileOf(`decisions/${n}`), `superseded by ${m[1]}, which has no file`, "Point it at the decision that replaced it.", 1);
      }
    } catch {}
    const { few, loose } = decisionGaps(db, repo.id);
    if (few.length)
      add("IMP-DOC-002", fileOf("decisions/README.md"), `${few.length} of ${current.length} decisions name no alternative to the option chosen: ${named(few)}`,
        'Add the options weighed to each record\'s body, one line each ("Alternative: …", "Rejected: …"), with record_update; the MADR file lists them under Considered Options.', 1, "info");
    if (loose.length)
      add("IMP-DOC-003", fileOf("decisions/README.md"), `${loose.length} of ${current.length} decisions are linked to no section: ${named(loose)}`,
        "Link each to the architecture or product section it shapes: doc_section_upsert with records: [id], updating the section's text.", 1, "info");

    // The architecture's chapters and its C4 views (#129).
    const arch = db.docFind(repo.id, "architecture");
    if (arch) {
      const secs = db.docSections(arch.id).filter((/** @type {any} */ s) => s.status === "current");
      const chapters = Object.entries(require("./db.js").CHAPTERS.architecture);
      const empty = chapters.filter(([k]) => !secs.some((/** @type {any} */ s) => s.chapter === k)).map(([, label]) => label);
      if (empty.length) add("IMP-DOC-004", fileOf("ARCHITECTURE.md"), `chapters with no section: ${empty.join(", ")}`, "Write a section for each with doc_section_upsert and its chapter (arc42-lite).");
      const text = secs.map((/** @type {any} */ s) => s.body ?? "").join("\n");
      if (!/C4Context|\[Person\]|\[Software system\]/i.test(text)) add("IMP-DOC-004", fileOf("ARCHITECTURE.md"), "no C4 context view (level 1)", "Add a Mermaid diagram of the system, its users and the systems around it, labelled [Person] and [Software system], in the context chapter.");
      if (!/C4Container|\[Container[:\]]/i.test(text)) add("IMP-DOC-004", fileOf("ARCHITECTURE.md"), "no C4 container view (level 2)", "Add a Mermaid diagram of the containers, labelled [Container: technology], in the building-blocks chapter.");
    }
    // Every sequenceDiagram in the documents and task analyses.
    for (const kind of ["architecture", "product", "analysis"]) {
      const docs = kind === "analysis" ? (db.taskDocs?.(repo.id) ?? []) : [db.docFind(repo.id, kind)].filter(Boolean);
      for (const d of docs)
        for (const s of db.docSections(d.id).filter((/** @type {any} */ x) => x.status === "current"))
          for (const p of sequenceProblems(s.body ?? ""))
            add("IMP-DOC-005", kind === "analysis" ? fileOf("ARCHITECTURE.md") : fileOf(kind === "architecture" ? "ARCHITECTURE.md" : "PRODUCT.md"),
              `sequenceDiagram in ${kind === "analysis" ? `the ${d.scope} analysis, ` : ""}section "${s.title}": ${p.why}`,
              "Put autonumber on the diagram's second line and, right under it, a numbered list with one item per arrow, in order; write the section with doc_section_upsert.");
    }
  }
  // The agent files (#133).
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (n > LIMIT_LINES)
      add("IMP-DOC-006", path.join(root, name), `${name} has ${n} lines, over ${LIMIT_LINES}`,
        name === "CLAUDE.md" ? "Move the rules every agent follows into AGENTS.md and import it with @AGENTS.md (Agent Setup → Checklist → Fix it); keep only what is Claude Code's own." : "Shorten it: drop repeats, move long references into docs/ and link them.");
  }
  return out;
}

module.exports = { docDiagnostics, decisionGaps, sequenceProblems, RULES, ruleInfo, LIMIT_LINES };
