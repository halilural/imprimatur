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
  "IMP-DOC-005": "A sequenceDiagram has autonumber and, under it, a numbered list with an item per arrow",
  "IMP-DOC-006": "AGENTS.md and CLAUDE.md stay under 200 lines",
  "IMP-DOC-007": "A document lives in Imprimatur's model (project page, capability, ADR, glossary, a task's spec) or is kept on purpose",
};
const SOURCES = ["https://adr.github.io/madr/", "https://agents.md/"];
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
 * The current decisions IMP-DOC-002 names (few, with no alternative), and those linked to no section (loose).
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
    const { few } = decisionGaps(db, repo.id);
    if (few.length)
      add("IMP-DOC-002", fileOf("decisions/README.md"), `${few.length} of ${current.length} decisions name no alternative to the option chosen: ${named(few)}`,
        'Add the options weighed to each record\'s body, one line each ("Alternative: …", "Rejected: …"), with record_update; the MADR file lists them under Considered Options.', 1, "info");
    // Every sequenceDiagram in Pocock's documents (#203; ADRs and the old Architecture/Product are left out).
    for (const d of db.q("SELECT * FROM documents WHERE repo_id = ? AND kind IN ('project', 'capability', 'spec', 'map')").all(repo.id))
      for (const s of db.docSections(d.id).filter((/** @type {any} */ x) => x.status === "current"))
        for (const p of sequenceProblems(s.body ?? ""))
          add("IMP-DOC-005", d.kind === "project" ? fileOf("PROJECT.md") : d.kind === "capability" ? fileOf(`capabilities/${d.scope}.md`) : path.join(root, ".scratch"),
            `sequenceDiagram in ${d.kind === "project" ? "the project page" : `the ${d.kind} ${d.scope}`}, section "${s.title}": ${p.why}`,
            "Put autonumber on the diagram's second line and, right under it, a numbered list with one item per arrow, in order; write the section with doc_section_upsert.");
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
  // Hand-written documents (#205): the root's Markdown and everything under docs/.
  for (const f of handWrittenDocs(root, dir))
    add("IMP-DOC-007", f.file, `${f.rel}: hand-written, outside Imprimatur's model (${f.lines} lines)`,
      "Run /adopt-docs: it sorts each such file into a capability, an ADR, the glossary or a task's spec, or deletes it. A file or folder you keep as it is: {\"docs\": {\"keep\": [\"docs/mails/\"]}} in .claude/imprimatur.json, or dismiss this finding.", 1, "info");
  return out;
}

/**
 * The repo's kept documents (#205, #206): {"docs": {"keep": ["docs/mails/", {"path": "docs/runbooks/", "when": "an incident"}]}},
 * folders and files kept as they are on purpose; "when" tells an agent when to read them.
 * @param {string} root @returns {Array<{path: string, when?: string}>}
 */
function keepOf(root) {
  const raw = require("./docs-export.js").docsSettings(root).keep;
  return (Array.isArray(raw) ? raw : []).flatMap((/** @type {any} */ k) => {
    const p = typeof k === "string" ? k : typeof k?.path === "string" ? k.path : "";
    const clean = p.trim().replace(/^\.\//, "");
    if (!clean || clean.split("/").includes("..") || path.isAbsolute(clean)) return [];
    return [{ path: clean, ...(typeof k?.when === "string" && k.when.trim() ? { when: k.when.trim() } : {}) }];
  });
}

/** Files every repo has, not documents of its design. */
const STANDARD = new Set(["readme.md", "changelog.md", "agents.md", "claude.md", "license.md", "contributing.md", "code_of_conduct.md", "security.md"]);

/**
 * The repo's hand-written Markdown (#205): at the root and under docs/ (and the docs dir), git's
 * view (ignored files left out), without Imprimatur's generated files and the standard ones; kept: true
 * includes the files docs.keep keeps (the search indexes them, #206).
 * @param {string} root @param {string} [dir] @param {{kept?: boolean}} [o] @returns {Array<{file: string, rel: string, lines: number}>}
 */
function handWrittenDocs(root, dir = path.join(root, "docs"), { kept = false } = {}) {
  let listed;
  try {
    listed = require("node:child_process").execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "--", "*.md", "*.mdx"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  const under = [path.join(root, "docs"), dir].map((d) => path.relative(root, d).split(path.sep).join("/") + "/");
  const { generatedText } = require("./docs-export.js");
  const keep = keepOf(root).map((k) => k.path);
  const isKept = (/** @type {string} */ rel) => keep.some((k) => rel === k || rel.startsWith(k.endsWith("/") ? k : `${k}/`));
  const out = [];
  for (const rel of listed.split("\n").filter(Boolean)) {
    if (STANDARD.has(path.basename(rel).toLowerCase()) || (!kept && isKept(rel))) continue;
    if (rel.includes("/") && !under.some((u) => rel.startsWith(u))) continue;
    const file = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // listed but deleted
    }
    if (generatedText(text)) continue;
    out.push({ file, rel, lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0) });
  }
  return out;
}

module.exports = { handWrittenDocs, keepOf, docDiagnostics, decisionGaps, sequenceProblems, RULES, ruleInfo, LIMIT_LINES };
