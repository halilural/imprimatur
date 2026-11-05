// @ts-check
// Decisions as MADR 4 files (#130): each adr and pdr record of a repo is also written as
// docs/decisions/NNNN-title.md, with an index (README.md). The records stay the source
// (decision 9331); the files are generated, never read back. A record gets its number once, the
// first time it is written, kept in its links (links.madr) so every device names it the same; a
// dropped record keeps its number and its file says "rejected", so a number is never reused.
// Sections link the decisions they are built on, and each decision file links them back.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DIR = "decisions";
/** The marker that starts a section's line of decision links in a generated file (docs-sync skips it). */
const LINKS_MARK = "<!-- imprimatur:decisions -->";

/** A title as a file name part: ASCII, kebab-case, at most 60 characters. @param {string} title */
function slug(title) {
  const t = String(title).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (t.slice(0, 60).replace(/-+$/, "") || "decision");
}

/**
 * A decision's title as a heading: its first sentence, at most 100 characters (records imported
 * from Markdown can carry a whole paragraph as their title; the rest moves into the outcome).
 * @param {string} title
 */
function shortTitle(title) {
  const t = String(title).replace(/\s+/g, " ").trim();
  const first = t.split(/(?<=[.!?])\s|\s[—–-]\s/)[0];
  return first.length > 100 ? `${first.slice(0, 99).replace(/\s+\S*$/, "")}…` : first;
}

/** A decision's file name. @param {{links?: any, title: string}} r */
const fileName = (r) => `${String(r.links?.madr).padStart(4, "0")}-${slug(shortTitle(r.title))}.md`;

/**
 * Numbers the decisions that have none, in the order they were made, after the highest taken
 * (dropped ones count). Returns the records with their numbers.
 * shortcut: two devices numbering new decisions before either syncs can give one number twice; renumber by hand if it happens.
 * @param {any} db @param {number} repoId @returns {any[]}
 */
function numbered(db, repoId) {
  const recs = db.decisionRecords(repoId);
  let next = Math.max(0, ...recs.map((/** @type {any} */ r) => Number(r.links?.madr) || 0)) + 1;
  for (const r of recs) {
    if (Number(r.links?.madr) > 0) continue;
    const links = { ...(r.links ?? {}), madr: next++ };
    db.updateRecord(r.id, { links }, { kind: "hook", name: "decisions" });
    r.links = links;
  }
  return recs;
}

/** A MADR status from a record's. @param {string} status */
const statusOf = (status) => (status === "dropped" ? "rejected" : "accepted");

/** The lines of a body that name options: "Option …", "Alternative …", "Rejected …", "Instead of …". @param {string} body */
const optionLines = (body) => String(body).split(/\r?\n/).filter((l) => /\b(?:alternatives?|rejected|instead of|not chosen|option [a-z0-9]|considered)\b/i.test(l));

/**
 * A decision's MADR 4 file. The record's body is the decision outcome; the context is its task;
 * options and consequences are taken from the body's lines where it names them, else said to be there.
 * @param {any} r a record with task_key, task_title and links.madr
 * @param {Array<{kind: string, key: string, title: string}>} sections the sections built on it
 * @param {string} header the generated-file header (docs-export.js)
 */
function madrText(r, sections, header) {
  const date = new Date(r.created_at).toISOString().slice(0, 10);
  const full = String(r.title).replace(/\s+/g, " ").trim();
  const short = shortTitle(full);
  // A title longer than its heading starts the outcome, so nothing of it is lost.
  const body = [short !== full ? full : "", String(r.body ?? "").replace(/\r\n/g, "\n").trim()].filter(Boolean).join("\n\n");
  const options = optionLines(body);
  const consequences = String(body).split("\n").filter((l) => /\b(consequence|trade-?off|cost|downside|means that)\b/i.test(l));
  const file = (/** @type {string} */ kind) => (kind === "architecture" ? "ARCHITECTURE.md" : "PRODUCT.md");
  const back = sections.length
    ? sections.map((s) => `- [${s.kind === "architecture" ? "Architecture" : "Product"}: ${s.title.replace(/[[\]]/g, "")}](../${file(s.kind)}#${s.key})`).join("\n")
    : "- No section links this decision yet.";
  return [
    `---\ntype: ${r.kind}\nstatus: ${statusOf(r.status)}\ndate: ${date}\nrecord: ${r.uid}\n---`,
    header,
    `# ${String(r.links.madr).padStart(4, "0")}. ${short}`,
    `## Context and Problem Statement\n\nTask ${r.task_key}: ${String(r.task_title ?? "").replace(/\s+/g, " ").trim()}.`,
    `## Considered Options\n\n${options.length ? options.join("\n") : "The options are not listed apart; the decision below says what was chosen and why."}`,
    `## Decision Outcome\n\n${body || "Not written yet."}`,
    `## Consequences\n\n${consequences.length ? consequences.join("\n") : "Not listed apart; see the decision outcome."}`,
    `## Sections\n\n${back}`,
  ].join("\n\n") + "\n";
}

/** The index of the decisions. @param {any[]} recs @param {string} header */
function indexText(recs, header) {
  const rows = recs.map((r) => `| [${String(r.links.madr).padStart(4, "0")}](${fileName(r)}) | ${shortTitle(r.title).replace(/\|/g, "\\|")} | ${r.kind.toUpperCase()} | ${statusOf(r.status)} | ${new Date(r.created_at).toISOString().slice(0, 10)} | ${r.task_key} |`);
  return [`---\ntype: reference\n---`, header, "# Decisions",
    "Architecture (ADR) and product (PDR) decisions, one file each in MADR 4 form. A number is never reused; a dropped decision stays, marked rejected.",
    `| # | Decision | Type | Status | Date | Task |\n|---|---|---|---|---|---|\n${rows.join("\n")}`].join("\n\n") + "\n";
}

/**
 * Writes a repo's decision files and their index into its docs folder (#130), each only when
 * it changed. A hand-written file of the same name is left alone; a generated one whose
 * decision was renamed is removed. Returns the files written.
 * @param {any} db @param {any} repo @param {string} docsDir the repo's docs folder
 * @param {{header: string, generatedText: (t: string) => boolean, inside: (f: string) => boolean}} io
 */
function exportDecisions(db, repo, docsDir, io) {
  const recs = numbered(db, repo.id);
  if (!recs.length) return [];
  const dir = path.join(docsDir, DIR);
  if (!io.inside(dir)) return [];
  const sections = db.sectionsOfRecords(repo.id);
  /** @type {Map<string, string>} */
  const want = new Map(recs.map((r) => [fileName(r), madrText(r, sections.get(r.id) ?? [], io.header)]));
  want.set("README.md", indexText(recs, io.header));
  const written = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of want) {
    const f = path.join(dir, name);
    let old;
    try {
      old = fs.readFileSync(f, "utf8");
    } catch {}
    if (old !== undefined && !io.generatedText(old)) continue;
    if (old === text) continue;
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
    written.push(f);
  }
  // A decision renamed: its old generated file goes (the number stays with the new name).
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-.*\.md$/.test(name) || want.has(name)) continue;
    const f = path.join(dir, name);
    try {
      if (io.generatedText(fs.readFileSync(f, "utf8"))) fs.rmSync(f);
    } catch {}
  }
  return written;
}

/**
 * The line of decision links under a section in its generated file: "Decisions: [ADR 0012 …](decisions/…)".
 * @param {any[]} contributors the section's records @returns {string} "" when it links none
 */
function linksLine(contributors) {
  // A contributor carries its number as madr (db.js docSections), a full record as links.madr.
  const n = (/** @type {any} */ r) => Number(r.madr ?? r.links?.madr) || 0;
  const ds = contributors.filter((r) => (r.kind === "adr" || r.kind === "pdr") && n(r) > 0);
  if (!ds.length) return "";
  return `${LINKS_MARK} Decisions: ${ds.map((r) => `[${r.kind.toUpperCase()} ${String(n(r)).padStart(4, "0")}](${DIR}/${fileName({ title: r.title, links: { madr: n(r) } })})`).join(", ")}`;
}

module.exports = { shortTitle, exportDecisions, madrText, indexText, linksLine, numbered, slug, fileName, LINKS_MARK, DIR };
