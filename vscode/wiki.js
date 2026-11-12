// @ts-check
// A DeepWiki-style wiki of a repo (#188), generated, never edited by hand: docs/wiki/<module>.md for
// each top-level code folder, and docs/wiki/README.md with the modules and how they connect.
// A page is written by the model (the user's Claude, `claude -p`) from what the repo already
// says: each file's opening comment, the ADRs whose files are in the module, the glossary terms
// those mention. A page is written again only when what it is made from changed (a hash in meta).
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DIR = path.join("docs", "wiki");
/** Folders that are not code modules. */
const SKIP = new Set(["docs", "test", "tests", "assets", "dist", "node_modules", "build", "coverage", "out", "vendor"]);
const hash = (/** @type {string} */ s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** The repo's tracked files. @param {string} root @returns {string[]} */
function tracked(root) {
  try {
    return execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** A file's opening comment, at most 400 characters (the file's own one-line summary in this codebase style). @param {string} file */
function headerOf(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8").slice(0, 4000);
  } catch {
    return "";
  }
  const lines = text.split("\n").slice(0, 30);
  const out = [];
  for (const l of lines) {
    const m = /^\s*(?:\/\/|#(?!!)|\*|\/\*\*?)\s?(.*)$/.exec(l);
    if (m) {
      if (!/^@ts-check|^eslint|^-\*-|^!/.test(m[1].trim())) out.push(m[1].trim());
    } else if (out.length || (l.trim() && !/^(?:"use strict"|import|const|#!)/.test(l.trim()))) break;
  }
  const md = /^---[\s\S]*?---\s*#\s*(.+)/.exec(text) ?? /^#\s+(.+)/m.exec(text);
  return (out.join(" ") || (md ? md[1] : "")).replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * Each module's inputs: its files with their opening comments, the ADRs about it, the terms they use.
 * @param {any} db @param {any} repo @param {string} root
 */
function modulesOf(db, repo, root) {
  const files = tracked(root).filter((f) => f.includes("/") && !f.startsWith(".") && /\.(m?js|cjs|ts|tsx|py|go|rs|java|kt|rb|sh|md|sql)$/.test(f));
  /** @type {Map<string, string[]>} */ const by = new Map();
  for (const f of files) {
    const top = f.split("/")[0];
    if (SKIP.has(top)) continue;
    by.set(top, [...(by.get(top) ?? []), f]);
  }
  const adrs = db.q(`SELECT r.* FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? AND r.kind = 'adr' AND r.status <> 'dropped' ORDER BY r.created_at`).all(repo.id);
  const glossary = db.docFind(repo.id, "glossary");
  const terms = glossary ? db.docSections(glossary.id).filter((/** @type {any} */ s) => s.status === "current") : [];
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
    const parts = list.slice(0, 80).map((f) => ({ file: f, about: headerOf(path.join(root, f)) }));
    const mine = adrs.filter((/** @type {any} */ r) => String(r.links ?? "").includes(`${name}/`)).slice(-15)
      .map((/** @type {any} */ r) => ({ n: (() => { try { return JSON.parse(r.links).madr; } catch { return undefined; } })(), title: String(r.title).slice(0, 200) }));
    const text = `${parts.map((p) => p.about).join(" ")} ${mine.map((d) => d.title).join(" ")}`.toLowerCase();
    const used = terms.filter((/** @type {any} */ t) => text.includes(String(t.title).toLowerCase())).slice(0, 15).map((/** @type {any} */ t) => t.title);
    return { name, files: list.length, parts, adrs: mine, terms: used };
  });
}

/** The prompt for one module's page. @param {string} repoName @param {any} m */
function pagePrompt(repoName, m) {
  return [
    `Write the wiki page of the "${m.name}/" module of the software repo "${repoName}", for a developer who has never seen it. Use only what is given below; do not invent.`,
    "Markdown, in this order, nothing else:",
    "1. One paragraph of at most four sentences: what the module does and why it exists.",
    "2. A Mermaid `flowchart LR` of its main parts (at most 12 nodes) and how they call or feed each other, inside a ```mermaid fence.",
    "3. `## Parts`: one bullet per important file, `path`: what it does, in one line (at most 15 bullets).",
    "4. `## Decisions`: the ADRs given, one bullet each, `ADR NNNN`: its title shortened. Leave the section out when there are none.",
    "5. `## Terms`: the glossary terms given, comma separated. Leave out when none.",
    "No other headings, no closing remarks.",
    "",
    JSON.stringify({ module: m.name, files: m.files, parts: m.parts, adrs: m.adrs, terms: m.terms }),
  ].join("\n");
}

/** The index page: the modules, one line each, and a diagram of them. @param {string} repoName @param {Array<{name: string, first: string}>} pages @param {string} header */
function indexText(repoName, pages, header) {
  return [header, `# ${repoName} wiki`,
    "Generated from the code's own comments, the ADRs and the glossary; written again when those change. Edit the sources, not these pages.",
    "```mermaid\nflowchart LR\n" + pages.map((p) => `  ${p.name.replace(/[^A-Za-z0-9_]/g, "_")}["${p.name}/"]`).join("\n") + "\n```",
    "## Modules", pages.map((p) => `- [${p.name}/](${p.name}.md): ${p.first}`).join("\n")].join("\n\n") + "\n";
}

/**
 * Writes the wiki of a repo: each module page when its inputs changed (or `force`), then the index.
 * @param {any} db @param {any} repo @param {string} root
 * @param {{header: string, generatedText: (t: string) => boolean, inside: (f: string) => boolean, ask?: (prompt: string) => Promise<string>, force?: boolean, log?: (s: string) => void}} io
 * @returns {Promise<string[]>} the pages written
 */
async function buildWiki(db, repo, root, io) {
  const ask = io.ask ?? ((/** @type {string} */ p) => require("./model.js").askModel(p, "sonnet", 180_000));
  const dir = path.join(root, DIR);
  if (!io.inside(path.join(dir, "README.md"))) return [];
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const pages = [];
  for (const m of modulesOf(db, repo, root)) {
    const f = path.join(dir, `${m.name}.md`);
    let old;
    try {
      old = fs.readFileSync(f, "utf8");
    } catch {}
    if (old !== undefined && !io.generatedText(old)) {
      pages.push({ name: m.name, first: "written by hand" });
      continue;
    }
    const sig = hash(JSON.stringify(m));
    const key = `wiki:${repo.id}:${m.name}`;
    if (!io.force && old !== undefined && db.meta(key) === sig) {
      pages.push({ name: m.name, first: firstLine(old) });
      continue;
    }
    io.log?.(`${m.name}/ …`);
    let body;
    try {
      body = String(await ask(pagePrompt(repo.name ?? path.basename(root), m))).trim().replace(/^```(?:markdown)?\n([\s\S]*)\n```$/, "$1")
        // The page has its title already: a heading the model put first goes.
        .replace(/^#\s+[^\n]*\n+/, "");
    } catch (e) {
      io.log?.(`${m.name}/: the model did not answer (${/** @type {Error} */ (e).message})`);
      if (old !== undefined) pages.push({ name: m.name, first: firstLine(old) });
      continue;
    }
    // The model's page made lint-clean (#132's tidy), its headings from h2 under the page's "#".
    const text = require("./md-tidy.js").tidy([io.header, `# ${m.name}/`, require("./md-tidy.js").nest(body, 2)].join("\n\n")) + "\n";
    if (!io.inside(f)) continue;
    fs.writeFileSync(f, text);
    db.setMeta(key, sig);
    written.push(f);
    pages.push({ name: m.name, first: firstLine(text) });
  }
  const index = path.join(dir, "README.md");
  const want = (indexText(repo.name ?? path.basename(root), pages, io.header));
  let cur;
  try {
    cur = fs.readFileSync(index, "utf8");
  } catch {}
  if (cur !== want && (cur === undefined || io.generatedText(cur))) {
    fs.writeFileSync(index, want);
    written.push(index);
  }
  return written;
}

/** A page's first paragraph as one line of at most 160 characters. @param {string} text */
function firstLine(text) {
  const para = String(text).split(/\n\s*\n/).find((p) => p.trim() && !/^(<!--|#|---|```)/.test(p.trim())) ?? "";
  return para.replace(/\s+/g, " ").trim().slice(0, 160).trimEnd();
}

module.exports = { buildWiki, modulesOf, pagePrompt, indexText, headerOf, firstLine, DIR };
