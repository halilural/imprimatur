// @ts-check
// The documentation linters every repo gets (#132, ADR 9804): markdownlint-cli2, cspell, lychee
// (offline) and Vale (Google style, warnings; cspell warns too), one config file each, and npm scripts that run
// them. Agent Setup's checklist shows a row while any is missing; the click writes the missing
// files and adds the scripts whose names are free. Nothing is overwritten, so a repo's own
// edits to a config stay.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { safeTarget } = require("./agent-files.js");

const MARKDOWNLINT = `// Imprimatur's documentation standard (#132). Edit freely: setup never overwrites this file.
{
  "config": {
    "default": true,
    // Prose is not wrapped, and the generated documents carry <a id> anchors.
    "MD013": false,
    "MD033": false,
    // Sections repeat subheadings (Data, Flow, ...): only the same heading under one parent is a problem.
    "MD024": { "siblings_only": true },
    // Many authors write the records: _x_ and *x* both stay.
    "MD049": false,
    "MD050": false,
    // A numbered list may go on after a code block (7., 8., ...).
    "MD029": false,
    // Table pipes are written compact by the generator ("|---|").
    "MD060": false
  },
  "ignores": ["node_modules/**"]
}
`;

/** cspell's config: English (American and British) and the repo's own words. @param {string[]} words */
const cspellText = (words) => `${JSON.stringify({
  version: "0.2",
  language: "en,en-GB",
  files: ["docs/**/*.md"],
  ignorePaths: ["node_modules/**"],
  words,
}, null, 2)}\n`;

const LYCHEE = `# Imprimatur's documentation standard (#132): links between the repo's own files, no network.
offline = true
include_fragments = true
exclude_path = ["node_modules"]
`;

const VALE = `# Imprimatur's documentation standard (#132): Google's style, reported as warnings.
StylesPath = .vale/styles
MinAlertLevel = warning
Packages = Google

[docs/**/*.md]
BasedOnStyles = Vale, Google
`;

/**
 * The npm scripts, by name, the npm tools pinned (a new release adds rules). cspell only warns
 * (--no-exit-code) and runs only where the prose is English: another language's dictionary has
 * to be installed in the repo, which npx cannot do, and older records in another language would
 * fail every run.
 * @param {boolean} english
 */
const scriptsFor = (english) => ({
  "lint:docs": `npx --yes markdownlint-cli2@0.18.1 "docs/**/*.md"${english ? ' && npx --yes cspell@9.2.1 lint --no-progress --no-exit-code "docs/**/*.md"' : ""}`,
  "lint:links": "lychee --offline --no-progress docs",
  "lint:prose": "vale sync && vale docs",
});

/** The config files of a repo, by name. @param {string} root */
const configFiles = (root) => ({
  markdownlint: path.join(root, ".markdownlint-cli2.jsonc"),
  cspell: path.join(root, "cspell.json"),
  lychee: path.join(root, "lychee.toml"),
  vale: path.join(root, ".vale.ini"),
});

/** @param {string} f */
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * How a repo stands: the configs it lacks, the scripts its package.json lacks (none without a
 * package.json), and whether its prose is English.
 * @param {string} root @param {{english?: boolean}} [o]
 */
function docLint(root, { english = true } = {}) {
  const files = configFiles(root);
  const missing = Object.values(files).filter((f) => !fs.existsSync(f));
  const pkg = readJson(path.join(root, "package.json"));
  const want = scriptsFor(english);
  const scripts = pkg ? Object.keys(want).filter((k) => !(k in (pkg.scripts ?? {}))) : [];
  return { root, files, missing, scripts, pkg: !!pkg, english };
}

/**
 * Writes what is missing (#132): each config with O_EXCL (an existing file, or a link, is never
 * written through), and the free script names into package.json, its indentation kept. Returns
 * the files written.
 * @param {string} root @param {{english?: boolean, words?: string[]}} [o]
 */
function writeMissing(root, { english = true, words = [] } = {}) {
  const s = docLint(root, { english });
  const text = { [s.files.markdownlint]: MARKDOWNLINT, [s.files.cspell]: cspellText(words), [s.files.lychee]: LYCHEE, [s.files.vale]: VALE };
  /** @type {string[]} */
  const written = [];
  for (const f of s.missing) {
    if (!safeTarget(root, f)) continue;
    try {
      fs.writeFileSync(f, text[f], { flag: "wx" });
      written.push(f);
    } catch {}
  }
  const pj = path.join(root, "package.json");
  if (s.scripts.length && safeTarget(root, pj)) {
    const raw = fs.readFileSync(pj, "utf8");
    const pkg = JSON.parse(raw);
    const want = /** @type {Record<string, string>} */ (scriptsFor(english));
    pkg.scripts = { ...(pkg.scripts ?? {}) };
    for (const k of s.scripts) pkg.scripts[k] = want[k];
    const indent = /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
    fs.writeFileSync(pj, `${JSON.stringify(pkg, null, indent)}${raw.endsWith("\n") ? "\n" : ""}`);
    written.push(pj);
  }
  return written;
}

/** The checklist's row while a config or a script is missing (#132). @param {ReturnType<typeof docLint>} s */
function lintRows(s) {
  const names = [...s.missing.map((f) => path.basename(f)), ...(s.scripts.length ? [`${s.scripts.join(", ")} in package.json`] : [])];
  if (!names.length) return [];
  return [{ type: "leaf", label: `Doc lint: write ${names.join(", ")}`, description: "Imprimatur's documentation linters", icon: "checklist",
    tooltip: `The repo is missing ${names.join(", ")} (#132): markdownlint-cli2 and ${s.english ? "cspell" : "(for English prose) cspell"} through npm run lint:docs, lychee --offline through lint:links, Vale with Google's style through lint:prose. Click to write them; an existing file or script is never changed.${s.pkg ? "" : " The repo has no package.json, so only the config files are written."}`,
    command: "imprimatur.setup.writeDocLint" }];
}

module.exports = { docLint, writeMissing, lintRows, scriptsFor, MARKDOWNLINT, LYCHEE, VALE, cspellText };
