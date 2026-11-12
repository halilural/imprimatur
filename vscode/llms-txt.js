// @ts-check
// llms.txt at the repo's root (#216): an index of Imprimatur's documents in the llmstxt.org form,
// so agents other than Claude Code (Cursor, Codex, …) find the project page, the decisions and the
// terms. Built from the generated files present, so it follows them as they come and go; written
// by the documents export like the other generated files, never over a hand-written llms.txt.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const FILE = "llms.txt";
/** [section, a folder or a file, repo-relative]. */
const PARTS = /** @type {const} */ ([
  ["Project", "docs/PROJECT.md"],
  ["Capabilities", "docs/capabilities"],
  ["Decisions", "docs/adr"],
  ["Terms", "GLOSSARY.md"],
  ["Out of scope", ".out-of-scope"],
  ["For agents", "docs/agents"],
  ["Wiki", "docs/wiki/README.md"],
]);

/** A Markdown file's title (first heading) and first paragraph, past a leading HTML comment and front matter. @param {string} text */
function titleOf(text) {
  const body = String(text).replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\s*<!--[\s\S]*?-->\s*/, "").replace(/<a id="[^"]*"><\/a>/g, "");
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const para = body.replace(/^#.*$/gm, "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(<|\||```|- \[|\d+\. \[|status:|record:)/.test(p)) ?? "";
  const desc = para.replace(/\s+/g, " ").replace(/[*_`]/g, "");
  return { title, desc: desc.length > 160 ? `${desc.slice(0, 157).trimEnd()}…` : desc };
}

/**
 * A repo file's text, or undefined: never through a symbolic link, never outside the repo (a link
 * planted in docs/ must not copy another file's first lines into llms.txt). @param {string} root @param {string} rel
 */
function readInside(root, rel) {
  try {
    const abs = path.join(root, rel);
    if (fs.lstatSync(abs).isSymbolicLink()) return undefined;
    const real = fs.realpathSync(abs);
    const back = path.relative(fs.realpathSync(root), real);
    if (back.startsWith("..") || path.isAbsolute(back)) return undefined;
    return fs.readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
}

/** @param {string} root @param {string} rel a folder or a file @returns {string[]} the Markdown files, repo-relative; no links */
function filesAt(root, rel) {
  const abs = path.join(root, rel);
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return [];
    if (st.isFile()) return [rel];
    return fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "README.md").map((d) => `${rel}/${d.name}`).sort();
  } catch {
    return [];
  }
}

/**
 * The text of llms.txt for a repo, or undefined when it has none of the documents.
 * @param {string} root @param {string} name the project's name @param {string} header the generated-file comment
 */
function llmsText(root, name, header) {
  const sections = [];
  for (const [label, rel] of PARTS) {
    const lines = filesAt(root, rel).flatMap((f) => {
      const text = readInside(root, f);
      if (text === undefined) return [];
      const t = titleOf(text);
      return [`- [${t.title ?? path.basename(f, ".md")}](${f})${t.desc ? `: ${t.desc}` : ""}`];
    });
    if (lines.length) sections.push(`## ${label}\n\n${lines.join("\n")}`);
  }
  if (!sections.length) return undefined;
  const project = readInside(root, "docs/PROJECT.md");
  const summary = project === undefined ? "" : titleOf(project).desc;
  return `${header}\n\n# ${name}\n\n> ${summary || "The project's decisions, terms and how it behaves, kept by Imprimatur."}\n\nThese documents are kept by Imprimatur from its database; read them before changing what they describe.\n\n${sections.join("\n\n")}\n`;
}

/**
 * Writes llms.txt when it changed; a hand-written one (no generated header) is left alone.
 * @param {string} root @param {string} name @param {{header: string, generatedText: (t: string) => boolean, inside: (f: string) => boolean}} io
 * @returns {boolean} whether it was written
 */
function writeLlms(root, name, io) {
  const file = path.join(root, FILE);
  if (!io.inside(file)) return false;
  let old;
  try {
    old = fs.readFileSync(file, "utf8");
  } catch {}
  if (old !== undefined && !io.generatedText(old)) return false;
  const want = llmsText(root, name, io.header);
  if (want === undefined) {
    if (old !== undefined) fs.rmSync(file);
    return old !== undefined;
  }
  if (want === old) return false;
  fs.writeFileSync(file, want);
  return true;
}

module.exports = { llmsText, writeLlms, titleOf, FILE };
