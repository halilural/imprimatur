// @ts-check
// Agent rule files that repeat or contradict each other (#213, #76): every agent rule file of a
// repo read together, rule line by rule line. A rule repeated in two or more files should live in
// one (AGENTS.md, #133); two rules in different files that share most words but differ in a
// negation or a number may contradict. Deterministic: contradictions in meaning that share no
// words are #76's LLM layer. Imprimatur's generated rules file is left out.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Single files, repo-relative. */
const FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", ".github/copilot-instructions.md", ".cursorrules", ".windsurfrules", ".clinerules"];
/** Folders whose Markdown files are rules. */
const DIRS = [".cursor/rules", ".claude/rules", "docs/agents"];
/** Imprimatur writes these itself (own-rules.js): not the repo's own rules. */
const GENERATED = new Set([".claude/rules/imprimatur.md"]);
const MIN = 25;
const SIMILAR = 0.6;
const NEGATIONS = new Set(["never", "not", "no", "dont", "don't", "avoid", "without", "nothing", "none", "cannot", "can't", "mustn't"]);

/** @param {string} root @returns {string[]} the rule files, repo-relative */
function ruleFiles(root) {
  const out = FILES.filter((f) => fs.existsSync(path.join(root, f)));
  for (const d of DIRS) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, d)).filter((n) => /\.(md|mdc)$/.test(n)).sort();
    } catch {}
    for (const n of names) if (!GENERATED.has(`${d}/${n}`)) out.push(`${d}/${n}`);
  }
  return out;
}

/** The rule lines of a file's text: no headings, fences, imports or front matter; Markdown stripped. @param {string} text */
function rulesOf(text) {
  const out = [];
  let fence = false;
  let front = false;
  // Under a heading that says not ("Don'ts", "Never", "Avoid"), every rule is a not.
  let underNot = false;
  /** @type {{indent: number, not: boolean} | undefined} */
  let label;
  String(text).split("\n").forEach((raw, i) => {
    if (i === 0 && raw.trim() === "---") return void (front = true);
    if (front) {
      if (raw.trim() === "---") front = false;
      return;
    }
    if (/^\s*(```|~~~)/.test(raw)) return void (fence = !fence);
    // A heading sets whether its rules are nots; so does a short label ("**Never**:", or "- **Never**:")
    // over the list under it, until a line as little indented as the label.
    const says = (/** @type {string} */ t) => wordsOf(t).some((w) => NEGATIONS.has(w) || /^(don'?ts?|never|avoid|forbidden)$/.test(w));
    const indent = raw.length - raw.trimStart().length;
    if (label && indent <= label.indent && raw.trim()) label = undefined;
    const bare = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__/g, "").trim();
    if (!fence && /^\s*#/.test(raw)) {
      underNot = says(raw);
      label = undefined;
    } else if (!fence && bare.length < 40 && /:$/.test(bare)) {
      label = { indent, not: says(bare) };
      return;
    }
    // Headings, imports, HTML and table rows are not rules.
    if (fence || /^\s*#/.test(raw) || /^\s*@\S+\s*$/.test(raw) || /^\s*[<|]/.test(raw)) return;
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").trim();
    if (line.length >= MIN) out.push({ n: i + 1, text: line, not: label ? label.not : underNot });
  });
  return out;
}

/** Lower-case words, apostrophes kept. @param {string} s */
const wordsOf = (s) => s.toLowerCase().match(/[a-z0-9çğıöşü']+/g) ?? [];

/**
 * @param {string} root
 * @returns {{files: string[], repeated: Array<{text: string, at: Array<{file: string, line: number}>}>, conflicts: Array<{a: {file: string, line: number, text: string}, b: {file: string, line: number, text: string}, why: string}>}}
 */
function ruleDrift(root) {
  const files = ruleFiles(root);
  const rules = files.flatMap((file) => {
    let text = "";
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {}
    return rulesOf(text).map((r) => {
      const words = wordsOf(r.text);
      return { file, line: r.n, text: r.text, key: words.join(" "), words: new Set(words), not: r.not || words.some((w) => NEGATIONS.has(w)) };
    });
  });
  /** @type {Map<string, typeof rules>} */
  const same = new Map();
  for (const r of rules) same.set(r.key, [...(same.get(r.key) ?? []), r]);
  const repeated = [...same.values()]
    .filter((list) => new Set(list.map((r) => r.file)).size > 1)
    .map((list) => ({ text: list[0].text, at: list.map((r) => ({ file: r.file, line: r.line })) }));
  const conflicts = [];
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i], b = rules[j];
      if (a.file === b.file || a.key === b.key) continue;
      const inter = [...a.words].filter((w) => b.words.has(w)).length;
      if (inter / (a.words.size + b.words.size - inter) < SIMILAR) continue;
      const nums = (/** @type {Set<string>} */ s) => [...s].filter((w) => /^\d+$/.test(w)).sort().join(",");
      const why = a.not !== b.not ? "one says not, the other does" : nums(a.words) !== nums(b.words) ? "the numbers differ" : "";
      if (why) conflicts.push({ a: { file: a.file, line: a.line, text: a.text }, b: { file: b.file, line: b.line, text: b.text }, why });
    }
  return { files, repeated, conflicts };
}

/**
 * Agent Setup's checklist rows (#213): one for the repeats, one for the possible contradictions,
 * each listing them in its tooltip and opening the first file.
 * @param {string} root @param {ReturnType<typeof ruleDrift>} d
 */
function driftRows(root, d) {
  const rows = [];
  const at = (/** @type {{file: string, line: number}} */ x) => `${x.file}:${x.line}`;
  if (d.repeated.length)
    rows.push({ type: "leaf", label: `Agent files: ${d.repeated.length} rule${d.repeated.length === 1 ? "" : "s"} repeated in several files`, description: "keep each in AGENTS.md only (#133)", icon: "copy",
      tooltip: `The same rule in more than one agent file drifts when one copy is edited. AGENTS.md is the one place for what every agent follows.\n\n${d.repeated.slice(0, 8).map((r) => `• ${r.text.slice(0, 90)} (${r.at.map(at).join(", ")})`).join("\n")}`,
      abs: path.join(root, d.repeated[0].at[0].file) });
  if (d.conflicts.length)
    rows.push({ type: "leaf", label: `Agent files: ${d.conflicts.length} rule${d.conflicts.length === 1 ? "" : "s"} may contradict`, description: "nearly the same words, a not or a number apart", icon: "warning", color: "problemsWarningIcon.foreground",
      tooltip: `Rules in different agent files that share most words but differ in a negation or a number: an agent following one breaks the other.\n\n${d.conflicts.slice(0, 8).map((c) => `• ${at(c.a)}: ${c.a.text.slice(0, 70)}\n  ${at(c.b)}: ${c.b.text.slice(0, 70)} (${c.why})`).join("\n")}`,
      abs: path.join(root, d.conflicts[0].a.file) });
  return rows;
}

module.exports = { ruleDrift, ruleFiles, rulesOf, driftRows };
